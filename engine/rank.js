import path from 'node:path';
import { fileStem } from './util.js';

/** Extensions treated as source code (everything else is config/docs). */
export const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'scala', 'rb', 'php', 'cs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'hh', 'swift', 'm', 'mm',
  'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'lua', 'dart', 'vue', 'svelte', 'sh', 'r', 'jl',
  'zig', 'nim', 'sol', 'fs', 'pl', 'groovy',
]);

const ENTRY_NAMES = new Set([
  'main', 'index', 'app', 'cli', 'server', '__main__', 'manage', 'mod', 'lib', 'program',
  'application', 'bootstrap', 'entry', 'root', 'cmd', 'wsgi', 'asgi',
]);

const JS_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'];
const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|testing|testdata|test_data|e2e|cypress|playwright)\/|(^|\/)test_[^/]+$|[._-](test|spec)s?\.[a-z]+$|_test\.(go|py|rs)$/i;
const PERIPHERAL_RE = /(^|\/)(docs?|examples?|samples?|demos?|scripts?|tools?|bench(marks?)?|fixtures?|migrations?|third[_-]?party|generated|gen|stories|storybook|assets|static|public|locales?|i18n|\.github|ci)\//i;
const CORE_DIR_RE = /(^|\/)(src|lib|core|app|pkg|internal|server|api|engine|kernel|runtime|crates)\//i;

/** Entry points declared by package manifests (package.json, Cargo.toml). */
export function declaredEntries(files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = new Set();
  const addJs = (dir, rel) => {
    if (typeof rel !== 'string') return;
    const p = path.posix.normalize(path.posix.join(dir, rel)).replace(/^\.\//, '');
    for (const cand of [p, ...JS_EXTS.map((e) => `${p}.${e}`), ...JS_EXTS.map((e) => `${p}/index.${e}`)]) {
      if (byPath.has(cand)) {
        out.add(cand);
        return;
      }
    }
    // dist/foo.js usually maps to src/foo.ts
    const src = p.replace(/^(dist|build|lib|out)\//, 'src/').replace(/\.(c|m)?js$/, '');
    for (const e of JS_EXTS) if (byPath.has(`${src}.${e}`)) return out.add(`${src}.${e}`);
  };
  for (const f of files) {
    const base = f.path.split('/').pop();
    const dir = path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path);
    if (base === 'package.json' && f.path.split('/').length <= 3) {
      let pkg;
      try {
        pkg = JSON.parse(f.content);
      } catch {
        continue;
      }
      addJs(dir, pkg.main);
      addJs(dir, pkg.module);
      addJs(dir, pkg.source);
      if (typeof pkg.bin === 'string') addJs(dir, pkg.bin);
      else if (pkg.bin) Object.values(pkg.bin).forEach((b) => addJs(dir, b));
      if (typeof pkg.exports === 'string') addJs(dir, pkg.exports);
      else if (pkg.exports?.['.']) {
        const e = pkg.exports['.'];
        addJs(dir, typeof e === 'string' ? e : e.import || e.default || e.require);
      }
    }
    if (base === 'Cargo.toml') {
      for (const p of ['src/main.rs', 'src/lib.rs']) {
        const full = dir ? `${dir}/${p}` : p;
        if (byPath.has(full)) out.add(full);
      }
    }
  }
  for (const f of files) {
    if (/(^|\/)cmd\/[^/]+\/main\.go$/.test(f.path) || f.path === 'main.go') out.add(f.path);
    if (/(^|\/)__main__\.py$/.test(f.path) && f.path.split('/').length <= 3) out.add(f.path);
  }
  // Python packages: the top-level package __init__ is the public API surface.
  if (byPath.has('pyproject.toml') || byPath.has('setup.py') || byPath.has('setup.cfg')) {
    for (const f of files) {
      if (/^(src\/)?[A-Za-z_]\w*\/__init__\.py$/.test(f.path) && f.lines >= 5) out.add(f.path);
    }
  }
  return out;
}

function noExt(p) {
  const i = p.lastIndexOf('.');
  return i > p.lastIndexOf('/') ? p.slice(0, i) : p;
}

/** Map every path-suffix (by segments, extension dropped) to the files it names. */
function buildSuffixIndex(files) {
  const idx = new Map();
  for (const f of files) {
    let segs = noExt(f.path).split('/');
    if (segs[segs.length - 1] === '__init__' || segs[segs.length - 1] === 'mod') segs = segs.slice(0, -1);
    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(i).join('/');
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(f.path);
    }
  }
  return idx;
}

function importSpecs(f) {
  const specs = [];
  const c = f.content;
  const push = (s, relative = false) => s && specs.push({ s, relative });
  let m;
  if (JS_EXTS.includes(f.ext)) {
    const re = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
    while ((m = re.exec(c))) {
      const s = m[1] || m[2] || m[3] || m[4];
      push(s, s.startsWith('.'));
      if (!s.startsWith('.') && /^[@~#]\//.test(s)) push(s.slice(2), false);
    }
  } else if (f.ext === 'py') {
    const re = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w, ]+)|^\s*import\s+([\w.]+)/gm;
    while ((m = re.exec(c))) {
      if (m[1] !== undefined) {
        const base = m[1];
        if (base.startsWith('.')) {
          const dots = base.match(/^\.+/)[0].length;
          const rest = base.slice(dots).replace(/\./g, '/');
          push({ dots, rest, names: m[2].split(',').map((x) => x.trim()) }, true);
        } else {
          push(base.replace(/\./g, '/'));
          for (const n of m[2].split(',')) push(`${base.replace(/\./g, '/')}/${n.trim()}`);
        }
      } else push(m[3].replace(/\./g, '/'));
    }
  } else if (f.ext === 'go') {
    const re = /^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"/gm;
    while ((m = re.exec(c))) if (m[1].includes('/')) push(m[1]);
  } else if (f.ext === 'rs') {
    const re = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;|^\s*(?:pub\s+)?use\s+(?:crate|super)::([\w:]+)/gm;
    while ((m = re.exec(c))) {
      if (m[1]) push({ mod: m[1] }, true);
      else push(m[2].split('::').filter((x) => /^[a-z_]/.test(x)).join('/'));
    }
  } else if (['java', 'kt', 'kts', 'scala', 'groovy', 'cs'].includes(f.ext)) {
    const re = /^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/gm;
    while ((m = re.exec(c))) push(m[1].replace(/\./g, '/'));
  } else if (['c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'hh', 'm', 'mm'].includes(f.ext)) {
    const re = /^\s*#\s*include\s+"([^"]+)"/gm;
    while ((m = re.exec(c))) push(m[1], true);
  } else if (['rb'].includes(f.ext)) {
    const re = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm;
    while ((m = re.exec(c))) push(m[1], m[0].includes('_relative'));
  }
  return specs;
}

/** Count how many distinct files import each file (approximate, regex-based). */
export function computeFanIn(files) {
  const byPath = new Set(files.map((f) => f.path));
  const suffix = buildSuffixIndex(files);
  const fanIn = new Map();
  const bump = (target, w = 1) => fanIn.set(target, (fanIn.get(target) || 0) + w);

  for (const f of files) {
    if (!CODE_EXT.has(f.ext)) continue;
    const dir = path.posix.dirname(f.path);
    // Imports from tests/examples say less about what is load-bearing.
    const weight = TEST_RE.test(f.path) || PERIPHERAL_RE.test(f.path) ? 0.25 : 1;
    const targets = new Map();
    const add = (cands) => {
      const list = cands.filter((t) => t !== f.path);
      if (!list.length || list.length > 6) return;
      for (const t of list) targets.set(t, Math.max(targets.get(t) || 0, 1 / list.length));
    };
    for (const { s, relative } of importSpecs(f)) {
      if (relative && typeof s === 'string') {
        const p = path.posix.normalize(path.posix.join(dir, s));
        const hit = [p, ...JS_EXTS.map((e) => `${p}.${e}`), ...JS_EXTS.map((e) => `${p}/index.${e}`), `${p}.h`, `${p}.rb`]
          .find((c) => byPath.has(c));
        if (hit) add([hit]);
        else if (f.ext === 'h' || f.ext.startsWith('c')) add(suffix.get(noExt(s)) || []);
      } else if (relative && s.dots) {
        let base = dir.split('/');
        base = base.slice(0, Math.max(0, base.length - (s.dots - 1)));
        const root = [...base, ...(s.rest ? [s.rest] : [])].filter((x) => x && x !== '.').join('/');
        const hits = [root, ...s.names.map((n) => (root ? `${root}/${n}` : n))]
          .flatMap((k) => suffix.get(k) || [])
          .filter((p) => p.startsWith(root));
        add([...new Set(hits)].slice(0, 6));
      } else if (relative && s.mod) {
        add([`${dir}/${s.mod}.rs`, `${dir}/${s.mod}/mod.rs`].filter((c) => byPath.has(c)));
      } else if (typeof s === 'string') {
        const segs = s.split('/').filter(Boolean);
        // Try the longest suffix that resolves (handles module prefixes like github.com/org/repo/pkg).
        for (let i = 0; i < segs.length; i++) {
          const key = segs.slice(i).join('/');
          const hit = suffix.get(key);
          if (hit) {
            if (segs.length - i === 1 && hit.length > 2) break; // too ambiguous
            add(hit);
            break;
          }
        }
      }
    }
    for (const [t, w] of targets) bump(t, w * weight);
  }
  return fanIn;
}

/**
 * Score every file by teaching value. Returns files sorted best-first:
 * [{ path, score, fanIn, reasons, entry }].
 */
export function rankFiles(files) {
  const entries = declaredEntries(files);
  const fanIn = computeFanIn(files);
  const ranked = files.map((f) => {
    const reasons = [];
    let score = 0;
    const depth = f.path.split('/').length - 1;
    const stem = fileStem(f.path).toLowerCase();
    const isCode = CODE_EXT.has(f.ext);
    let entry = false;

    if (entries.has(f.path)) {
      score += 6;
      entry = true;
      reasons.push('declared entry point');
    } else if (isCode && ENTRY_NAMES.has(stem) && depth <= 2 && !PERIPHERAL_RE.test(f.path) && !TEST_RE.test(f.path)) {
      score += depth === 0 ? 3 : 2.5;
      entry = true;
      reasons.push('entry-like name');
    }
    const fi = fanIn.get(f.path) || 0;
    if (fi > 0) {
      score += Math.log2(1 + fi) * 2;
      const n = Math.max(1, Math.round(fi));
      reasons.push(`imported by ~${n} file${n === 1 ? '' : 's'}`);
    }
    score += Math.max(0, 2 - depth * 0.5);
    if (CORE_DIR_RE.test(f.path)) {
      score += 1;
      reasons.push('core directory');
    }
    if (TEST_RE.test(f.path)) {
      score -= 6;
      reasons.push('test');
    } else if (PERIPHERAL_RE.test(f.path)) {
      score -= 2.5;
      reasons.push('peripheral');
    }
    if (/\.d\.ts$/.test(f.path)) score -= 3;
    if (f.lines < 15 && !entries.has(f.path)) score -= 2;
    else if (f.lines >= 40 && f.lines <= 1200) score += 1;
    else if (f.lines > 3000) score -= 1;
    if (!isCode) score -= 3;
    return { path: f.path, score: Math.round(score * 100) / 100, fanIn: Math.round(fi * 10) / 10, reasons, entry };
  });
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** Choose the teaching set: top-N code files, never tests, at least one entry point. */
export function selectTeachingSet(ranked, { top = 24, maxPeripheral = 2 } = {}) {
  const pool = ranked.filter(
    (r) =>
      CODE_EXT.has(r.path.split('.').pop().toLowerCase()) &&
      !r.reasons.includes('test') &&
      !/(^|\/)\.[^/]+\//.test(r.path),
  );
  const core = pool.filter((r) => !r.reasons.includes('peripheral') && r.score > 0);
  // A few peripheral files (examples) show the code in use; more would crowd out the core.
  const peripheral = pool.filter((r) => r.reasons.includes('peripheral') && r.score > 0).slice(0, maxPeripheral);
  let chosen = [...core.slice(0, top - peripheral.length), ...peripheral];
  if (chosen.length < 3) chosen = pool.slice(0, Math.min(top, Math.max(3, chosen.length)));
  chosen.sort((a, b) => b.score - a.score);
  if (!chosen.some((r) => r.entry)) {
    const e = pool.find((r) => r.entry);
    if (e) chosen[chosen.length - 1] = e;
  }
  return chosen;
}
