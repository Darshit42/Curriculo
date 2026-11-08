import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS, resolveProvider } from './providers.js';
import { estTokens, readJSON, sha, writeJSON } from './util.js';

export class BudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BudgetError';
  }
}

/** Auth, plan or model-access errors: retrying or degrading cannot fix these, so stop the run. */
export class FatalApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'FatalApiError';
    this.status = status;
  }
}

function apiErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.message || text;
  } catch {
    return text;
  }
}

export class RefusalError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RefusalError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the HTTP request for one call in the provider's wire format. */
export function buildRequest(p, { system, user, maxTokens, temperature }) {
  if (p.format === 'anthropic') {
    return {
      url: `${p.baseUrl}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': p.apiKey,
        'anthropic-version': '2026-10-21',
      },
      body: {
        model: p.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        ...(p.effort ? { output_config: { effort: p.effort } } : {}),
      },
    };
  }
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    [p.maxTokensField || 'max_tokens']: maxTokens,
    ...(p.noTemperature ? {} : { temperature }),
    ...(p.effort && p.effortParam === 'reasoning_effort' ? { reasoning_effort: p.effort } : {}),
  };
  return {
    url: `${p.baseUrl}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
      ...(p.provider === 'openrouter' ? { 'x-title': 'Curriculo' } : {}),
    },
    body,
  };
}

/** Normalize a response: { text, truncated, refused, usage: { prompt, completion } }. */
export function parseResponse(p, data) {
  if (p.format === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      truncated: data?.stop_reason === 'max_tokens',
      refused: data?.stop_reason === 'refusal',
      usage: { prompt: data?.usage?.input_tokens, completion: data?.usage?.output_tokens },
    };
  }
  const choice = data?.choices?.[0];
  let text = choice?.message?.content ?? choice?.text ?? null;
  if (Array.isArray(text)) text = text.map((part) => part.text || '').join('');
  return {
    text,
    truncated: choice?.finish_reason === 'length',
    refused: choice?.finish_reason === 'content_filter',
    usage: { prompt: data?.usage?.prompt_tokens, completion: data?.usage?.completion_tokens },
  };
}

/**
 * One client for every provider: content-hash response cache, hard token
 * budget, retries on 429/5xx, and a single "grow and retry" when reasoning
 * exhausts the output budget before the answer is written.
 */
export class ModelClient {
  constructor({ provider, cacheDir, budget = 250_000, useCache = true, timeoutMs = 240_000, fetchImpl } = {}) {
    this.p = provider;
    this.model = provider.model;
    this.cacheDir = cacheDir;
    this.budget = budget;
    this.useCache = useCache && !!cacheDir;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
    this.usage = { prompt: 0, completion: 0, calls: 0, cached: 0 };
  }

  get label() {
    return `${this.p.provider}/${this.p.model}`;
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

  /** Send one prompt; returns the assistant text. */
  async complete({ system, user, maxTokens = 1500, temperature = 0.2 }) {
    const key = sha(JSON.stringify([this.p.provider, this.p.model, this.p.effort || '', system, user, maxTokens]));
    if (this.useCache) {
      const hit = readJSON(this.cacheFile(key));
      if (hit && typeof hit.text === 'string') {
        this.usage.cached++;
        return hit.text;
      }
    }
    // Budget on the nominal output size; providers that think get extra headroom below.
    const projected = estTokens(system) + estTokens(user) + maxTokens;
    if (projected > this.remaining) {
      throw new BudgetError(`token budget exhausted (${this.spent}/${this.budget} used, call needs ~${projected})`);
    }

    let outTokens = Math.max(maxTokens, this.p.minOutputTokens || 0);
    const name = PROVIDERS[this.p.provider]?.label || this.p.provider;
    let lastErr;
    let grew = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const req = buildRequest(this.p, { system, user, maxTokens: outTokens, temperature });
      let res;
      try {
        res = await this.fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = new Error(`${name} request failed: ${err.message}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = new Error(`${name} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const detail = apiErrorMessage(await res.text()).slice(0, 400);
        if ([401, 403, 404].includes(res.status)) {
          const hint = res.status === 401 ? ' Check the key (curriculo login ' + this.p.provider + ').' : res.status === 404 ? ' Check the model id (--model).' : '';
          throw new FatalApiError(`${name} API ${res.status}: ${detail}${hint}`, res.status);
        }
        throw new Error(`${name} API ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const out = parseResponse(this.p, data);
      this.usage.prompt += out.usage.prompt ?? estTokens(system) + estTokens(user);
      this.usage.completion += out.usage.completion ?? estTokens(out.text || '');
      this.usage.calls++;
      if (out.refused) throw new RefusalError(`${name} declined this request`);
      if (out.truncated && !grew && outTokens * 2 <= Math.min(this.remaining, 32000)) {
        outTokens *= 2;
        grew = true;
        lastErr = new Error(`${name} output hit the token limit`);
        continue;
      }
      if (typeof out.text !== 'string' || !out.text.trim()) throw new Error(`${name} returned no message content`);
      if (this.useCache) writeJSON(this.cacheFile(key), { model: this.label, text: out.text });
      return out.text;
    }
    throw lastErr;
  }
}

/** Back-compat: the BharatCode client is now a ModelClient on the bharatcode provider. */
export class BharatCodeClient extends ModelClient {
  constructor({ apiKey, baseUrl, model, reasoningEffort, ...rest } = {}) {
    const provider = resolveProvider({
      provider: 'bharatcode',
      model,
      env: { BHARATCODE_API_KEY: apiKey || 'unset', ...(baseUrl ? { BHARATCODE_BASE_URL: baseUrl } : {}), ...(reasoningEffort !== undefined ? { BHARATCODE_REASONING_EFFORT: reasoningEffort } : {}) },
      config: { keys: {}, models: {} },
    });
    super({ provider, ...rest });
  }
}

export function clearCache(cacheDir) {
  fs.rmSync(path.join(cacheDir, 'responses'), { recursive: true, force: true });
}
