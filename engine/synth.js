/**
 * Model-backed course synthesis: outline -> lessons (parallel) -> quizzes.
 * Every response is validated; a bad response is retried once, then the
 * lesson degrades to a file list without a quiz instead of failing the run.
 */
import { treeOverview } from './ingest.js';
import { BudgetError } from './llm.js';
import { quizError } from './manifest.js';
import { offlineLessonBody, offlineOutline } from './offline.js';
import { lessonPrompt, outlinePrompt, quizPrompt, retrySuffix } from './prompts.js';
import { signalSlice } from './slice.js';
import { parseJSONLoose, pool } from './util.js';

/** Call the model, validate, retry once with the validation error appended. */
async function callValidated(client, prompt, validate) {
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt ? prompt.user + retrySuffix(error) : prompt.user;
    const text = await client.complete({ system: prompt.system, user, maxTokens: prompt.maxTokens });
    const result = validate(text);
    if (!result.error) return result.value;
    error = result.error;
  }
  throw new Error(error);
}

export function validateOutline(text, known, maxLessons) {
  const data = parseJSONLoose(text);
  if (!data) return { error: 'response was not valid JSON' };
  if (typeof data.summary !== 'string' || data.summary.trim().length < 40) return { error: '"summary" missing or too short' };
  if (!Array.isArray(data.lessons)) return { error: '"lessons" must be an array' };
  const seenTitles = new Set();
  const lessons = [];
  for (const l of data.lessons) {
    if (!l || typeof l.title !== 'string' || !Array.isArray(l.files)) continue;
    const files = [...new Set(l.files.filter((f) => typeof f === 'string').map((f) => f.replace(/^\.?\//, '')))].filter((f) => known.has(f));
    const title = l.title.trim().replace(/^lesson\s*\d+[:.\-\s]*/i, '');
    if (!files.length || !title || seenTitles.has(title.toLowerCase())) continue;
    seenTitles.add(title.toLowerCase());
    lessons.push({ title, goal: typeof l.goal === 'string' ? l.goal.trim() : '', files: files.slice(0, 4) });
  }
  if (lessons.length < 2) return { error: 'fewer than 2 lessons referenced files from the candidate list' };
  return { value: { summary: data.summary.trim(), lessons: lessons.slice(0, maxLessons) } };
}

export function cleanBody(text, title) {
  let t = text.trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const lines = t.split('\n');
  if (/^#{1,3}\s/.test(lines[0]) && lines[0].toLowerCase().includes(title.toLowerCase().slice(0, 12))) lines.shift();
  // Demote any h1/h2 so the lesson nests under LEARN.md's own headings.
  return lines.map((l) => l.replace(/^#{1,2}\s/, '### ')).join('\n').trim();
}

export function validateBody(text, lesson) {
  const body = cleanBody(text, lesson.title);
  if (body.length < 200) return { error: 'lesson body is too short' };
  if (!lesson.files.some((f) => body.includes(f) || body.includes(f.split('/').pop()))) {
    return { error: `lesson body must reference at least one of: ${lesson.files.join(', ')}` };
  }
  return { value: body };
}

export function validateQuiz(text) {
  const data = parseJSONLoose(text);
  const raw = Array.isArray(data) ? data : data?.quiz;
  if (!Array.isArray(raw)) return { error: 'expected {"quiz": [...]}' };
  const good = raw.filter((q) => !quizError(q)).slice(0, 2);
  if (!good.length) return { error: `no valid questions (${quizError(raw[0]) || 'empty list'})` };
  return { value: good };
}

export async function synthesizeWithModel({ repoId, ing, ranked, teaching, client, maxLessons = 8, concurrency = 4, log = () => {} }) {
  const byPath = new Map(ing.files.map((f) => [f.path, f]));
  const rankByPath = new Map(ranked.map((r) => [r.path, r]));
  const known = new Set(teaching.map((t) => t.path));

  // 1. Repo summary + outline
  log('Outlining the course');
  const docs = ing.keyDocs
    .slice(0, 2)
    .map((d) => `--- ${d.path}\n${d.content.slice(0, 3000)}`)
    .join('\n\n');
  const entrySlices = teaching
    .filter((t) => t.entry)
    .slice(0, 4)
    .map((t) => signalSlice(byPath.get(t.path), { maxChars: 1500 }))
    .join('\n\n');
  let outline;
  try {
    outline = await callValidated(
      client,
      outlinePrompt({ repo: repoId, tree: treeOverview(ing.files), ranked: teaching, docs, entrySlices, maxLessons }),
      (text) => validateOutline(text, known, maxLessons),
    );
  } catch (err) {
    if (err instanceof BudgetError) throw err;
    log(`Outline response unusable (${err.message}); using the heuristic outline`);
    outline = offlineOutline({ ing, teaching, maxLessons });
  }

  // 2 + 3. Lessons and quizzes, concurrently per lesson
  let done = 0;
  const lessons = await pool(outline.lessons, concurrency, async (lesson, i) => {
    const per = Math.floor(9000 / lesson.files.length);
    const slices = lesson.files.map((p) => signalSlice(byPath.get(p), { maxChars: per })).join('\n\n');
    let body;
    let quiz = [];
    let degraded = false;
    try {
      body = await callValidated(
        client,
        lessonPrompt({ repo: repoId, summary: outline.summary, lesson, index: i + 1, total: outline.lessons.length, outline: outline.lessons, slices }),
        (text) => validateBody(text, lesson),
      );
    } catch (err) {
      log(`  lesson ${i + 1} degraded: ${err.message}`);
      body = offlineLessonBody(lesson, byPath, rankByPath);
      degraded = true;
    }
    if (!degraded) {
      try {
        quiz = await callValidated(client, quizPrompt({ lesson, body, slices }), validateQuiz);
      } catch (err) {
        log(`  lesson ${i + 1} quiz skipped: ${err.message}`);
      }
    }
    done++;
    log(`Lesson ${done}/${outline.lessons.length} ready: ${lesson.title}`);
    return { title: lesson.title, files: lesson.files, body, quiz, degraded };
  });

  return { summary: outline.summary, lessons };
}
