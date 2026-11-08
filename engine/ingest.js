import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileExt, toPosix } from './util.js';

/** Directories never worth teaching from, even when committed. */
export const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.idea', '.vscode', '.curriculo', 'bower_components',
  'Pods', '.gradle', '.terraform', '.cache', '.parcel-cache', '.turbo', 'site-packages',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svg', 'pdf', 'zip', 'gz', 'tgz',
  'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'class', 'so', 'dylib', 'dll', 'exe', 'bin',
  'o', 'a', 'lib', 'obj', 'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov',
  'avi', 'wav', 'ogg', 'webm', 'flac', 'psd', 'ai', 'sketch', 'fig', 'db', 'sqlite',
  'sqlite3', 'pyc', 'pyo', 'lockb', 'npy', 'npz', 'pkl', 'pt', 'onnx', 'h5', 'parquet',
]);

const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock',
  'Gemfile.lock', 'composer.lock', 'go.sum', 'Pipfile.lock', 'uv.lock', 'flake.lock',
  'mix.lock', 'pubspec.lock', 'Podfile.lock', 'packages.lock.json',
]);

/** Files that must never be read or sent to a model. */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|ppk|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|htpasswd|pgpass|git-credentials|dockercfg)$/i,
  /(^|\/)\.(aws|ssh|gnupg|docker)\//i,
  /credential/i,
  /secret/i,
  /service[-_]?account[^/]*\.json$/i,
  /(^|\/)tokens?\.(json|txt|ya?ml)$/i,
  /(^|\/)terraform\.tfstate(\.backup)?$/i,
];

const KEY_DOC_RE = /^(readme|contributing|architecture|design|hacking|overview)(\.[a-z]+)?$/i;

export const MAX_FILE_BYTES = 300 * 1024;
export const MAX_FILES = 6000;

export function isSecretPath(p) {
  return SECRET_PATTERNS.some((re) => re.test(p));
}

/** Should this repo-relative posix path be skipped before reading? */
export function shouldSkip(p) {
  const parts = p.split('/');
  if (parts.slice(0, -1).some((d) => IGNORE_DIRS.has(d))) return true;
  const base = parts[parts.length - 1];
  if (LOCK_FILES.has(base)) return true;
  if (BINARY_EXT.has(fileExt(p))) return true;
  if (/\.min\.(js|css)$|\.map$|\.snap$/i.test(base)) return true;
  if (isSecretPath(p)) return true;
  return false;
}

/** Is this a remote repo reference (URL, git@, or `owner/name` shorthand)? */
export function isRemote(src) {
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(src)) return true;
  if (/^(github|gitlab|bitbucket)\.(com|org)\//i.test(src)) return true;
  if (/^[\w.-]+\/[\w.-]+$/.test(src) && !fs.existsSync(src)) return true;
  return false;
}

/** Normalize a remote reference into a clone URL and a display id (host/org/name). */
export function normalizeRemote(src) {
  let s = src.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  let m = s.match(/^git@([^:]+):(.+)$/);
  if (m) return { url: `https://${m[1]}/${m[2]}.git`, id: `${m[1]}/${m[2]}` };
  m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (m) return { url: `https://${m[1]}/${m[2]}.git`, id: `${m[1]}/${m[2]}` };
  if (/^(github|gitlab|bitbucket)\.(com|org)\//i.test(s)) {
    return { url: `https://${s}.git`, id: s };
  }
  return { url: `https://github.com/${s}.git`, id: `github.com/${s}` };
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function reposHome() {
  return process.env.CURRICULO_HOME
    ? path.join(process.env.CURRICULO_HOME, 'repos')
    : path.join(os.homedir(), '.curriculo', 'repos');
}

/**
 * Resolve a source into a local directory. Remote repos are shallow-cloned into
 * ~/.curriculo/repos/<host>/<org>/<name>, or `dest` when given.
 */
export function resolveSource(src, { dest, log = () => {} } = {}) {
  if (!isRemote(src)) {
    const root = path.resolve(src || '.');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Not a directory: ${root}`);
    }
    return { root, repoId: localRepoId(root), remote: false };
  }
  const { url, id } = normalizeRemote(src);
  const root = dest ? path.resolve(dest) : path.join(reposHome(), ...id.split('/'));
  if (fs.existsSync(path.join(root, '.git'))) {
    log(`Updating existing clone in ${root}`);
    try {
      git(['-C', root, 'pull', '--ff-only', '--depth', '1']);
    } catch {
      log('Pull failed; using the existing clone as-is.');
    }
  } else {
    log(`Cloning ${url}`);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    try {
      git(['clone', '--depth', '1', '--quiet', url, root]);
    } catch (err) {
      const msg = String(err.stderr || err.message).trim().split('\n').pop();
      throw new Error(`git clone failed for ${url}: ${msg}`);
    }
  }
  return { root, repoId: id, remote: true };
}

function localRepoId(root) {
  try {
    const url = git(['-C', root, 'remote', 'get-url', 'origin']).trim();
    if (url) return normalizeRemote(url).id;
  } catch {
    /* not a git repo or no origin */
  }
  return path.basename(root);
}

function gitListFiles(root) {
  try {
    const inside = git(['-C', root, 'rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') return null;
    const out = git(['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES * 4) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Read the repo into memory: a filtered list of text files with content.
 * Honors .gitignore (via `git ls-files`) and never reads secret-looking files.
 */
export function ingest(root, { maxFileBytes = MAX_FILE_BYTES, maxFiles = MAX_FILES } = {}) {
  const listed = gitListFiles(root) ?? walkFiles(root);
  const candidates = listed
    .map(toPosix)
    .filter((p) => !shouldSkip(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const files = [];
  let skippedLarge = 0;
  for (const p of candidates) {
    if (files.length >= maxFiles) break;
    const abs = path.join(root, p);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > maxFileBytes) {
      skippedLarge++;
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) continue;
    const content = buf.toString('utf8');
    files.push({
      path: p,
      ext: fileExt(p),
      size: stat.size,
      lines: content.split('\n').length,
      content,
    });
  }

  const keyDocs = files.filter((f) => !f.path.includes('/') && KEY_DOC_RE.test(f.path));
  return {
    root,
    files,
    keyDocs,
    stats: { listed: listed.length, kept: files.length, skippedLarge },
  };
}

/** A compact directory overview: top directories with file counts. */
export function treeOverview(files, maxDirs = 40) {
  const counts = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxDirs)
    .map(([d, n]) => `${d}/ (${n} files)`)
    .join('\n');
}
