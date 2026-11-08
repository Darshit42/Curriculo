import path from 'node:path';
import { readJSON, slugify, writeJSON } from './util.js';

export const MANIFEST_VERSION = 1;
export const STATE_DIR = '.curriculo';

export function manifestPath(root) {
  return path.join(root, STATE_DIR, 'course.json');
}

export function progressPath(root) {
  return path.join(root, STATE_DIR, 'progress.json');
}

/**
 * Validate one quiz question. Returns an error string or null.
 * Shape: { q, choices: string[2..5], answer: index, why }
 */
export function quizError(q) {
  if (!q || typeof q !== 'object') return 'question is not an object';
  if (typeof q.q !== 'string' || q.q.trim().length < 5) return 'missing question text "q"';
  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 5) return '"choices" must have 2-5 items';
  if (!q.choices.every((c) => typeof c === 'string' && c.trim())) return 'every choice must be a non-empty string';
  if (new Set(q.choices.map((c) => c.trim().toLowerCase())).size !== q.choices.length) return 'choices must be distinct';
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) return '"answer" must be a valid choice index';
  if (typeof q.why !== 'string' || !q.why.trim()) return 'missing explanation "why"';
  return null;
}

export function normalizeQuiz(q) {
  return {
    q: q.q.trim(),
    choices: q.choices.map((c) => c.trim()),
    answer: q.answer,
    why: q.why.trim(),
  };
}

/** Validate a lesson against the set of known repo files. Returns error strings. */
export function lessonErrors(lesson, knownFiles) {
  const errs = [];
  if (!lesson.title || typeof lesson.title !== 'string') errs.push('lesson missing title');
  if (!Array.isArray(lesson.files) || !lesson.files.length) errs.push(`lesson "${lesson.title}" has no files`);
  else if (knownFiles) {
    for (const f of lesson.files) if (!knownFiles.has(f)) errs.push(`lesson "${lesson.title}" references unknown file ${f}`);
  }
  if (typeof lesson.body !== 'string' || !lesson.body.trim()) errs.push(`lesson "${lesson.title}" has empty body`);
  if (!Array.isArray(lesson.quiz)) errs.push(`lesson "${lesson.title}" quiz must be an array`);
  else lesson.quiz.forEach((q, i) => {
    const e = quizError(q);
    if (e) errs.push(`lesson "${lesson.title}" quiz ${i + 1}: ${e}`);
  });
  return errs;
}

/** Validate a whole course manifest. Returns error strings (empty when valid). */
export function validateCourse(course, { knownFiles } = {}) {
  const errs = [];
  if (!course || typeof course !== 'object') return ['course is not an object'];
  for (const k of ['repo', 'generatedAt', 'model', 'summary']) {
    if (typeof course[k] !== 'string' || !course[k]) errs.push(`missing "${k}"`);
  }
  if (!Array.isArray(course.lessons) || !course.lessons.length) {
    errs.push('course has no lessons');
    return errs;
  }
  const ids = new Set();
  for (const l of course.lessons) {
    if (!l.id) errs.push(`lesson "${l.title}" missing id`);
    else if (ids.has(l.id)) errs.push(`duplicate lesson id ${l.id}`);
    ids.add(l.id);
    errs.push(...lessonErrors(l, knownFiles));
  }
  return errs;
}

export function lessonId(order, title) {
  return `${String(order).padStart(2, '0')}-${slugify(title, 32) || 'lesson'}`;
}

/** Assemble a manifest in the canonical field order. */
export function buildCourse({ repo, provider, model, summary, lessons, stats }) {
  return {
    version: MANIFEST_VERSION,
    repo,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(provider ? { provider } : {}),
    model,
    summary,
    lessons: lessons.map((l, i) => ({
      id: lessonId(i + 1, l.title),
      title: l.title,
      order: i + 1,
      files: l.files,
      body: l.body,
      quiz: (l.quiz || []).map(normalizeQuiz),
      ...(l.degraded ? { degraded: true } : {}),
    })),
    ...(stats ? { stats } : {}),
  };
}

export function loadCourse(root) {
  const course = readJSON(manifestPath(root));
  if (!course) return null;
  const errs = validateCourse(course);
  if (errs.length) {
    const e = new Error(`Invalid course manifest:\n  - ${errs.slice(0, 8).join('\n  - ')}`);
    e.errors = errs;
    throw e;
  }
  return course;
}

export function saveCourse(root, course) {
  writeJSON(manifestPath(root), course);
}
