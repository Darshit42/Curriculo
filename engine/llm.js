import fs from 'node:fs';
import path from 'node:path';
import { estTokens, readJSON, sha, writeJSON } from './util.js';

export class BudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BudgetError';
  }
}

/**
 * Read BharatCode settings from the environment. The API key is only ever
 * held in memory; it is never written to the manifest, cache or LEARN.md.
 */
export function configFromEnv(env = process.env) {
  return {
    apiKey: env.BHARATCODE_API_KEY || '',
    baseUrl: (env.BHARATCODE_BASE_URL || '').replace(/\/+$/, ''),
    model: env.BHARATCODE_MODEL || '',
  };
}

export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('BHARATCODE_API_KEY');
  if (!cfg.baseUrl) missing.push('BHARATCODE_BASE_URL');
  if (!cfg.model) missing.push('BHARATCODE_MODEL');
  return missing;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal client for the BharatCode chat-completions API (OpenAI-compatible
 * request/response shape), with content-hash caching and a hard token budget.
 */
export class BharatCodeClient {
  constructor({ apiKey, baseUrl, model, cacheDir, budget = 250_000, useCache = true, timeoutMs = 120_000, fetchImpl } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.cacheDir = cacheDir;
    this.budget = budget;
    this.useCache = useCache && !!cacheDir;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
    this.usage = { prompt: 0, completion: 0, calls: 0, cached: 0 };
  }

  get spent() {
    return this.usage.prompt + this.usage.completion;
  }

  get remaining() {
    return Math.max(0, this.budget - this.spent);
  }

  cacheFile(key) {
    return path.join(this.cacheDir, 'responses', key.slice(0, 2), `${key}.json`);
  }

  /** Send one chat completion; returns the assistant text. */
  async complete({ system, user, maxTokens = 1500, temperature = 0.2 }) {
    const key = sha(JSON.stringify([this.model, system, user, maxTokens, temperature]));
    if (this.useCache) {
      const hit = readJSON(this.cacheFile(key));
      if (hit && typeof hit.text === 'string') {
        this.usage.cached++;
        return hit.text;
      }
    }
    const projected = estTokens(system) + estTokens(user) + maxTokens;
    if (projected > this.remaining) {
      throw new BudgetError(`token budget exhausted (${this.spent}/${this.budget} used, call needs ~${projected})`);
    }

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    };
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1500 * 2 ** (attempt - 1));
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = new Error(`BharatCode request failed: ${err.message}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`BharatCode API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`BharatCode API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = await res.json();
      const text = extractText(data);
      if (typeof text !== 'string') throw new Error('BharatCode API returned no message content');
      const u = data.usage || {};
      this.usage.prompt += u.prompt_tokens ?? u.input_tokens ?? estTokens(system) + estTokens(user);
      this.usage.completion += u.completion_tokens ?? u.output_tokens ?? estTokens(text);
      this.usage.calls++;
      if (this.useCache) writeJSON(this.cacheFile(key), { model: this.model, text });
      return text;
    }
    throw lastErr;
  }
}

function extractText(data) {
  const choice = data?.choices?.[0];
  if (choice) {
    const c = choice.message?.content ?? choice.text;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => p.text || '').join('');
  }
  if (Array.isArray(data?.content)) return data.content.map((p) => p.text || '').join('');
  if (typeof data?.output_text === 'string') return data.output_text;
  return null;
}

export function clearCache(cacheDir) {
  fs.rmSync(path.join(cacheDir, 'responses'), { recursive: true, force: true });
}
