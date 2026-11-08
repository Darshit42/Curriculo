/**
 * Model providers. BharatCode is the default; any of these can be selected with
 * --provider, CURRICULO_PROVIDER, or `curriculo use <provider>`.
 *
 * Keys are resolved from (1) the provider's environment variable, then
 * (2) ~/.curriculo/config.json written by `curriculo login`. Keys never enter
 * the repo, the course manifest, the response cache or LEARN.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * format: 'openai' (POST {base}/chat/completions) or 'anthropic' (POST {base}/messages).
 * effortParam: how a reasoning-effort level is sent, if the provider supports one.
 */
export const PROVIDERS = {
  bharatcode: {
    label: 'BharatCode',
    format: 'openai',
    baseUrl: 'https://bharatcode.ai/api/model/v1',
    keyEnv: 'BHARATCODE_API_KEY',
    modelEnv: 'BHARATCODE_MODEL',
    baseUrlEnv: 'BHARATCODE_BASE_URL',
    model: 'qwen-3.8-27b',
    effortParam: 'reasoning_effort',
    effort: 'low',
    keyUrl: 'https://bharatcode.ai/account',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    model: 'claude-opus-5-5',
    effortParam: 'output_config.effort',
    effort: 'medium',
    // Thinking counts toward max_tokens; give each call generous headroom (non-streaming).
    minOutputTokens: 16000,
    noTemperature: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    baseUrlEnv: 'OPENAI_BASE_URL',
    model: 'gpt-5-mini',
    effortParam: 'reasoning_effort',
    effort: 'low',
    maxTokensField: 'max_completion_tokens',
    noTemperature: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    label: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    model: 'gemini-2.5-flash',
    effortParam: 'reasoning_effort',
    effort: 'low',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    model: 'openrouter/auto',
    keyUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    label: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  ollama: {
    label: 'Ollama (local)',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    modelEnv: 'OLLAMA_MODEL',
    model: 'llama3.1',
    keyOptional: true,
  },
  custom: {
    label: 'Any OpenAI-compatible endpoint',
    format: 'openai',
    baseUrl: '',
    keyEnv: 'CURRICULO_API_KEY',
    baseUrlEnv: 'CURRICULO_BASE_URL',
    model: '',
    keyOptional: true,
  },
};

/** Order used to auto-detect a provider when none is chosen explicitly. */
const DETECT_ORDER = ['bharatcode', 'anthropic', 'openai', 'gemini', 'openrouter', 'groq'];

export function curriculoHome(env = process.env) {
  return env.CURRICULO_HOME || path.join(os.homedir(), '.curriculo');
}

export function configPath(env = process.env) {
  return path.join(curriculoHome(env), 'config.json');
}

export function loadConfig(env = process.env) {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
    return { keys: {}, models: {}, ...c };
  } catch {
    return { keys: {}, models: {} };
  }
}

/** Persist the user config with owner-only permissions (best effort on Windows). */
export function saveConfig(config, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
  return file;
}

export function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? '••••' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function providerNames() {
  return Object.keys(PROVIDERS);
}

function keyFor(name, env, config) {
  const p = PROVIDERS[name];
  return (p.keyEnv && env[p.keyEnv]) || config.keys?.[name] || '';
}

/**
 * Decide which provider, model, key and endpoint to use.
 * Precedence: explicit option > CURRICULO_* env > saved config > auto-detect.
 * Returns { provider, label, format, baseUrl, model, apiKey, effort, ...spec, source }
 * or throws an Error with code NO_CONFIG explaining how to set one up.
 */
export function resolveProvider({ provider, model, env = process.env, config = loadConfig(env) } = {}) {
  let name = provider || env.CURRICULO_PROVIDER || config.provider || '';
  let source = provider ? 'flag' : env.CURRICULO_PROVIDER ? 'env' : config.provider ? 'config' : '';
  if (name && !PROVIDERS[name]) {
    const e = new Error(`Unknown provider "${name}". Choose one of: ${providerNames().join(', ')}.`);
    e.code = 'BAD_PROVIDER';
    throw e;
  }
  if (!name) {
    name = DETECT_ORDER.find((n) => env[PROVIDERS[n].keyEnv]) || DETECT_ORDER.find((n) => config.keys?.[n]) || '';
    source = 'detected';
  }
  if (!name) {
    const e = new Error(
      'No model provider configured. Either:\n' +
        '  • save a key once:      curriculo login bharatcode   (or anthropic, openai, gemini, openrouter, groq)\n' +
        '  • or set an env var:    BHARATCODE_API_KEY=bc_live_...   (get one at https://bharatcode.ai/account)\n' +
        '  • or run without a model: --offline',
    );
    e.code = 'NO_CONFIG';
    throw e;
  }

  const spec = PROVIDERS[name];
  const apiKey = keyFor(name, env, config);
  if (!apiKey && !spec.keyOptional) {
    const e = new Error(
      `No API key for ${spec.label}. Run \`curriculo login ${name}\` or set ${spec.keyEnv}` +
        (spec.keyUrl ? ` (get one at ${spec.keyUrl})` : '') +
        '. Or pass --offline for a heuristic course with no model calls.',
    );
    e.code = 'NO_CONFIG';
    throw e;
  }
  const resolvedModel =
    model || env.CURRICULO_MODEL || (spec.modelEnv && env[spec.modelEnv]) || config.models?.[name] || spec.model;
  const baseUrl = ((spec.baseUrlEnv && env[spec.baseUrlEnv]) || spec.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    const e = new Error(`Provider "${name}" needs a base URL: set ${spec.baseUrlEnv}.`);
    e.code = 'NO_CONFIG';
    throw e;
  }
  if (!resolvedModel) {
    const e = new Error(`Provider "${name}" needs a model: pass --model or set CURRICULO_MODEL.`);
    e.code = 'NO_CONFIG';
    throw e;
  }
  const effortEnv = env.CURRICULO_REASONING_EFFORT ?? (name === 'bharatcode' ? env.BHARATCODE_REASONING_EFFORT : undefined);
  const effort = effortEnv === undefined ? spec.effort : effortEnv === 'none' && name !== 'bharatcode' ? '' : effortEnv;

  return { ...spec, provider: name, baseUrl, model: resolvedModel, apiKey, effort, source };
}
