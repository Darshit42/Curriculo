/**
 * Curriculo engine: a UI-less library shared by the CLI and the Claude skill.
 * ingest -> rank -> synthesize (BharatCode or offline heuristics) -> manifest -> LEARN.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { ingest, resolveSource } from './ingest.js';
import { BharatCodeClient, configFromEnv, missingConfig } from './llm.js';
import { buildCourse, manifestPath, saveCourse, STATE_DIR, validateCourse } from './manifest.js';
import { offlineCourse } from './offline.js';
import { rankFiles, selectTeachingSet } from './rank.js';
import { renderLearnMd } from './render.js';
import { synthesizeWithModel } from './synth.js';

export { ingest, resolveSource, isRemote, isSecretPath, treeOverview } from './ingest.js';
export { rankFiles, selectTeachingSet } from './rank.js';
export { extractSymbols, leadingDoc, signalSlice } from './slice.js';
export { BharatCodeClient, BudgetError, configFromEnv, missingConfig } from './llm.js';
export * from './manifest.js';
export { renderLearnMd, badgeMarkdown } from './render.js';
export { offlineCourse } from './offline.js';

export const DEFAULTS = { maxLessons: 8, top: 24, budget: 250_000, concurrency: 4 };

/** Write the LEARN.md and keep local-only state out of the user's commits. */
export function writeOutputs(root, course) {
  saveCourse(root, course);
  const learnPath = path.join(root, 'LEARN.md');
  fs.writeFileSync(learnPath, renderLearnMd(course));
  const gi = path.join(root, STATE_DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'cache/\nprogress.json\ncontext.json\n');
  return { learnPath, manifestPath: manifestPath(root) };
}

/**
 * Generate a course for a local path or remote repo.
 * Returns { course, root, learnPath, manifestPath, stats }.
 */
export async function generateCourse({
  source = '.',
  dest,
  offline = false,
  maxLessons = DEFAULTS.maxLessons,
  top = DEFAULTS.top,
  budget = DEFAULTS.budget,
  concurrency = DEFAULTS.concurrency,
  useCache = true,
  env = process.env,
  fetchImpl,
  log = () => {},
} = {}) {
  const t0 = Date.now();

  let client;
  let model = 'offline-heuristic';
  if (!offline) {
    const cfg = configFromEnv(env);
    const missing = missingConfig(cfg);
    if (missing.length) {
      const e = new Error(`Missing ${missing.join(', ')}. Set them in your environment, or pass --offline for a heuristic course with no model calls.`);
      e.code = 'NO_CONFIG';
      throw e;
    }
    model = cfg.model;
    client = { cfg };
  }

  const src = resolveSource(source, { dest, log });
  log(`Reading ${src.root}`);
  const ing = ingest(src.root);
  if (!ing.files.length) throw new Error(`No readable source files found in ${src.root}`);
  const ranked = rankFiles(ing.files);
  const teaching = selectTeachingSet(ranked, { top });
  log(`Ranked ${ing.files.length} files; teaching set: ${teaching.length}`);

  let result;
  if (offline) {
    result = offlineCourse({ ing, ranked, teaching, maxLessons });
  } else {
    client = new BharatCodeClient({
      ...client.cfg,
      cacheDir: path.join(src.root, STATE_DIR, 'cache'),
      budget,
      useCache,
      fetchImpl,
    });
    result = await synthesizeWithModel({ repoId: src.repoId, ing, ranked, teaching, client, maxLessons, concurrency, log });
  }

  const stats = {
    files: ing.files.length,
    teachingSet: teaching.length,
    durationMs: Date.now() - t0,
    tokens: client?.usage
      ? { prompt: client.usage.prompt, completion: client.usage.completion, calls: client.usage.calls, cached: client.usage.cached }
      : { prompt: 0, completion: 0, calls: 0, cached: 0 },
    degradedLessons: result.lessons.filter((l) => l.degraded).length,
  };
  const course = buildCourse({ repo: src.repoId, model, summary: result.summary, lessons: result.lessons, stats });
  const errs = validateCourse(course, { knownFiles: new Set(ing.files.map((f) => f.path)) });
  if (errs.length) throw new Error(`Generated course failed validation:\n  - ${errs.join('\n  - ')}`);

  const paths = writeOutputs(src.root, course);
  return { course, root: src.root, remote: src.remote, ...paths, stats };
}
