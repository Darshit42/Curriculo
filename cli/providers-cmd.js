/**
 * Provider and key management: login, logout, use, providers.
 * Keys are stored in ~/.curriculo/config.json (owner-only), never in a repo.
 */
import { PROVIDERS, configPath, loadConfig, maskKey, providerNames, resolveProvider, saveConfig } from '../engine/providers.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function requireProvider(name, fail) {
  if (!name) fail(`Name a provider: ${providerNames().join(', ')}`);
  if (!PROVIDERS[name]) fail(`Unknown provider "${name}". Choose one of: ${providerNames().join(', ')}`);
  return PROVIDERS[name];
}

/** Read a key without echoing it: from the argument, a pipe, or a hidden prompt. */
async function readKey(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let key = '';
    const inp = process.stdin;
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding('utf8');
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          inp.setRawMode(false);
          inp.pause();
          inp.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(key.trim());
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') key = key.slice(0, -1);
        else key += ch;
      }
    };
    inp.on('data', onData);
  });
}

/** Cheap credential check against the provider's model list. Returns true/false/null (unknown). */
async function verifyKey(name, key) {
  const p = PROVIDERS[name];
  if (!p.baseUrl) return null;
  const headers =
    p.format === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2026-10-21' }
      : { authorization: `Bearer ${key}` };
  try {
    // BharatCode's model list is public, so only a real (1-token) call proves the key.
    const res = p.verifyWithChat
      ? await fetch(`${p.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, reasoning_effort: 'none' }),
          signal: AbortSignal.timeout(60_000),
        })
      : await fetch(`${p.baseUrl}/models`, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

export async function cmdLogin(args, opts, fail) {
  const name = args[0];
  const spec = requireProvider(name, fail);
  if (spec.keyOptional && !args[1]) {
    process.stdout.write(`${spec.label} does not need a key. Select it with ${cyan(`curriculo use ${name}`)}.\n`);
    return;
  }
  const key = args[1] || (await readKey(`Paste your ${spec.label} API key${spec.keyUrl ? ` (${spec.keyUrl})` : ''}: `));
  if (!key) fail('No key entered.');
  if (!opts['no-verify']) {
    const ok = await verifyKey(name, key);
    if (ok === false) fail(`${spec.label} rejected that key (401/403). Nothing was saved.`);
    if (ok === null) process.stdout.write(`${yellow('!')} Could not verify the key right now; saving it anyway.\n`);
  }
  const config = loadConfig();
  config.keys[name] = key;
  if (!config.provider || opts.default) config.provider = name;
  const file = saveConfig(config);
  process.stdout.write(`${green('✔')} Saved ${spec.label} key ${dim(maskKey(key))} to ${file}\n`);
  if (config.provider === name) process.stdout.write(`  ${spec.label} is your default provider.\n`);
  else process.stdout.write(`  Make it the default with ${cyan(`curriculo use ${name}`)}.\n`);
}

export function cmdLogout(args, opts, fail) {
  const name = args[0];
  const spec = requireProvider(name, fail);
  const config = loadConfig();
  if (!config.keys[name]) return void process.stdout.write(`No saved key for ${spec.label}.\n`);
  delete config.keys[name];
  if (config.provider === name) delete config.provider;
  saveConfig(config);
  process.stdout.write(`${green('✔')} Removed the saved ${spec.label} key.\n`);
}

export function cmdUse(args, opts, fail) {
  const name = args[0];
  const spec = requireProvider(name, fail);
  const config = loadConfig();
  config.provider = name;
  if (opts.model) config.models[name] = opts.model;
  saveConfig(config);
  const model = config.models[name] || spec.model;
  process.stdout.write(`${green('✔')} Default provider: ${bold(spec.label)}${model ? ` · model ${model}` : ''}\n`);
  if (!spec.keyOptional && !config.keys[name] && !process.env[spec.keyEnv]) {
    process.stdout.write(`  No key yet — run ${cyan(`curriculo login ${name}`)} or set ${spec.keyEnv}.\n`);
  }
}

export function cmdProviders() {
  const config = loadConfig();
  let active = null;
  try {
    active = resolveProvider({ config });
  } catch {
    /* nothing configured */
  }
  const out = [`${bold('Providers')}  ${dim(`(config: ${configPath()})`)}`, ''];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const envKey = p.keyEnv && process.env[p.keyEnv];
    const saved = config.keys[name];
    const key = envKey ? `env ${p.keyEnv}` : saved ? `saved ${maskKey(saved)}` : p.keyOptional ? 'no key needed' : dim('no key');
    const model = config.models[name] || p.model || dim('(set --model)');
    const mark = active?.provider === name ? green('●') : ' ';
    out.push(` ${mark} ${name.padEnd(11)} ${p.label.padEnd(30)} ${String(model).padEnd(26)} ${key}`);
  }
  out.push('');
  out.push(
    active
      ? `Active: ${bold(active.label)} · ${active.model} ${dim(`(${active.source})`)}`
      : `Nothing active. Run ${cyan('curriculo login bharatcode')} (or another provider), or use --offline.`,
  );
  out.push(dim('Switch with: curriculo use <provider> [--model <id>]  ·  one run: gen --provider <name> --model <id>'));
  process.stdout.write(out.join('\n') + '\n');
}
