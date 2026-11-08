/**
 * Dependency-free terminal UI: lesson list -> lesson view -> quiz, with
 * progress persisted to .curriculo/progress.json so a course can be resumed.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { progressPath } from '../engine/manifest.js';
import { readJSON, writeJSON } from '../engine/util.js';

const A = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  inv: (s) => `\x1b[7m${s}\x1b[27m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  blue: (s) => `\x1b[34m${s}\x1b[39m`,
};
const LETTERS = 'abcde';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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
function styleLine(line, state) {
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

function loadProgress(root, course) {
  const p = readJSON(progressPath(root), null);
  if (!p || typeof p !== 'object' || !p.lessons) return { course: course.generatedAt, lessons: {} };
  return p;
}

function editorCommand() {
  const ed = process.env.VISUAL || process.env.EDITOR;
  if (ed) return { cmd: ed, terminal: !/\b(code|cursor|subl|zed|idea|webstorm|atom|gedit|kate)\b/.test(ed) };
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const c of ['code', 'cursor']) {
    if (spawnSync(which, [c], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0) return { cmd: c, gui: true };
  }
  return null;
}

export function runTUI({ course, root }) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const progress = loadProgress(root, course);
    const save = () => writeJSON(progressPath(root), progress);
    const lessonState = (l) => (progress.lessons[l.id] ||= { done: false, answers: [] });
    const lessons = course.lessons;
    const firstOpen = lessons.findIndex((l) => !progress.lessons[l.id]?.done);
    const st = {
      screen: 'list',
      sel: firstOpen === -1 ? 0 : firstOpen,
      scroll: 0,
      qi: 0,
      picked: null,
      flash: firstOpen > 0 ? `Welcome back — resuming at lesson ${firstOpen + 1}.` : '',
    };
    let editor;

    const W = () => Math.max(40, Math.min(out.columns || 80, 110));
    const H = () => Math.max(12, out.rows || 24);

    function header(title) {
      const done = lessons.filter((l) => progress.lessons[l.id]?.done).length;
      const bar = `${done}/${lessons.length} done`;
      const left = ` curriculo · ${course.repo}`;
      const pad = Math.max(1, W() - left.length - bar.length - 1);
      return [A.inv(left + ' '.repeat(pad) + bar + ' '), title ? A.bold(title) : '', ''];
    }

    function footer(keys) {
      const lines = [''];
      if (st.flash) lines.push(A.yellow(st.flash));
      lines.push(A.dim(keys));
      return lines;
    }

    function drawList() {
      const head = header('Lessons');
      const rows = lessons.map((l, i) => {
        const ls = progress.lessons[l.id];
        const mark = ls?.done ? A.green('✓') : i === st.sel ? A.cyan('›') : ' ';
        const score = ls?.answers?.length ? A.dim(` ${ls.answers.filter((a) => a.correct).length}/${l.quiz.length}`) : '';
        const text = `${String(l.order).padStart(2)}. ${l.title.replace(/`/g, "")}`.slice(0, W() - 12);
        return ` ${mark} ${i === st.sel ? A.inv(text) : text}${score}`;
      });
      const foot = footer('↑/↓ move · enter open · r reset progress · q quit');
      const room = H() - head.length - foot.length;
      const start = Math.max(0, Math.min(st.sel - Math.floor(room / 2), rows.length - room));
      return [...head, ...rows.slice(start, start + room), ...foot];
    }

    function lessonLines(l) {
      const w = W() - 2;
      const lines = [];
      lines.push(A.dim('Files (press the number to open in your editor):'));
      l.files.slice(0, 9).forEach((f, i) => lines.push(`  ${A.yellow(String(i + 1))}  ${A.cyan(f)}`));
      lines.push('');
      const state = { code: false };
      for (const ln of wrap(l.body, w)) lines.push(' ' + styleLine(ln, state));
      lines.push('');
      lines.push(A.dim(l.quiz.length ? `— ${l.quiz.length} quiz question(s) follow. Press enter when ready. —` : '— No quiz for this lesson. Press enter to mark it done. —'));
      return lines;
    }

    function drawLesson() {
      const l = lessons[st.sel];
      const head = header(`${l.order}. ${l.title.replace(/`/g, "")}`);
      const body = lessonLines(l);
      const foot = footer('↑/↓ scroll · 1-9 open file · enter quiz · ← back · n/p next/prev · q quit');
      const room = H() - head.length - foot.length;
      st.scroll = Math.max(0, Math.min(st.scroll, body.length - room));
      const more = body.length > room ? A.dim(` (${Math.round(((st.scroll + room) / body.length) * 100)}%)`) : '';
      head[1] += more;
      return [...head, ...body.slice(st.scroll, st.scroll + room), ...foot];
    }

    function drawQuiz() {
      const l = lessons[st.sel];
      const q = l.quiz[st.qi];
      const head = header(`${l.order}. ${l.title} — question ${st.qi + 1}/${l.quiz.length}`);
      const w = W() - 4;
      const body = [];
      for (const ln of wrap(q.q, w)) body.push(' ' + styleLine(ln, {}));
      body.push('');
      q.choices.forEach((c, i) => {
        let line = `  ${A.yellow(LETTERS[i])}) ${styleLine(c, {})}`;
        if (st.picked !== null) {
          if (i === q.answer) line = `  ${A.green('✓')} ${A.green(stripAnsi(line).trim())}`;
          else if (i === st.picked) line = `  ${A.red('✗')} ${A.red(stripAnsi(line).trim())}`;
          else line = A.dim(line);
        }
        body.push(line);
      });
      body.push('');
      if (st.picked !== null) {
        body.push(st.picked === q.answer ? A.green(A.bold(' Correct!')) : A.red(A.bold(' Not quite.')));
        for (const ln of wrap(q.why, w)) body.push(' ' + styleLine(ln, {}));
      }
      const keys = st.picked === null ? `${LETTERS.slice(0, q.choices.length).split('').join('/')} answer · ← back to lesson · q quit` : 'enter continue · q quit';
      return [...head, ...body, ...footer(keys)];
    }

    function drawDone() {
      const l = lessons[st.sel];
      const ls = lessonState(l);
      const right = ls.answers.filter((a) => a.correct).length;
      const all = lessons.every((x) => progress.lessons[x.id]?.done);
      const body = [
        A.green(A.bold(` Lesson ${l.order} complete.`)) + (l.quiz.length ? `  Score: ${right}/${l.quiz.length}` : ''),
        '',
      ];
      if (all) {
        const total = lessons.reduce((n, x) => n + x.quiz.length, 0);
        const got = lessons.reduce((n, x) => n + (progress.lessons[x.id]?.answers || []).filter((a) => a.correct).length, 0);
        body.push(A.bold(` 🎓 You finished the course! Overall quiz score: ${got}/${total}.`));
        body.push(' You now know where to start reading and how the main pieces connect.');
      } else if (st.sel + 1 < lessons.length) {
        body.push(` Up next: ${A.bold(lessons[st.sel + 1].title)}`);
      }
      return [...header(''), ...body, ...footer(all ? 'enter back to list · q quit' : 'enter next lesson · ← lesson list · q quit')];
    }

    function draw() {
      const lines = { list: drawList, lesson: drawLesson, quiz: drawQuiz, done: drawDone }[st.screen]();
      out.write('\x1b[H\x1b[2J' + lines.slice(0, H()).join('\n'));
      st.flash = '';
    }

    function openFile(rel) {
      const abs = path.join(root, rel);
      editor ??= editorCommand() || false;
      if (!editor) {
        const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', abs]] : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
        spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        st.flash = `Opened ${rel} with the system default app (set $EDITOR to choose).`;
        return;
      }
      if (editor.terminal) {
        leave();
        spawnSync(`${editor.cmd} "${abs}"`, { stdio: 'inherit', shell: true });
        enter();
        st.flash = `Back from ${rel}.`;
      } else {
        const args = editor.gui ? ['-g', `"${abs}"`] : [`"${abs}"`];
        spawn(`${editor.cmd} ${args.join(' ')}`, { detached: true, stdio: 'ignore', shell: true }).on('error', () => {}).unref();
        st.flash = `Opened ${rel} in ${editor.cmd.split(/[\\/ ]/).filter(Boolean)[0]}.`;
      }
    }

    function finishLesson() {
      const ls = lessonState(lessons[st.sel]);
      ls.done = true;
      progress.last = lessons[st.sel].id;
      save();
      st.screen = 'done';
    }

    function startQuiz() {
      const l = lessons[st.sel];
      if (!l.quiz.length) return finishLesson();
      lessonState(l).answers = [];
      st.qi = 0;
      st.picked = null;
      st.screen = 'quiz';
    }

    function openLesson(i) {
      st.sel = Math.max(0, Math.min(lessons.length - 1, i));
      st.scroll = 0;
      st.screen = 'lesson';
      progress.last = lessons[st.sel].id;
      save();
    }

    function onKey(str, key = {}) {
      if (key.ctrl && key.name === 'c') return quit();
      const name = key.name || str;
      if (name === 'q' && st.screen !== 'quiz') return quit();
      if (name === 'q' && st.picked !== null) return quit();
      const room = H() - 6;
      switch (st.screen) {
        case 'list':
          if (name === 'up' || name === 'k') st.sel = Math.max(0, st.sel - 1);
          else if (name === 'down' || name === 'j') st.sel = Math.min(lessons.length - 1, st.sel + 1);
          else if (name === 'return' || name === 'right' || name === 'l') openLesson(st.sel);
          else if (name === 'r') {
            progress.lessons = {};
            save();
            st.flash = 'Progress reset.';
          }
          break;
        case 'lesson': {
          const l = lessons[st.sel];
          if (name === 'up' || name === 'k') st.scroll = Math.max(0, st.scroll - 1);
          else if (name === 'down' || name === 'j') st.scroll += 1;
          else if (name === 'pageup' || name === 'b') st.scroll = Math.max(0, st.scroll - room);
          else if (name === 'pagedown' || name === 'space') st.scroll += room;
          else if (name === 'left' || name === 'escape' || name === 'h') st.screen = 'list';
          else if (name === 'n') openLesson(st.sel + 1);
          else if (name === 'p') openLesson(st.sel - 1);
          else if (name === 'return') startQuiz();
          else if (/^[1-9]$/.test(str || '') && l.files[Number(str) - 1]) openFile(l.files[Number(str) - 1]);
          break;
        }
        case 'quiz': {
          const l = lessons[st.sel];
          const q = l.quiz[st.qi];
          if (st.picked === null) {
            const idx = LETTERS.indexOf((str || '').toLowerCase());
            const num = Number.parseInt(str, 10) - 1;
            const pick = idx >= 0 ? idx : num;
            if (Number.isInteger(pick) && pick >= 0 && pick < q.choices.length) {
              st.picked = pick;
              lessonState(l).answers[st.qi] = { picked: pick, correct: pick === q.answer };
              save();
            } else if (name === 'left' || name === 'escape') {
              st.screen = 'lesson';
            }
          } else if (name === 'return' || name === 'space' || name === 'right') {
            st.picked = null;
            if (st.qi + 1 < l.quiz.length) st.qi++;
            else finishLesson();
          }
          break;
        }
        case 'done':
          if (name === 'left' || name === 'escape') st.screen = 'list';
          else if (name === 'return' || name === 'right') {
            if (st.sel + 1 < lessons.length && !lessons.every((x) => progress.lessons[x.id]?.done)) openLesson(st.sel + 1);
            else st.screen = 'list';
          }
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
      inp.removeListener('keypress', onKey);
      out.removeListener('resize', draw);
      leave();
      inp.pause();
      save();
      const done = lessons.filter((l) => progress.lessons[l.id]?.done).length;
      out.write(`Progress saved: ${done}/${lessons.length} lessons done. Resume with \`curriculo learn\`.\n`);
      resolve();
    }

    enter();
    inp.on('keypress', onKey);
    out.on('resize', draw);
    draw();
  });
}

/** Non-interactive fallback (piped output): print the course as plain text. */
export function printCourse(course) {
  const out = [`${course.repo}\n`, course.summary, ''];
  for (const l of course.lessons) {
    out.push(`## ${l.order}. ${l.title}`, `Files: ${l.files.join(', ')}`, '', l.body, '');
    l.quiz.forEach((q, i) => {
      out.push(`Q${i + 1}. ${q.q}`);
      q.choices.forEach((c, ci) => out.push(`   ${LETTERS[ci]}) ${c}`));
      out.push(`   answer: ${LETTERS[q.answer]} — ${q.why}`, '');
    });
  }
  process.stdout.write(out.join('\n') + '\n');
}
