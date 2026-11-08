/**
 * `curriculo explore` — a visual, dependency-free terminal explorer:
 *   browse  folder tree + details (imports →, importers ←, key definitions)
 *   graph   connection diagram around a file; walk the graph with ↑/↓ + enter
 *   map     module map: which parts of the project depend on which
 *   ask     ask a question about the selected file/folder (grounded answer)
 */
import path from 'node:path';
import readline from 'node:readline';
import { describeFile, moduleLabel } from '../engine/graph.js';
import { askAboutCode } from '../engine/ask.js';
import { A, fit, openPath, stripAnsi, styleLine, visLen, wrap } from './term.js';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Box-drawing junction for a bus cell with connections up/down/left/right. */
export function junction(u, d, l, r) {
  const k = (u ? 1 : 0) | (d ? 2 : 0) | (l ? 4 : 0) | (r ? 8 : 0);
  return { 0: ' ', 1: '│', 2: '│', 3: '│', 4: '─', 8: '─', 12: '─', 5: '┘', 6: '┐', 7: '┤', 9: '└', 10: '┌', 11: '├', 13: '┴', 14: '┬', 15: '┼' }[k];
}

/** Shorten a path from the left so the file name stays visible. */
function shortPath(p, width) {
  return p.length <= width ? p : '…' + p.slice(p.length - width + 1);
}

/**
 * Neighbourhood diagram: importers on the left, the file in a box, imports on the right.
 * Returns { lines, items } where items[i] is the path drawn as neighbour i (left first).
 */
export function drawNeighbourhood(center, left, right, { width = 100, rows = 15, sel = -1 } = {}) {
  const name = center.split('/').pop();
  const cw = Math.min(Math.max(name.length + 2, 10), 32);
  const side = Math.max(12, Math.floor((width - cw - 14) / 2));
  const R = Math.max(3, Math.min(Math.max(left.length, right.length), rows));
  const L = left.slice(0, R);
  const Rt = right.slice(0, R);
  const mid = Math.floor((R - 1) / 2);
  const busL = (r) => {
    if (!L.length) return ' ';
    const lo = Math.min(0, mid);
    const hi = Math.max(L.length - 1, mid);
    if (r < lo || r > hi) return ' ';
    return junction(r > lo, r < hi, r < L.length, r === mid);
  };
  const busR = (r) => {
    if (!Rt.length) return ' ';
    const hi = Math.max(Rt.length - 1, mid);
    if (r > hi) return ' ';
    return junction(r > 0, r < hi, r === mid, r < Rt.length);
  };
  const items = [...L, ...Rt];
  const label = (p, i, color) => {
    const t = shortPath(p, side);
    return i === sel ? A.inv(t) : color(t);
  };
  const lines = [];
  const lTitle = left.length ? `imported by (${left.length}${left.length > L.length ? `, showing ${L.length}` : ''})` : 'imported by: nothing';
  const rTitle = right.length ? `imports (${right.length}${right.length > Rt.length ? `, showing ${Rt.length}` : ''})` : 'imports: nothing';
  lines.push(A.dim(lTitle.padStart(side)) + ' '.repeat(cw + 10) + A.dim(rTitle));
  for (let r = 0; r < R; r++) {
    const lp = L[r];
    const rp = Rt[r];
    const leftName = lp ? ' '.repeat(Math.max(0, side - Math.min(lp.length, side))) + label(lp, r, A.green) : ' '.repeat(side);
    const box =
      r === mid - 1
        ? '┌' + '─'.repeat(cw) + '┐'
        : r === mid
          ? '│' + A.bold(A.yellow(fit(' '.repeat(Math.max(0, Math.floor((cw - name.length) / 2))) + name, cw))) + '│'
          : r === mid + 1
            ? '└' + '─'.repeat(cw) + '┘'
            : ' '.repeat(cw + 2);
    lines.push(
      leftName +
        (lp ? ' ─' : '  ') +
        busL(r) +
        (r === mid && L.length ? '─▶' : '  ') +
        (r >= mid - 1 && r <= mid + 1 ? A.yellow(box.slice(0, 1)) + box.slice(1, -1) + A.yellow(box.slice(-1)) : box) +
        (r === mid && Rt.length ? '──' : '  ') +
        busR(r) +
        (rp ? '─▶ ' + label(rp, L.length + r, A.cyan) : ''),
    );
  }
  return { lines, items };
}

export function runExplorer({ map, ing, root, repoId, course, getClient }) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const top = new Set(map.ranked.slice(0, 10).map((r) => r.path));
    const expanded = new Set(['']);
    // Open the folders that hold the most important files.
    for (const r of map.ranked.slice(0, 5)) {
      const parts = r.path.split('/');
      for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
    }
    const st = {
      mode: 'browse',
      sel: 0,
      treeTop: 0,
      detailTop: 0,
      graphSel: 0,
      mapSel: 0,
      input: '',
      inputKind: '',
      matches: [],
      matchIdx: 0,
      answer: null,
      spin: 0,
      flash: `${map.files.size} files · ${map.edgeCount} import links · ${map.modules.length} modules. Press ? to ask about anything.`,
    };
    let timer = null;

    const W = () => Math.max(50, Math.min(out.columns || 100, 180));
    const H = () => Math.max(14, out.rows || 30);

    function rows() {
      const list = [];
      const walk = (node, depth) => {
        for (const c of node.children) {
          list.push({ node: c, depth });
          if (c.dir && expanded.has(c.path)) walk(c, depth + 1);
        }
      };
      walk(map.tree, 0);
      return list;
    }
    let cache = rows();
    const refresh = () => (cache = rows());
    const current = () => cache[st.sel]?.node || map.tree;

    function selectPath(p) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
      refresh();
      const i = cache.findIndex((r) => r.node.path === p);
      if (i >= 0) st.sel = i;
      st.detailTop = 0;
    }

    // Start on the main entry point (or the most important file).
    const start = map.ranked.find((r) => r.entry) || map.ranked[0];
    if (start) selectPath(start.path);

    // ---------- rendering ----------
    function header(title) {
      const left = ` curriculo explore · ${repoId}`;
      const right = `${title} `;
      return A.inv(left + ' '.repeat(Math.max(1, W() - left.length - right.length)) + right);
    }

    function footer(keys) {
      const lines = [];
      if (st.inputKind) {
        const label = st.inputKind === 'ask' ? `Ask about ${askTargetLabel()}: ` : `Find: `;
        const extra = st.inputKind === 'search' ? A.dim(`  ${st.matches.length} match${st.matches.length === 1 ? '' : 'es'}`) : '';
        lines.push(A.bold(label) + st.input + A.inv(' ') + extra);
        lines.push(A.dim(st.inputKind === 'ask' ? 'enter send · esc cancel' : 'enter jump · esc cancel'));
      } else {
        lines.push(st.flash ? A.yellow(fit(st.flash, W())) : '');
        lines.push(A.dim(fit(keys, W())));
      }
      return lines;
    }

    function treeLine(r, i, rel, width) {
      const n = r.node;
      const pad = '  '.repeat(r.depth);
      let text;
      if (n.dir) {
        const arrow = expanded.has(n.path) ? '▾' : '▸';
        text = `${pad}${arrow} ${A.bold(n.name + '/')} ${A.dim(String(n.fileCount))}`;
      } else {
        const info = map.files.get(n.path);
        const mark = info?.entry ? A.yellow('★') : top.has(n.path) ? A.green('●') : A.dim('·');
        const link = rel.get(n.path);
        const tag = link === 'out' ? A.cyan(' →') : link === 'in' ? A.green(' ←') : '';
        text = `${pad}  ${mark} ${n.name}${tag}`;
      }
      return i === st.sel ? A.inv(fit(stripAnsi(text), width)) : fit(text, width);
    }

    function fileDetail(p, width) {
      const info = map.files.get(p);
      const { doc, symbols } = describeFile(ing, info);
      const L = [A.bold(p), A.dim(`${info.lines.toLocaleString()} lines · module ${moduleLabel(info.module)} · score ${info.score}`)];
      const badges = [info.entry ? A.yellow('★ entry point') : '', ...info.reasons.filter((r) => r !== 'declared entry point' && r !== 'entry-like name')].filter(Boolean);
      if (badges.length) L.push(badges.join(A.dim(' · ')));
      if (doc) L.push('', ...wrap(doc, width).map((l) => A.dim(l)));
      const lessons = course?.lessons?.filter((l) => l.files.includes(p)) || [];
      if (lessons.length) L.push('', A.magenta(`Taught in lesson ${lessons.map((l) => `${l.order} “${l.title}”`).join(', ')}`));
      const list = (title, items, arrow, color) => {
        L.push('', A.bold(`${title} (${items.length})`));
        if (!items.length) L.push(A.dim('  none detected'));
        for (const x of items.slice(0, 8)) L.push(`  ${color(arrow)} ${fit(x, width - 4)}`);
        if (items.length > 8) L.push(A.dim(`  … ${items.length - 8} more (g for the graph)`));
      };
      list('Imports →', info.imports, '→', A.cyan);
      list('Imported by ←', info.importedBy, '←', A.green);
      if (symbols.length) {
        L.push('', A.bold('Key definitions'));
        for (const s of symbols.slice(0, 10)) L.push(`  ${A.cyan(s.name)} ${A.dim(`:${s.line} ${s.kind}`)}`);
      }
      return L;
    }

    function folderDetail(node, width) {
      const name = node.path ? `${node.path}/` : `${repoId} (repository root)`;
      const L = [A.bold(name), A.dim(`${node.fileCount} files · ${node.lines.toLocaleString()} lines`)];
      const inside = [...map.files.values()].filter((f) => !node.path || f.path.startsWith(node.path + '/')).sort((a, b) => b.score - a.score);
      L.push('', A.bold('Most important files'));
      for (const f of inside.slice(0, 7)) L.push(`  ${f.entry ? A.yellow('★') : A.green('●')} ${fit(node.path ? f.path.slice(node.path.length + 1) : f.path, width - 4)}`);
      const mods = new Set(inside.map((f) => f.module));
      const outE = map.moduleEdges.filter((e) => mods.has(e.from) && !mods.has(e.to));
      const inE = map.moduleEdges.filter((e) => mods.has(e.to) && !mods.has(e.from));
      if (node.path) {
        L.push('', A.bold(`Depends on (${outE.length})`));
        for (const e of outE.slice(0, 6)) L.push(`  ${A.cyan('→')} ${moduleLabel(e.to)} ${A.dim(`${e.count} import${e.count === 1 ? '' : 's'}`)}`);
        if (!outE.length) L.push(A.dim('  nothing outside this folder'));
        L.push('', A.bold(`Used by (${inE.length})`));
        for (const e of inE.slice(0, 6)) L.push(`  ${A.green('←')} ${moduleLabel(e.from)} ${A.dim(`${e.count} import${e.count === 1 ? '' : 's'}`)}`);
        if (!inE.length) L.push(A.dim('  nothing outside this folder'));
      } else {
        L.push('', A.dim('Press m for the module map, or ? to ask about the whole repo.'));
      }
      return L;
    }

    function drawBrowse() {
      const w = W();
      const h = H() - 3;
      const node = current();
      const sel = node.dir ? null : map.files.get(node.path);
      const rel = new Map();
      if (sel) {
        sel.imports.forEach((p) => rel.set(p, 'out'));
        sel.importedBy.forEach((p) => rel.set(p, 'in'));
      }
      const narrow = w < 80;
      const lw = narrow ? w : Math.min(52, Math.max(30, Math.floor(w * 0.4)));
      const rw = w - lw - 3;
      if (st.sel < st.treeTop) st.treeTop = st.sel;
      if (st.sel >= st.treeTop + h) st.treeTop = st.sel - h + 1;
      const left = cache.slice(st.treeTop, st.treeTop + h).map((r, i) => treeLine(r, st.treeTop + i, rel, lw));
      const right = narrow ? [] : (node.dir ? folderDetail(node, rw) : fileDetail(node.path, rw)).flatMap((l) => (visLen(l) > rw ? [fit(l, rw)] : [l]));
      st.detailTop = Math.max(0, Math.min(st.detailTop, right.length - h));
      const body = [];
      for (let i = 0; i < h; i++) {
        const l = left[i] ?? ' '.repeat(lw);
        body.push(narrow ? l : `${fit(l, lw)} ${A.dim('│')} ${right[st.detailTop + i] ?? ''}`);
      }
      const keys = node.dir
        ? '↑↓ move · →/enter open folder · ← close · o open in editor · ? ask · m modules · / find · q quit'
        : '↑↓ move · enter/g connections · o open file · ? ask · m modules · / find · [ ] scroll details · q quit';
      return [header('browse'), ...body, ...footer(keys)];
    }

    function drawGraph() {
      const node = current();
      const info = map.files.get(node.path);
      const h = H() - 6;
      const g = drawNeighbourhood(node.path, info.importedBy, info.imports, { width: W(), rows: h, sel: st.graphSel });
      st.graphItems = g.items;
      const body = [A.bold(`Connections of ${node.path}`) + A.dim(`  ·  ${info.lines} lines${info.entry ? ' · ★ entry point' : ''}`), '', ...g.lines];
      while (body.length < H() - 3) body.push('');
      const target = g.items[st.graphSel];
      const keys = `↑↓ pick a neighbour${target ? ` (${target.split('/').pop()})` : ''} · enter jump to it · o open · ? ask · ← back · q quit`;
      return [header('connections'), ...body.slice(0, H() - 3), ...footer(keys)];
    }

    function drawMap() {
      const w = W();
      const h = H() - 3;
      const mods = map.modules;
      st.mapSel = Math.max(0, Math.min(st.mapSel, mods.length - 1));
      const m = mods[st.mapSel];
      const maxFiles = Math.max(...mods.map((x) => x.files), 1);
      const nameW = Math.min(30, Math.max(...mods.map((x) => moduleLabel(x.name).length), 8));
      const lw = Math.min(nameW + 22, Math.floor(w * 0.5));
      const left = mods.map((x, i) => {
        const bar = '█'.repeat(Math.max(1, Math.round((x.files / maxFiles) * 10)));
        const t = `${fit(moduleLabel(x.name), nameW)} ${A.blue(bar.padEnd(10))} ${A.dim(String(x.files).padStart(4))}`;
        return i === st.mapSel ? A.inv(fit(` ${moduleLabel(x.name)} `, nameW + 1)) + ` ${A.blue(bar.padEnd(10))} ${A.dim(String(x.files).padStart(4))}` : ` ${t}`;
      });
      const outE = map.moduleEdges.filter((e) => e.from === m.name);
      const inE = map.moduleEdges.filter((e) => e.to === m.name);
      const right = [
        A.bold(moduleLabel(m.name)) + A.dim(`  ${m.files} files · ${m.lines.toLocaleString()} lines`),
        A.dim(`key file: ${m.top}`),
        '',
        A.bold(`uses → (${outE.length})`),
        ...(outE.length ? outE.slice(0, 8).map((e) => `  ${moduleLabel(m.name)} ${A.cyan('──' + e.count + '──▶')} ${moduleLabel(e.to)}`) : [A.dim('  nothing outside itself')]),
        '',
        A.bold(`used by ← (${inE.length})`),
        ...(inE.length ? inE.slice(0, 8).map((e) => `  ${moduleLabel(e.from)} ${A.green('──' + e.count + '──▶')} ${moduleLabel(m.name)}`) : [A.dim('  nothing depends on it')]),
      ];
      const start = Math.max(0, Math.min(st.mapSel - Math.floor(h / 2), left.length - h));
      const body = [];
      for (let i = 0; i < h; i++) body.push(`${fit(left[start + i] ?? '', lw)} ${A.dim('│')} ${fit(right[i] ?? '', w - lw - 3)}`);
      return [header('module map'), ...body, ...footer('↑↓ pick a module · enter show it in the tree · ? ask about it · ← back · q quit')];
    }

    function drawAnswer() {
      const a = st.answer;
      const w = W() - 2;
      const h = H() - 3;
      const L = [A.bold(`Q: ${a.question}`), A.dim(`about ${a.label}${a.model ? ` · ${a.model}` : ''}`), ''];
      if (a.loading) L.push(`${A.cyan(SPIN[st.spin % SPIN.length])} Reading the code and thinking…`);
      else if (a.error) L.push(...wrap(a.error, w).map((l) => A.red(l)));
      else {
        const state = {};
        for (const l of wrap(a.text, w)) L.push(' ' + styleLine(l, state));
      }
      a.scroll = Math.max(0, Math.min(a.scroll, L.length - h));
      const body = L.slice(a.scroll, a.scroll + h);
      while (body.length < h) body.push('');
      return [header('ask'), ...body, ...footer('↑↓ scroll · ? ask a follow-up · ← back · q quit')];
    }

    function draw() {
      const screen = { browse: drawBrowse, graph: drawGraph, map: drawMap, answer: drawAnswer }[st.mode]();
      out.write('\x1b[H\x1b[2J' + screen.slice(0, H()).join('\n'));
      if (!st.inputKind) st.flash = '';
    }

    // ---------- actions ----------
    function askTarget() {
      if (st.mode === 'map') return map.modules[st.mapSel].name === '(root)' ? '' : map.modules[st.mapSel].name;
      if (st.mode === 'graph' && st.graphItems?.[st.graphSel] && st.askNeighbour) return st.graphItems[st.graphSel];
      if (st.mode === 'answer') return st.answer.target;
      return current().path;
    }
    function askTargetLabel() {
      const t = st.pendingTarget ?? askTarget();
      return t ? (map.files.has(t) ? t : `${t}/`) : 'the whole repo';
    }

    async function ask(question) {
      const target = st.pendingTarget ?? askTarget();
      st.pendingTarget = undefined;
      st.answer = { question, target, label: target ? (map.files.has(target) ? target : `${target}/`) : 'the whole repo', loading: true, scroll: 0 };
      st.returnMode = st.mode === 'answer' ? st.returnMode : st.mode;
      st.mode = 'answer';
      timer = setInterval(() => {
        st.spin++;
        draw();
      }, 120);
      draw();
      try {
        const client = getClient();
        st.answer.model = client.label;
        st.answer.text = await askAboutCode({ client, ing, map, target, question, repo: repoId, summary: course?.summary });
      } catch (err) {
        st.answer.error = `${err.message}${err.code === 'NO_CONFIG' ? '' : ''}`;
      } finally {
        clearInterval(timer);
        timer = null;
        st.answer.loading = false;
        draw();
      }
    }

    function open(p, isDir) {
      st.flash = openPath(path.join(root, p || '.'), p ? (isDir ? `${p}/` : p) : 'the repository', { isDir, leave, enter });
    }

    function startInput(kind) {
      st.inputKind = kind;
      st.input = '';
      st.matches = [];
      if (kind === 'ask') st.pendingTarget = askTarget();
    }

    function onInputKey(str, key) {
      if (key.name === 'escape') {
        st.inputKind = '';
        st.pendingTarget = undefined;
        return;
      }
      if (key.name === 'return') {
        const kind = st.inputKind;
        const text = st.input.trim();
        st.inputKind = '';
        if (kind === 'ask' && text) return void ask(text);
        if (kind === 'search' && st.matches.length) {
          st.mode = 'browse';
          st.matchIdx = 0;
          selectPath(st.matches[0]);
          st.flash = st.matches.length === 1 ? 'Found it.' : `${st.matches.length} matches — press n for the next one.`;
        }
        return;
      }
      if (key.name === 'backspace') st.input = st.input.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') st.input += str;
      if (st.inputKind === 'search') {
        const q = st.input.toLowerCase();
        st.matches = q ? [...map.files.keys()].filter((p) => p.toLowerCase().includes(q)).sort((a, b) => map.files.get(b).score - map.files.get(a).score) : [];
      }
    }

    function onKey(str, key = {}) {
      if (key.ctrl && key.name === 'c') return quit();
      if (st.answer?.loading && st.mode === 'answer') return; // wait for the answer
      if (st.inputKind) {
        onInputKey(str, key);
        return draw();
      }
      const name = key.name || str;
      if (name === 'q') return quit();
      if (str === '?') {
        startInput('ask');
        return draw();
      }
      if (str === '/') {
        startInput('search');
        return draw();
      }
      const node = current();
      const h = H() - 3;
      switch (st.mode) {
        case 'browse':
          if (name === 'up' || name === 'k') st.sel = Math.max(0, st.sel - 1);
          else if (name === 'down' || name === 'j') st.sel = Math.min(cache.length - 1, st.sel + 1);
          else if (name === 'pageup') st.sel = Math.max(0, st.sel - h);
          else if (name === 'pagedown') st.sel = Math.min(cache.length - 1, st.sel + h);
          else if (name === 'home') st.sel = 0;
          else if (name === 'end') st.sel = cache.length - 1;
          else if (name === 'right' || name === 'l' || name === 'return' || name === 'space') {
            if (node.dir) {
              if (name === 'space' || name === 'return') expanded.has(node.path) ? expanded.delete(node.path) : expanded.add(node.path);
              else expanded.add(node.path);
              refresh();
            } else if (name === 'return' || name === 'right' || name === 'l') {
              st.mode = 'graph';
              st.graphSel = 0;
            }
          } else if (name === 'left' || name === 'h') {
            if (node.dir && expanded.has(node.path)) expanded.delete(node.path);
            else {
              const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
              if (parent) {
                expanded.delete(parent);
                refresh();
                st.sel = Math.max(0, cache.findIndex((r) => r.node.path === parent));
              }
            }
            refresh();
          } else if (str === 'g' && !node.dir) {
            st.mode = 'graph';
            st.graphSel = 0;
          } else if (str === 'm') st.mode = 'map';
          else if (str === 'o') open(node.path, node.dir);
          else if (str === 'O') open('', true);
          else if (str === 'n' && st.matches.length) {
            st.matchIdx = (st.matchIdx + 1) % st.matches.length;
            selectPath(st.matches[st.matchIdx]);
            st.flash = `Match ${st.matchIdx + 1}/${st.matches.length}`;
          } else if (str === ']') st.detailTop += 5;
          else if (str === '[') st.detailTop = Math.max(0, st.detailTop - 5);
          else if (str === 'e') {
            const e = map.ranked.find((r) => r.entry);
            if (e) selectPath(e.path);
          }
          if (name === 'up' || name === 'down' || name === 'k' || name === 'j') st.detailTop = 0;
          break;
        case 'graph': {
          const n = st.graphItems?.length || 0;
          if (name === 'up' || name === 'k') st.graphSel = Math.max(0, st.graphSel - 1);
          else if (name === 'down' || name === 'j') st.graphSel = Math.min(Math.max(0, n - 1), st.graphSel + 1);
          else if ((name === 'return' || name === 'right') && n) {
            selectPath(st.graphItems[st.graphSel]);
            st.graphSel = 0;
          } else if (str === 'o') open(n ? st.graphItems[st.graphSel] : node.path, false);
          else if (name === 'left' || name === 'escape' || name === 'h') st.mode = 'browse';
          else if (str === 'm') st.mode = 'map';
          break;
        }
        case 'map':
          if (name === 'up' || name === 'k') st.mapSel = Math.max(0, st.mapSel - 1);
          else if (name === 'down' || name === 'j') st.mapSel = Math.min(map.modules.length - 1, st.mapSel + 1);
          else if (name === 'return' || name === 'right') {
            const mod = map.modules[st.mapSel].name;
            st.mode = 'browse';
            if (mod === '(root)') st.sel = 0;
            else {
              selectPath(mod);
              expanded.add(mod);
              refresh();
            }
          } else if (name === 'left' || name === 'escape' || str === 'm') st.mode = 'browse';
          break;
        case 'answer':
          if (name === 'up' || name === 'k') st.answer.scroll = Math.max(0, st.answer.scroll - 1);
          else if (name === 'down' || name === 'j') st.answer.scroll++;
          else if (name === 'pagedown' || name === 'space') st.answer.scroll += h;
          else if (name === 'pageup') st.answer.scroll = Math.max(0, st.answer.scroll - h);
          else if (name === 'left' || name === 'escape') st.mode = st.returnMode || 'browse';
          break;
      }
      draw();
    }

    function enter() {
      readline.emitKeypressEvents(inp);
      inp.setRawMode(true);
      inp.resume();
      out.write('\x1b[?1049h\x1b[?25l');
    }
    function leave() {
      out.write('\x1b[?25h\x1b[?1049l');
      inp.setRawMode(false);
    }
    function quit() {
      if (timer) clearInterval(timer);
      inp.removeListener('keypress', onKey);
      out.removeListener('resize', draw);
      leave();
      inp.pause();
      resolve();
    }

    enter();
    inp.on('keypress', onKey);
    out.on('resize', draw);
    draw();
  });
}
