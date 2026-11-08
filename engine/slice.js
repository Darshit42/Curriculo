/**
 * Signal-region slicing: cut a file down to the parts that teach the most
 * (top of file, declarations, exports) so prompts stay within budget.
 */

const DECL_PATTERNS = [
  // JS / TS
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/, kind: 'export' },
  { re: /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/, kind: 'function' },
  { re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/, kind: 'type' },
  { re: /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'function' },
  { re: /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/, kind: 'export' },
  { re: /^(?:var\s+|const\s+|let\s+)?[A-Za-z_$][\w$]*(?:\.prototype)?\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/, kind: 'method' },
  // Python
  { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { re: /^\s{4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'method' },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
  // Go
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(\[]/, kind: 'function' },
  { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface|func|\w)/, kind: 'type' },
  // Rust
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl' },
  // Java / Kotlin / C# / Scala / Swift
  { re: /^\s*(?:public|private|protected|internal|open|sealed|data|final|static|abstract|\s)*\s*(?:class|interface|enum|record|object|struct|protocol)\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'method' },
  { re: /^\s*(?:override\s+|suspend\s+|private\s+|public\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: 'function' },
  // Ruby / Elixir / PHP
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'function' },
  { re: /^\s*(?:module|class)\s+([A-Z][\w:]*)/, kind: 'class' },
  { re: /^\s*defp?\s+([a-z_]\w*[?!]?)/, kind: 'function' },
  { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/, kind: 'function' },
  // C / C++
  { re: /^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s\*&:<>]*?\s\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: 'function' },
  { re: /^#define\s+([A-Z_][A-Z0-9_]+)/, kind: 'macro' },
];

const NOT_NAMES = new Set(['exports', 'prototype', 'module', 'if', 'for', 'while', 'switch', 'return', 'catch', 'else', 'new', 'sizeof', 'main']);

/** Extract top-level-ish declarations: [{ name, line (1-based), kind }]. */
export function extractSymbols(content, { limit = 200 } = {}) {
  const out = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    if (line.length > 300) continue;
    for (const { re, kind } of DECL_PATTERNS) {
      const m = line.match(re);
      if (m && m[1] && !NOT_NAMES.has(m[1])) {
        const key = `${m[1]}@${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name: m[1], line: i + 1, kind });
        }
        break;
      }
    }
  }
  return out;
}

const LICENSE_RE = /copyright|licen[cs]e|spdx|all rights reserved/i;

/** Read one comment block starting at line i; returns { text, next } or null. */
function commentAt(lines, i) {
  const first = lines[i] || '';
  const buf = [];
  if (/^\s*[rbu]?("""|''')/.test(first)) {
    const q = first.trim().replace(/^[rbu]/, '').slice(0, 3);
    let rest = first.trim().replace(/^[rbu]/, '').slice(3);
    for (;;) {
      const end = rest.indexOf(q);
      if (end !== -1) {
        buf.push(rest.slice(0, end));
        break;
      }
      buf.push(rest);
      if (++i >= lines.length) break;
      rest = lines[i];
    }
    return { text: buf, next: i + 1 };
  }
  if (/^\s*\/\*/.test(first)) {
    for (; i < lines.length; i++) {
      buf.push(lines[i].replace(/\*\/.*$/, '').replace(/^\s*\/\*[*!]?|^\s*\*\s?/g, ''));
      if (lines[i].includes('*/')) break;
    }
    return { text: buf, next: i + 1 };
  }
  if (/^\s*(\/\/|#(?!include|define|if|!|\[)|--)/.test(first)) {
    for (; i < lines.length && /^\s*(\/\/|#(?!include|define|if|!|\[)|--)/.test(lines[i]); i++) {
      buf.push(lines[i].replace(/^\s*(\/\/[\/!]?|#+|--)\s?/, ''));
    }
    return { text: buf, next: i };
  }
  return null;
}

/** Leading doc comment / docstring (skipping license headers), as one paragraph or ''. */
export function leadingDoc(content, maxChars = 300) {
  const lines = content.split(/\r?\n/);
  let i = 0;
  for (let blocks = 0; blocks < 4 && i < lines.length; blocks++) {
    while (i < lines.length && (/^#!/.test(lines[i]) || /^\s*$/.test(lines[i]) || /^\s*(['"])use strict\1/.test(lines[i]) || /coding[:=]/.test(lines[i]) || /^\s*package\s/.test(lines[i]))) i++;
    const c = commentAt(lines, i);
    if (!c) return '';
    i = c.next;
    const joined = c.text.join(' ');
    if (LICENSE_RE.test(joined)) continue;
    const text = c.text
      .map((x) => x.trim())
      .filter((x) => x && !/^(@|eslint|prettier|ts-|type:|noqa|pylint)/i.test(x))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 12 || /^module dependencies\.?$/i.test(text)) continue;
    return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text;
  }
  return '';
}

/**
 * Build a line-numbered excerpt: the head of the file plus every declaration
 * line (with one line of context), capped at `maxChars`.
 */
export function signalSlice(file, { maxChars = 3000, headLines = 30 } = {}) {
  const lines = file.content.split(/\r?\n/);
  const header = `--- ${file.path} (${lines.length} lines)\n`;
  if (file.content.length + header.length <= maxChars) {
    return header + lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
  }
  const keep = new Set();
  for (let i = 0; i < Math.min(headLines, lines.length); i++) keep.add(i);
  for (const s of extractSymbols(file.content)) {
    keep.add(s.line - 1);
    if (s.line < lines.length) keep.add(s.line);
  }
  const idx = [...keep].sort((a, b) => a - b);
  let out = header;
  let prev = -1;
  for (const i of idx) {
    if (prev !== -1 && i > prev + 1) out += '    | …\n';
    const row = `${String(i + 1).padStart(4)}| ${lines[i].slice(0, 200)}\n`;
    if (out.length + row.length > maxChars) {
      out += '    | … (truncated)\n';
      break;
    }
    out += row;
    prev = i;
  }
  return out.trimEnd();
}
