import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** SHA-256 hex digest of a string or buffer. */
export function sha(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Rough token estimate (~4 chars per token) used for budgeting before a call. */
export function estTokens(text) {
  return Math.ceil((text ? text.length : 0) / 4);
}

/** Run `fn` over `items` with at most `n` in flight; preserves order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const count = Math.max(1, Math.min(n, items.length));
  await Promise.all(Array.from({ length: count }, worker));
  return out;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function slugify(s, max = 40) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Deterministic pseudo-random generator seeded from a string (mulberry32). */
export function seededRandom(seed) {
  let a = parseInt(sha(String(seed)).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic shuffle; returns a new array. */
export function shuffle(arr, seed) {
  const rand = seededRandom(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Extract the first JSON object from model text (handles ``` fences and chatter). */
export function parseJSONLoose(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const t = Math.round(s);
  return `${Math.floor(t / 60)}m ${t % 60}s`;
}

export function fileExt(p) {
  const base = p.split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function fileStem(p) {
  const base = p.split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}
