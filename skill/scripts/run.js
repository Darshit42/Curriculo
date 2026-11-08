#!/usr/bin/env node
/**
 * Entry point the Claude skill calls. Subcommands:
 *   context [path]            write .curriculo/context.json for the host model
 *   finalize [path]           validate .curriculo/course.json and render LEARN.md
 *   gen [path] [--offline]    full engine run (BharatCode or offline heuristics)
 *   map [path]                module map + import graph -> .curriculo/map.json, text + Mermaid
 *   focus <file|folder> [path]  grounded excerpts + connections for one file or folder
 *   ask "<question>" [path] [--about=<file|folder>]  answer via the configured provider
 */
import path from 'node:path';
import {
  ModelClient,
  askAboutCode,
  askPrompt,
  buildCodeMap,
  loadCourse,
  mermaidModules,
  resolveProvider,
  textModuleMap,
  buildCourse,
  generateCourse,
  ingest,
  manifestPath,
  rankFiles,
  resolveSource,
  selectTeachingSet,
  signalSlice,
  treeOverview,
  validateCourse,
  writeOutputs,
} from '../../engine/index.js';
import { readmeBlurb } from '../../engine/offline.js';
import { readJSON, writeJSON } from '../../engine/util.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const target = rest.find((a) => !a.startsWith('--')) || '.';

function die(msg) {
  process.stderr.write(`curriculo-skill: ${msg}\n`);
  process.exit(1);
}

function context() {
  const src = resolveSource(target);
  const ing = ingest(src.root);
  if (!ing.files.length) die(`no readable source files in ${src.root}`);
  const ranked = rankFiles(ing.files);
  const teaching = selectTeachingSet(ranked, { top: 20 });
  const byPath = new Map(ing.files.map((f) => [f.path, f]));
  const readme = ing.keyDocs.find((d) => /^readme/i.test(d.path));
  const pack = {
    repo: src.repoId,
    root: src.root,
    readmeBlurb: readmeBlurb(ing.keyDocs),
    readme: readme ? readme.content.slice(0, 4000) : '',
    tree: treeOverview(ing.files),
    teachingSet: teaching.map((t) => ({
      path: t.path,
      entry: t.entry,
      reasons: t.reasons,
      excerpt: signalSlice(byPath.get(t.path), { maxChars: 1800 }),
    })),
  };
  const out = path.join(src.root, '.curriculo', 'context.json');
  writeJSON(out, pack);
  process.stdout.write(
    `Wrote ${out}\nrepo: ${src.repoId}\nfiles scanned: ${ing.files.length}\nteaching set (${teaching.length}):\n` +
      teaching.map((t) => `  - ${t.path}${t.entry ? ' [entry]' : ''}`).join('\n') +
      `\nNext: write ${manifestPath(src.root)} then run: node run.js finalize "${src.root}"\n`,
  );
}

function finalize() {
  const root = path.resolve(target);
  const draft = readJSON(manifestPath(root));
  if (!draft) die(`could not read ${manifestPath(root)} — write the course JSON there first`);
  const ing = ingest(root);
  const known = new Set(ing.files.map((f) => f.path));
  const lessons = (draft.lessons || []).map((l) => ({
    ...l,
    files: (l.files || []).map((f) => String(f).replace(/^\.?\//, '')),
    quiz: l.quiz || [],
  }));
  const course = buildCourse({
    repo: draft.repo || readJSON(path.join(root, '.curriculo', 'context.json'), {}).repo || path.basename(root),
    model: draft.model || 'claude-skill',
    summary: draft.summary,
    lessons,
  });
  const errs = validateCourse(course, { knownFiles: known });
  if (errs.length) die(`course.json has ${errs.length} problem(s):\n  - ${errs.join('\n  - ')}`);
  const { learnPath } = writeOutputs(root, course);
  process.stdout.write(`Course valid: ${course.lessons.length} lessons, ${course.lessons.reduce((n, l) => n + l.quiz.length, 0)} quiz questions.\nWrote ${learnPath}\n`);
}

async function gen() {
  try {
    const r = await generateCourse({ source: target, offline: flags.has('--offline'), log: (m) => process.stderr.write(`› ${m}\n`) });
    process.stdout.write(`Wrote ${r.learnPath}\n${r.course.lessons.map((l) => `${l.order}. ${l.title}`).join('\n')}\n`);
  } catch (err) {
    die(err.message);
  }
}

const positionals = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const clean = (p) => (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');

function loadRepo(where) {
  const src = resolveSource(where || '.');
  const ing = ingest(src.root);
  if (!ing.files.length) die(`no readable source files in ${src.root}`);
  let course = null;
  try {
    course = loadCourse(src.root);
  } catch {
    /* no course yet */
  }
  return { src, ing, map: buildCodeMap(ing), course };
}

function mapCmd() {
  const { src, map } = loadRepo(target);
  const files = [...map.files.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .map(({ path: p, lines, score, entry, reasons, module, imports, importedBy }) => ({ path: p, lines, score, entry, reasons, module, imports, importedBy }));
  const out = path.join(src.root, '.curriculo', 'map.json');
  writeJSON(out, { repo: src.repoId, modules: map.modules, moduleEdges: map.moduleEdges, files });
  process.stdout.write(
    `repo: ${src.repoId} · ${map.files.size} files · ${map.edgeCount} import links\nWrote ${out} (top ${files.length} files with imports/importedBy)\n\n` +
      `${textModuleMap(map)}\n\nMermaid:\n\`\`\`mermaid\n${mermaidModules(map)}\n\`\`\`\n`,
  );
}

function focusCmd() {
  const [what, where] = positionals;
  if (!what) die('usage: run.js focus <file-or-folder> [repo-path]');
  const { src, ing, map, course } = loadRepo(where);
  const t = clean(what);
  if (t && !map.files.has(t) && ![...map.files.keys()].some((p) => p.startsWith(t + '/'))) die(`"${t}" is not an indexed file or folder`);
  const prompt = askPrompt({ ing, map, target: t, question: '(answer the user’s question from the material above)', repo: src.repoId, summary: course?.summary });
  process.stdout.write(prompt.user + '\n');
}

async function askCmd() {
  const [question, where] = positionals;
  if (!question) die('usage: run.js ask "<question>" [repo-path] [--about=<file-or-folder>]');
  const { src, ing, map, course } = loadRepo(where);
  try {
    const provider = resolveProvider({});
    const client = new ModelClient({ provider, cacheDir: path.join(src.root, '.curriculo', 'cache') });
    const answer = await askAboutCode({ client, ing, map, target: clean(flagValue('about')), question, repo: src.repoId, summary: course?.summary });
    process.stdout.write(answer + '\n');
  } catch (err) {
    die(err.message);
  }
}

switch (cmd) {
  case 'context':
    context();
    break;
  case 'map':
    mapCmd();
    break;
  case 'focus':
    focusCmd();
    break;
  case 'ask':
    await askCmd();
    break;
  case 'finalize':
    finalize();
    break;
  case 'gen':
    await gen();
    break;
  default:
    process.stdout.write('usage: run.js <context|finalize|gen|map|focus|ask> ...  (see SKILL.md)\n');
}
