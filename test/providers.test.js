import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildRequest, ModelClient, parseResponse } from '../engine/llm.js';
import { loadConfig, maskKey, resolveProvider, saveConfig } from '../engine/providers.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curriculo-home-'));
const empty = { keys: {}, models: {} };

test('resolution precedence: flag > CURRICULO_PROVIDER > config > env-key detection', () => {
  const env = { BHARATCODE_API_KEY: 'bc', OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ak' };
  assert.equal(resolveProvider({ env, config: empty }).provider, 'bharatcode', 'detects first key in order');
  assert.equal(resolveProvider({ env: { OPENAI_API_KEY: 'sk' }, config: empty }).provider, 'openai');
  assert.equal(resolveProvider({ env, config: { ...empty, provider: 'anthropic' } }).provider, 'anthropic');
  assert.equal(resolveProvider({ env: { ...env, CURRICULO_PROVIDER: 'openai' }, config: { ...empty, provider: 'anthropic' } }).provider, 'openai');
  assert.equal(resolveProvider({ provider: 'bharatcode', env: { ...env, CURRICULO_PROVIDER: 'openai' }, config: empty }).provider, 'bharatcode');
});

test('keys: env var wins over a saved key; saved key is used when env is empty', () => {
  const config = { keys: { bharatcode: 'saved-key' }, models: {} };
  assert.equal(resolveProvider({ env: {}, config }).apiKey, 'saved-key');
  assert.equal(resolveProvider({ env: { BHARATCODE_API_KEY: 'env-key' }, config }).apiKey, 'env-key');
});

test('models: flag > CURRICULO_MODEL > provider env > saved > default', () => {
  const env = { BHARATCODE_API_KEY: 'k' };
  const config = { keys: {}, models: { bharatcode: 'saved-model' } };
  assert.equal(resolveProvider({ env, config: empty }).model, 'qwen-3.8-27b');
  assert.equal(resolveProvider({ env, config }).model, 'saved-model');
  assert.equal(resolveProvider({ env: { ...env, BHARATCODE_MODEL: 'env-model' }, config }).model, 'env-model');
  assert.equal(resolveProvider({ env: { ...env, CURRICULO_MODEL: 'cur-model', BHARATCODE_MODEL: 'x' }, config }).model, 'cur-model');
  assert.equal(resolveProvider({ model: 'flag-model', env: { ...env, CURRICULO_MODEL: 'x' }, config }).model, 'flag-model');
});

test('helpful errors: nothing configured, missing key, unknown provider, custom without endpoint', () => {
  assert.throws(() => resolveProvider({ env: {}, config: empty }), (e) => e.code === 'NO_CONFIG' && /login bharatcode/.test(e.message) && /--offline/.test(e.message));
  assert.throws(() => resolveProvider({ provider: 'anthropic', env: {}, config: empty }), /ANTHROPIC_API_KEY/);
  assert.throws(() => resolveProvider({ provider: 'nope', env: {}, config: empty }), (e) => e.code === 'BAD_PROVIDER');
  assert.throws(() => resolveProvider({ provider: 'custom', env: {}, config: empty }), /CURRICULO_BASE_URL/);
  const custom = resolveProvider({ provider: 'custom', model: 'm', env: { CURRICULO_BASE_URL: 'http://x/v1/' }, config: empty });
  assert.equal(custom.baseUrl, 'http://x/v1');
  assert.equal(resolveProvider({ provider: 'ollama', env: {}, config: empty }).apiKey, '');
});

test('OpenAI-format requests: BharatCode sends reasoning_effort; OpenAI uses max_completion_tokens and no temperature', () => {
  const bc = buildRequest(resolveProvider({ provider: 'bharatcode', env: { BHARATCODE_API_KEY: 'k' }, config: empty }), { system: 's', user: 'u', maxTokens: 100, temperature: 0.2 });
  assert.equal(bc.url, 'https://bharatcode.ai/api/model/v1/chat/completions');
  assert.equal(bc.headers.authorization, 'Bearer k');
  assert.equal(bc.body.max_tokens, 100);
  assert.equal(bc.body.reasoning_effort, 'low');
  assert.equal(bc.body.temperature, 0.2);
  const oa = buildRequest(resolveProvider({ provider: 'openai', env: { OPENAI_API_KEY: 'k' }, config: empty }), { system: 's', user: 'u', maxTokens: 100, temperature: 0.2 });
  assert.equal(oa.body.max_completion_tokens, 100);
  assert.ok(!('max_tokens' in oa.body) && !('temperature' in oa.body));
  const ol = buildRequest(resolveProvider({ provider: 'ollama', env: {}, config: empty }), { system: 's', user: 'u', maxTokens: 10 });
  assert.ok(!('authorization' in ol.headers), 'no auth header without a key');
});

test('Anthropic requests use the Messages API shape with no sampling params', () => {
  const p = resolveProvider({ provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'ak' }, config: empty });
  const req = buildRequest(p, { system: 'sys', user: 'hello', maxTokens: 16000, temperature: 0.2 });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'ak');
  assert.equal(req.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.system, 'sys');
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(req.body.output_config, { effort: 'medium' });
  assert.ok(!('temperature' in req.body));
  const parsed = parseResponse(p, {
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  assert.deepEqual(parsed, { text: 'Hi there', truncated: false, refused: false, usage: { prompt: 12, completion: 34 } });
  assert.ok(parseResponse(p, { content: [], stop_reason: 'max_tokens' }).truncated);
  assert.ok(parseResponse(p, { content: [], stop_reason: 'refusal' }).refused);
});

test('ModelClient: Anthropic end to end through a mock, with truncation recovery', async () => {
  const p = resolveProvider({ provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'ak' }, config: empty });
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.max_tokens);
    const truncated = sent.length === 1;
    return new Response(JSON.stringify({
      content: truncated ? [] : [{ type: 'text', text: 'answer' }],
      stop_reason: truncated ? 'max_tokens' : 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  };
  const client = new ModelClient({ provider: p, fetchImpl, useCache: false });
  assert.equal(await client.complete({ system: 's', user: 'u', maxTokens: 1000 }), 'answer');
  assert.deepEqual(sent, [16000, 32000], 'min output headroom, then doubled once on max_tokens');
  assert.equal(client.usage.calls, 2);
});

test('config file: saved with owner-only permissions; keys are masked for display', () => {
  const env = { CURRICULO_HOME: tmpHome() };
  const file = saveConfig({ provider: 'bharatcode', keys: { bharatcode: 'bc_live_abcdefghijklmnop' }, models: {} }, env);
  assert.equal(loadConfig(env).keys.bharatcode, 'bc_live_abcdefghijklmnop');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(maskKey('bc_live_abcdefghijklmnop'), 'bc_live_…mnop');
  assert.ok(!maskKey('bc_live_abcdefghijklmnop').includes('efghijkl'));
});
