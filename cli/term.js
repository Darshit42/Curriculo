/** Shared terminal helpers for the course TUI and the explorer. */
import { spawn, spawnSync } from 'node:child_process';

export const A = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  inv: (s) => `\x1b[7m${s}\x1b[27m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  blue: (s) => `\x1b[34m${s}\x1b[39m`,
  magenta: (s) => `\x1b[35m${s}\x1b[39m`,
};

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Visible width of a string that may contain ANSI colour codes. */
export const visLen = (s) => [...stripAnsi(s)].length;

/** Pad (or cut) a possibly-coloured string to exactly `width` visible columns. */
export function fit(s, width) {
  const plain = stripAnsi(s);
  const len = [...plain].length;
  if (len <= width) return s + ' '.repeat(width - len);
  return [...plain].slice(0, Math.max(0, width - 1)).join('') + '…';
}

/** Word-wrap plain text to `width`, preserving blank lines and leading indent. */
export function wrap(text, width) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) {
      out.push('');
      continue;
    }
    const indent = raw.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)[0].replace(/[^\s]/g, ' ');
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if (!word) continue;
      if ((line + word).length > width && line.trim()) {
        out.push(line.trimEnd());
        line = indent + word.trimStart();
      } else line += word;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Light Markdown styling for one already-wrapped line. */
export function styleLine(line, state = {}) {
  if (/^\s*```/.test(line)) {
    state.code = !state.code;
    return A.dim(line);
  }
  if (state.code) return A.cyan(line);
  if (/^#{1,6}\s/.test(line)) return A.bold(line.replace(/^#{1,6}\s/, ''));
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => A.bold(t))
    .replace(/`([^`]+)`/g, (_, t) => A.cyan(t));
}

let cachedEditor;
export function editorCommand() {
  if (cachedEditor !== undefined) return cachedEditor;
  const ed = process.env.VISUAL || process.env.EDITOR;
  if (ed) return (cachedEditor = { cmd: ed, terminal: !/\b(code|cursor|subl|zed|idea|webstorm|atom|gedit|kate)\b/.test(ed) });
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const c of ['code', 'cursor']) {
    if (spawnSync(which, [c], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0) return (cachedEditor = { cmd: c, gui: true });
  }
  return (cachedEditor = null);
}

function systemOpen(abs) {
  const opener =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', abs]] : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/**
 * Open a file in the user's editor, or a folder in the editor / file manager.
 * leave/enter suspend and restore the TUI around terminal editors.
 * Returns a short status message for the UI.
 */
export function openPath(abs, label, { isDir = false, leave, enter } = {}) {
  const editor = editorCommand();
  if (isDir && (!editor || editor.terminal)) {
    systemOpen(abs);
    return `Opened ${label} in your file manager.`;
  }
  if (!editor) {
    systemOpen(abs);
    return `Opened ${label} with the system default app (set $EDITOR to choose).`;
  }
  if (editor.terminal) {
    leave?.();
    spawnSync(`${editor.cmd} "${abs}"`, { stdio: 'inherit', shell: true });
    enter?.();
    return `Back from ${label}.`;
  }
  const args = editor.gui && !isDir ? ['-g', `"${abs}"`] : [`"${abs}"`];
  spawn(`${editor.cmd} ${args.join(' ')}`, { detached: true, stdio: 'ignore', shell: true }).on('error', () => {}).unref();
  return `Opened ${label} in ${editor.cmd.split(/[\\/ ]/).filter(Boolean)[0]}.`;
}
