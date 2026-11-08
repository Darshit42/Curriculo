/**
 * Code map: who imports whom, the folder tree, and module-level connections.
 * Shared by `curriculo explore` (TUI), `curriculo map`, and the Claude skill.
 */
import { computeImportEdges, rankFiles } from './rank.js';
import { extractSymbols, leadingDoc } from './slice.js';

/** Module = top-level folder, or two levels deep for src/lib/packages-style roots. */
export function moduleOf(p) {
  const parts = p.split('/');
  if (parts.length === 1) return '(root)';
  const nested = /^(src|lib|source|packages|apps|crates|pkg|internal|cmd|app)$/.test(parts[0]);
  return nested && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Build the map for an ingested repo.
 * Returns { files: Map<path, info>, ranked, tree, modules, moduleEdges, edgeCount }.
 * info = { path, lines, size, ext, score, entry, reasons, fanIn, imports[], importedBy[], module }
 */
export function buildCodeMap(ing, { ranked } = {}) {
  const edges = computeImportEdges(ing.files);
  ranked ??= rankFiles(ing.files, edges);
  const rankBy = new Map(ranked.map((r) => [r.path, r]));
  const files = new Map();
  for (const f of ing.files) {
    const r = rankBy.get(f.path) || {};
    files.set(f.path, {
      path: f.path,
      lines: f.lines,
      size: f.size,
      ext: f.ext,
      score: r.score ?? 0,
      entry: !!r.entry,
      reasons: r.reasons || [],
      fanIn: r.fanIn || 0,
      imports: [],
      importedBy: [],
      module: moduleOf(f.path),
    });
  }
  let edgeCount = 0;
  for (const [from, targets] of edges) {
    for (const [to, w] of targets) {
      if (w < 0.5 || !files.has(from) || !files.has(to)) continue; // keep confident links only
      files.get(from).imports.push(to);
      files.get(to).importedBy.push(from);
      edgeCount++;
    }
  }
  const byScore = (a, b) => (files.get(b)?.score ?? 0) - (files.get(a)?.score ?? 0) || a.localeCompare(b);
  for (const info of files.values()) {
    info.imports.sort(byScore);
    info.importedBy.sort(byScore);
  }
  return { files, ranked, tree: buildTree([...files.values()]), ...moduleGraph(files), edgeCount };
}

/** Nested folder tree: { name, path, dir: true, children[], fileCount, lines, best } */
export function buildTree(infos) {
  const root = { name: '.', path: '', dir: true, children: [], fileCount: 0, lines: 0, best: 0 };
  const dirs = new Map([['', root]]);
  const ensureDir = (p) => {
    if (dirs.has(p)) return dirs.get(p);
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const node = { name: p.split('/').pop(), path: p, dir: true, children: [], fileCount: 0, lines: 0, best: 0 };
    ensureDir(parentPath).children.push(node);
    dirs.set(p, node);
    return node;
  };
  for (const info of infos) {
    const parentPath = info.path.includes('/') ? info.path.slice(0, info.path.lastIndexOf('/')) : '';
    ensureDir(parentPath).children.push({ name: info.path.split('/').pop(), path: info.path, dir: false });
    // roll up stats to every ancestor
    let p = parentPath;
    for (;;) {
      const d = dirs.get(p);
      d.fileCount++;
      d.lines += info.lines;
      d.best = Math.max(d.best, info.score);
      if (!p) break;
      p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    }
  }
  const sort = (node) => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    node.children.filter((c) => c.dir).forEach(sort);
  };
  sort(root);
  return root;
}

/** Modules and the import links between them. */
export function moduleGraph(files) {
  const mods = new Map();
  const edgeMap = new Map();
  for (const info of files.values()) {
    const m = mods.get(info.module) || { name: info.module, files: 0, lines: 0, score: 0, top: null };
    m.files++;
    m.lines += info.lines;
    if (!m.top || info.score > files.get(m.top).score) m.top = info.path;
    m.score = Math.max(m.score, info.score);
    mods.set(info.module, m);
    for (const to of info.imports) {
      const tm = files.get(to).module;
      if (tm === info.module) continue;
      const key = `${info.module}\u0000${tm}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }
  const moduleEdges = [...edgeMap.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
  const modules = [...mods.values()].sort((a, b) => b.score - a.score || b.files - a.files);
  return { modules, moduleEdges };
}

/** One-file summary used by the TUI details pane and `curriculo map`. */
export function describeFile(ing, info) {
  const f = ing.files.find((x) => x.path === info.path);
  return {
    doc: f ? leadingDoc(f.content) : '',
    symbols: f ? extractSymbols(f.content).filter((s) => !s.name.startsWith('_')).slice(0, 12) : [],
  };
}

/** Mermaid flowchart of module connections (for README/LEARN.md or the Claude skill). */
export function mermaidModules(map, { maxEdges = 25 } = {}) {
  const id = (name) => 'm_' + name.replace(/[^A-Za-z0-9]/g, '_');
  const lines = ['flowchart LR'];
  const used = new Set();
  for (const e of map.moduleEdges.slice(0, maxEdges)) {
    used.add(e.from);
    used.add(e.to);
    lines.push(`  ${id(e.from)} -->|${e.count}| ${id(e.to)}`);
  }
  for (const m of map.modules) {
    if (used.has(m.name) || used.size < 12) lines.splice(1, 0, `  ${id(m.name)}["${moduleLabel(m.name)} (${m.files})"]`);
  }
  return lines.join('\n');
}

export function moduleLabel(name) {
  return name === '(root)' ? name : `${name}/`;
}

/** Plain-text module map (for `curriculo map`, piped output, and the skill). */
export function textModuleMap(map, { maxModules = 15, maxEdges = 20 } = {}) {
  const out = [`Modules (${map.modules.length}) — most important first`];
  const w = Math.max(...map.modules.slice(0, maxModules).map((m) => moduleLabel(m.name).length), 8);
  for (const m of map.modules.slice(0, maxModules)) {
    out.push(`  ${moduleLabel(m.name).padEnd(w + 1)} ${String(m.files).padStart(4)} files  ${String(m.lines).padStart(6)} lines   key file: ${m.top}`);
  }
  out.push('', `Connections between modules (${map.moduleEdges.length})`);
  if (!map.moduleEdges.length) out.push('  (no cross-module imports detected)');
  for (const e of map.moduleEdges.slice(0, maxEdges)) out.push(`  ${moduleLabel(e.from)} ──${e.count}──▶ ${moduleLabel(e.to)}`);
  return out.join('\n');
}
