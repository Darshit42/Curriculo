import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  generateCourse,
  ingest,
  isRemote,
  isSecretPath,
  loadCourse,
  rankFiles,
  renderLearnMd,
  selectTeachingSet,
  validateCourse,
} from '../engine/index.js';
import { normalizeRemote } from '../engine/ingest.js';
import { extractSymbols, leadingDoc } from '../engine/slice.js';
import { validateBody, validateOutline, validateQuiz } from '../engine/synth.js';
import { parseJSONLoose } from '../engine/util.js';

/** A small fake repo: entry point, a core module imported by several files, a test, a secret. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculo-'));
  const files = {
    'package.json': JSON.stringify({ name: 'demo', main: 'src/index.js' }),
    'README.md': '# Demo\n\nDemo is a tiny task runner that loads a config, schedules jobs and reports results to the console.\n',
    'src/index.js': "import { loadConfig } from './config.js';\nimport { schedule } from './scheduler.js';\n\nexport function main() {\n  return schedule(loadConfig());\n}\n" + '// filler\n'.repeat(40),
    'src/config.js': "/** Loads and validates the runner configuration. */\nimport { log } from './log.js';\nexport function loadConfig() {\n  log('config');\n  return { jobs: [] };\n}\n" + '// filler\n'.repeat(40),
    'src/scheduler.js': "import { log } from './log.js';\nexport function schedule(cfg) {\n  log('schedule');\n  return cfg.jobs.map(runJob);\n}\nfunction runJob(j) { return j; }\n" + '// filler\n'.repeat(40),
    'src/log.js': "export function log(msg) {\n  console.log(msg);\n}\n" + '// filler\n'.repeat(40),
    'src/reporter.js': "import { log } from './log.js';\nexport class ConsoleReporter {\n  report(r) { log(r); }\n}\n" + '// filler\n'.repeat(40),
    'test/scheduler.test.js': "import { schedule } from '../src/scheduler.js';\nimport { log } from '../src/log.js';\n" + '// filler\n'.repeat(40),
    '.env': 'API_KEY=super-secret',
    'config/credentials.json': '{"token":"nope"}',
  };
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}

test('secret patterns are never ingested', () => {
  assert.ok(isSecretPath('.env'));
  assert.ok(isSecretPath('deploy/.env.production'));
  assert.ok(isSecretPath('keys/server.pem'));
  assert.ok(isSecretPath('config/credentials.json'));
  assert.ok(!isSecretPath('src/environment.ts'));
  const ing = ingest(fixture());
  const paths = ing.files.map((f) => f.path);
  assert.ok(!paths.includes('.env'));
  assert.ok(!paths.includes('config/credentials.json'));
  assert.ok(paths.includes('src/index.js'));
});

test('remote detection and normalization', () => {
  assert.ok(isRemote('https://github.com/expressjs/express'));
  assert.ok(isRemote('git@github.com:expressjs/express.git'));
  assert.ok(isRemote('definitely-not-a-dir/xyz'));
  assert.ok(!isRemote('.'));
  assert.deepEqual(normalizeRemote('git@github.com:a/b.git'), { url: 'https://github.com/a/b.git', id: 'github.com/a/b' });
  assert.equal(normalizeRemote('a/b').id, 'github.com/a/b');
});

test('ranking prefers the declared entry and the most-imported module, demotes tests', () => {
  const ing = ingest(fixture());
  const ranked = rankFiles(ing.files);
  const byPath = Object.fromEntries(ranked.map((r) => [r.path, r]));
  assert.ok(byPath['src/index.js'].entry, 'package.json main is an entry point');
  assert.ok(byPath['src/log.js'].fanIn >= 3, 'log.js is imported by three source files');
  assert.ok(byPath['test/scheduler.test.js'].score < byPath['src/reporter.js'].score);
  const teaching = selectTeachingSet(ranked).map((t) => t.path);
  assert.ok(!teaching.includes('test/scheduler.test.js'));
  assert.ok(teaching.includes('src/index.js'));
});

test('TS ESM imports with .js extensions resolve to .ts files; dist entries map to source', () => {
  const files = [
    { path: 'package.json', ext: 'json', lines: 1, content: JSON.stringify({ main: 'distribution/source/index.js' }) },
    { path: 'source/index.ts', ext: 'ts', lines: 50, content: "import { a } from './core/a.js';\nexport { a };\n" },
    { path: 'source/core/a.ts', ext: 'ts', lines: 50, content: 'export const a = 1;\n' },
    { path: 'test-d/a.ts', ext: 'ts', lines: 50, content: "import { a } from '../source/core/a.js';\n" },
  ];
  const ranked = Object.fromEntries(rankFiles(files).map((r) => [r.path, r]));
  assert.ok(ranked['source/index.ts'].entry);
  assert.ok(ranked['source/core/a.ts'].fanIn >= 1);
  assert.ok(ranked['test-d/a.ts'].reasons.includes('test'));
});

test('symbol and doc extraction', () => {
  const syms = extractSymbols("export function a() {}\nclass B {}\ndef c(x):\nfunc (s *S) D() {\nobj.e = function e() {}\n").map((s) => s.name);
  assert.deepEqual(syms, ['a', 'B', 'c', 'D', 'e']);
  assert.equal(leadingDoc('/*!\n * Copyright 2020 X\n */\n\n/**\n * Routes requests to handlers.\n */\n'), 'Routes requests to handlers.');
  assert.equal(leadingDoc('"""Parse command line options."""\nimport os'), 'Parse command line options.');
});

test('loose JSON parsing handles fences and chatter', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Sure! Here it is: {"a":2} hope that helps'), { a: 2 });
  assert.equal(parseJSONLoose('nope'), null);
});

test('model response validators', () => {
  const known = new Set(['src/a.js', 'src/b.js']);
  const outline = validateOutline(
    JSON.stringify({ summary: 'x'.repeat(50), lessons: [{ title: 'One', files: ['src/a.js', 'ghost.js'] }, { title: 'Two', files: ['./src/b.js'] }, { title: 'Ghost', files: ['ghost.js'] }] }),
    known,
    8,
  );
  assert.equal(outline.value.lessons.length, 2);
  assert.deepEqual(outline.value.lessons[0].files, ['src/a.js']);
  assert.ok(validateOutline('{}', known, 8).error);
  const lesson = { title: 'One', files: ['src/a.js'] };
  assert.ok(validateBody('too short', lesson).error);
  assert.ok(validateBody('words '.repeat(60), lesson).error, 'must cite a file');
  assert.ok(validateBody('`src/a.js` ' + 'words '.repeat(60), lesson).value);
  const quiz = validateQuiz(JSON.stringify({ quiz: [{ q: 'Which file?', choices: ['a', 'b'], answer: 1, why: 'b.' }, { q: 'bad', choices: ['a'], answer: 4 }] }));
  assert.equal(quiz.value.length, 1);
});

test('offline generation writes a valid manifest and LEARN.md', async () => {
  const dir = fixture();
  const r = await generateCourse({ source: dir, offline: true });
  assert.ok(fs.existsSync(path.join(dir, 'LEARN.md')));
  const course = loadCourse(dir);
  assert.deepEqual(validateCourse(course), []);
  assert.equal(course.lessons[0].title, 'Where execution starts');
  assert.ok(course.lessons[0].files.includes('src/index.js'));
  const allFiles = course.lessons.flatMap((l) => l.files);
  assert.ok(!allFiles.some((f) => f.includes('test')));
  const md = renderLearnMd(course);
  assert.match(md, /## Orientation/);
  assert.match(md, /<a id="lesson-1"><\/a>/);
  assert.match(md, /\[`src\/index.js`\]\(src\/index.js\)/);
  assert.ok(!md.includes('super-secret'));
  assert.equal(r.stats.tokens.calls, 0);
});

test('model generation via a mocked BharatCode API, with degradation and no key leakage', async () => {
  const dir = fixture();
  const fetchImpl = async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    let content;
    if (user.includes('ordered learning path')) {
      content = JSON.stringify({
        summary: 'Demo is a tiny task runner. src/index.js loads config and hands jobs to the scheduler.',
        lessons: [
          { title: 'Entry point', files: ['src/index.js'] },
          { title: 'Scheduling', files: ['src/scheduler.js', 'src/log.js'] },
        ],
      });
    } else if (user.includes('Write the lesson body')) {
      content = user.includes('Title: Scheduling') ? 'nope' : '`src/index.js` calls `main()` which wires config to the scheduler. ' + 'Detail. '.repeat(40);
    } else {
      content = JSON.stringify({ quiz: [{ q: 'Where is main defined?', choices: ['src/index.js', 'src/log.js', 'src/config.js'], answer: 0, why: 'src/index.js exports main.' }] });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  };
  const env = { BHARATCODE_API_KEY: 'sk-test-123', BHARATCODE_BASE_URL: 'https://mock/v1', BHARATCODE_MODEL: 'mock' };
  const r = await generateCourse({ source: dir, env, fetchImpl, useCache: false });
  const [one, two] = r.course.lessons;
  assert.equal(one.quiz.length, 1);
  assert.ok(!one.degraded);
  assert.ok(two.degraded, 'malformed lesson degrades instead of failing the run');
  assert.equal(two.quiz.length, 0);
  assert.ok(r.stats.tokens.calls >= 4);
  for (const f of [r.learnPath, r.manifestPath]) assert.ok(!fs.readFileSync(f, 'utf8').includes('sk-test-123'));
});

test('missing config fails fast with a helpful message', async () => {
  await assert.rejects(generateCourse({ source: fixture(), env: {} }), /BHARATCODE_API_KEY.*--offline/s);
});
