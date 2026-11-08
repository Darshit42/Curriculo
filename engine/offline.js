/**
 * Heuristic course generation with no model calls. Used by `--offline`, as the
 * outline fallback when the model's outline is unusable, and as the degraded
 * body for a lesson whose synthesis failed.
 */
import path from 'node:path';
import { extractSymbols, leadingDoc } from './slice.js';
import { shuffle } from './util.js';

const BORING = new Set([
  'init', '__init__', 'constructor', 'get', 'set', 'run', 'main', 'new', 'default', 'index',
  'test', 'setup', 'teardown', 'update', 'create', 'handle', 'start', 'stop', 'close', 'open',
  'read', 'write', 'call', 'apply', 'toString', 'String', 'Error', 'Config', 'Options',
]);

/** First prose paragraph of the README (skipping headings, badges, HTML). */
export function readmeBlurb(keyDocs, maxChars = 500) {
  const readme = keyDocs.find((d) => /^readme/i.test(d.path));
  if (!readme) return '';
  const paras = readme.content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim());
  for (const p of paras) {
    if (p.length < 60 || /^(#|!\[|<|\[!\[|\||>|-{3,}|={3,})/.test(p)) continue;
    const text = p.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    if (text.length < 60) continue;
    return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text;
  }
  return '';
}

function groupKey(p) {
  const parts = p.split('/');
  if (parts.length === 1) return '';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/** Split into evenly sized chunks of at most n (5 -> 3+2, not 4+1). */
function chunk(arr, n) {
  const parts = Math.ceil(arr.length / n);
  const size = Math.ceil(arr.length / parts);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Outline: entry points first, then directories in order of their best file. */
export function offlineOutline({ ing, teaching, maxLessons = 8 }) {
  const lessons = [];
  const entries = teaching.filter((t) => t.entry).slice(0, 3);
  if (entries.length) {
    lessons.push({
      title: 'Where execution starts',
      goal: 'Find the entry points and see what they wire together.',
      files: entries.map((e) => e.path),
    });
  }
  const used = new Set(entries.map((e) => e.path));
  const groups = new Map();
  for (const t of teaching) {
    if (used.has(t.path)) continue;
    const k = groupKey(t.path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1][0].score - a[1][0].score);
  for (const [dir, items] of ordered) {
    const parts = chunk(items.slice(0, 8), 4);
    const peripheral = items.every((t) => t.reasons.includes('peripheral'));
    parts.forEach((part) => {
      const label = dir ? `\`${dir}/\`` : 'top-level modules';
      const names = part.map((p) => `\`${path.posix.basename(p.path)}\``).join(', ');
      lessons.push({
        title: peripheral ? `Seeing it in use: ${label}` : parts.length > 1 ? `${label}: ${names}` : `Inside ${label}`,
        goal: `Understand what ${dir ? `${dir}/` : 'the top-level files'} is responsible for.`,
        files: part.map((p) => p.path),
      });
    });
  }
  const top = teaching[0]?.path;
  const blurb = readmeBlurb(ing.keyDocs);
  const langs = languageMix(ing.files);
  const summary = [
    blurb || `This repository contains ${ing.files.length} text files${langs ? `, mostly ${langs}` : ''}.`,
    entries.length
      ? `Execution starts in ${entries.map((e) => `\`${e.path}\``).join(', ')}.`
      : top
        ? `The most central file is \`${top}\`.`
        : '',
    `This course walks through ${Math.min(lessons.length, maxLessons)} lessons, from entry points to the most-imported modules.`,
  ]
    .filter(Boolean)
    .join(' ');
  return { summary, lessons: lessons.slice(0, maxLessons) };
}

export function languageMix(files) {
  const counts = new Map();
  for (const f of files) if (f.ext) counts.set(f.ext, (counts.get(f.ext) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => `.${e}`);
  return top.join(' and ');
}

/** Lesson body built from file facts: doc comment, signals, key definitions. */
export function offlineLessonBody(lesson, byPath, rankByPath) {
  const out = [];
  out.push(lesson.goal ? `${lesson.goal}\n` : '');
  for (const p of lesson.files) {
    const f = byPath.get(p);
    if (!f) continue;
    const r = rankByPath.get(p);
    const doc = leadingDoc(f.content);
    const syms = extractSymbols(f.content).filter((s) => !s.name.startsWith('_')).slice(0, 6);
    const why = r?.reasons?.length ? ` (${r.reasons.join(', ')})` : '';
    out.push(`**\`${p}\`** — ${f.lines} lines${why}.${doc ? ` ${doc}` : ''}`);
    if (syms.length) {
      out.push(`Key definitions: ${syms.map((s) => `\`${s.name}\` (${p}:${s.line})`).join(', ')}.`);
    }
    out.push('');
  }
  if (lesson.files.length > 1) {
    out.push(`Suggested reading order: ${lesson.files.map((p) => `\`${path.posix.basename(p)}\``).join(' → ')}.`);
  }
  return out.join('\n').trim();
}

/** Code-grounded questions answerable from the repo: who defines what, who is imported most. */
export function offlineQuiz(lesson, byPath, rankByPath, courseFiles) {
  const quiz = [];
  const definers = new Map();
  for (const p of courseFiles) {
    const f = byPath.get(p);
    if (!f) continue;
    for (const s of extractSymbols(f.content)) {
      if (!definers.has(s.name)) definers.set(s.name, new Set());
      definers.get(s.name).add(p);
    }
  }
  const others = courseFiles.filter((p) => !lesson.files.includes(p));
  for (const p of lesson.files) {
    if (quiz.length >= 1) break;
    const f = byPath.get(p);
    if (!f) continue;
    const sym = extractSymbols(f.content).find(
      (s) => s.name.length >= 4 && !s.name.startsWith('_') && !BORING.has(s.name) && definers.get(s.name)?.size === 1,
    );
    if (!sym || !others.length) continue;
    const ext = p.split('.').pop();
    const distractors = shuffle(
      [...others.filter((o) => o.endsWith(`.${ext}`)), ...others.filter((o) => !o.endsWith(`.${ext}`))].slice(0, 6),
      `${lesson.title}:${sym.name}`,
    ).slice(0, 3);
    const choices = shuffle([p, ...distractors], `${p}:${sym.name}`);
    quiz.push({
      q: `Which file defines \`${sym.name}\`?`,
      choices,
      answer: choices.indexOf(p),
      why: `\`${sym.name}\` is declared in \`${p}\` at line ${sym.line}.`,
    });
  }
  const withFan = lesson.files.map((p) => ({ p, fan: rankByPath.get(p)?.fanIn || 0 }));
  const max = Math.max(...withFan.map((x) => x.fan));
  if (withFan.length >= 2 && max > 0 && withFan.filter((x) => x.fan === max).length === 1) {
    const choices = shuffle(withFan.slice(0, 4).map((x) => x.p), `fan:${lesson.title}`);
    const best = withFan.find((x) => x.fan === max).p;
    if (choices.includes(best)) {
      quiz.push({
        q: 'Which of these files is imported by the most other files in the repo?',
        choices,
        answer: choices.indexOf(best),
        why: `\`${best}\` is imported by about ${Math.round(max)} other file(s), making it the most load-bearing of the set.`,
      });
    }
  }
  return quiz;
}

/** Full course without any model calls. */
export function offlineCourse({ ing, ranked, teaching, maxLessons }) {
  const byPath = new Map(ing.files.map((f) => [f.path, f]));
  const rankByPath = new Map(ranked.map((r) => [r.path, r]));
  const outline = offlineOutline({ ing, teaching, maxLessons });
  const courseFiles = [...new Set(outline.lessons.flatMap((l) => l.files))];
  const lessons = outline.lessons.map((l) => ({
    title: l.title,
    files: l.files,
    body: offlineLessonBody(l, byPath, rankByPath),
    quiz: offlineQuiz(l, byPath, rankByPath, courseFiles),
  }));
  return { summary: outline.summary, lessons };
}
