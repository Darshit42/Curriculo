#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  badgeMarkdown,
  generateCourse,
  ingest,
  loadCourse,
  manifestPath,
  rankFiles,
  resolveSource,
  writeOutputs,
} from '../engine/index.js';
import { formatDuration, readJSON } from '../engine/util.js';
import { runTUI, printCourse } from './tui.js';

const pkg = readJSON(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), {});
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');

const HELP = `${bold('curriculo')} ${pkg.version || ''} — turn any Git repo into a guided course

${bold('Usage')}
  curriculo gen <repo-url-or-path>   Generate .curriculo/course.json and LEARN.md
  curriculo learn [path]             Take the course in an interactive terminal UI
  curriculo render [path]            Re-render LEARN.md from the course manifest
  curriculo rank <repo-url-or-path>  Show which files Curriculo would teach, and why
  curriculo badge                    Print a README badge linking to LEARN.md

${bold('gen options')}
  --offline            Heuristic course, no model calls (no API key needed)
  --lessons <n>        Maximum lessons (default ${DEFAULTS.maxLessons})
  --top <n>            Size of the ranked teaching set (default ${DEFAULTS.top})
  --budget <tokens>    Hard token budget per run (default ${DEFAULTS.budget})
  --concurrency <n>    Parallel lesson calls (default ${DEFAULTS.concurrency})
  --out <dir>          Where to clone a remote repo (default ~/.curriculo/repos/...)
  --no-cache           Ignore cached model responses
  --learn              Open the course right after generating it

${bold('Environment')}
  BHARATCODE_API_KEY   API key from https://bharatcode.ai/account (env only; never written to disk)
  BHARATCODE_MODEL     Model id (default qwen-3.8-27b; deepseek-v4.1-flash on Pro)
  BHARATCODE_BASE_URL  API base URL (default https://bharatcode.ai/api/model/v1)
  BHARATCODE_REASONING_EFFORT  none, low, medium or high (default low)

${bold('Examples')}
  npx github:Darshit42/Curriculo gen expressjs/express --learn
  npx github:Darshit42/Curriculo gen . --offline
  npx github:Darshit42/Curriculo learn
`;

function fail(msg, code = 1) {
  process.stderr.write(`${red('error')} ${msg}\n`);
  process.exit(code);
}

function int(v, name) {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive integer`);
  return n;
}

function findCourseRoot(start) {
  let dir = path.resolve(start || '.');
  for (;;) {
    if (fs.existsSync(manifestPath(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function cmdGen(args, opts) {
  const source = args[0] || '.';
  const started = Date.now();
  const log = (m) => process.stderr.write(`${dim('›')} ${m}\n`);
  let result;
  try {
    result = await generateCourse({
      source,
      dest: opts.out,
      offline: opts.offline,
      maxLessons: int(opts.lessons, 'lessons') ?? DEFAULTS.maxLessons,
      top: int(opts.top, 'top') ?? DEFAULTS.top,
      budget: int(opts.budget, 'budget') ?? DEFAULTS.budget,
      concurrency: int(opts.concurrency, 'concurrency') ?? DEFAULTS.concurrency,
      useCache: !opts['no-cache'],
      log,
    });
  } catch (err) {
    fail(err.message);
  }
  const { course, stats } = result;
  const out = [];
  out.push('');
  out.push(`${green('✔')} ${bold(`Course ready for ${course.repo}`)} ${dim(`(${formatDuration(Date.now() - started)})`)}`);
  out.push('');
  for (const l of course.lessons) {
    const q = l.quiz.length ? dim(`${l.quiz.length}q`) : dim('—');
    out.push(`  ${String(l.order).padStart(2)}. ${l.title} ${q}${l.degraded ? ' ' + dim('(file list only)') : ''}`);
  }
  out.push('');
  const t = stats.tokens;
  if (course.model === 'offline-heuristic') {
    out.push(`  ${dim('model')}   offline heuristics (0 tokens)`);
  } else {
    out.push(`  ${dim('model')}   ${course.model}`);
    out.push(`  ${dim('tokens')}  ${(t.prompt + t.completion).toLocaleString()} spent (${t.prompt.toLocaleString()} in / ${t.completion.toLocaleString()} out) · ${t.calls} calls · ${t.cached} cached`);
  }
  out.push(`  ${dim('wrote')}   ${result.learnPath}`);
  out.push(`          ${result.manifestPath}`);
  out.push('');
  out.push(`  Next: ${cyan(result.remote ? `cd "${result.root}" && npx github:Darshit42/Curriculo learn` : 'npx github:Darshit42/Curriculo learn')}`);
  out.push(`  Maintainers: commit LEARN.md and add the badge → ${cyan('npx github:Darshit42/Curriculo badge')}`);
  process.stdout.write(out.join('\n') + '\n');
  if (opts.learn) await cmdLearn([result.root]);
}

async function cmdLearn(args) {
  const root = findCourseRoot(args[0]);
  if (!root) fail(`No course found. Generate one first: ${cyan('npx github:Darshit42/Curriculo gen .')}`);
  let course;
  try {
    course = loadCourse(root);
  } catch (err) {
    fail(err.message);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printCourse(course);
    return;
  }
  await runTUI({ course, root });
}

function cmdRender(args) {
  const root = findCourseRoot(args[0]);
  if (!root) fail('No .curriculo/course.json found.');
  let course;
  try {
    course = loadCourse(root);
  } catch (err) {
    fail(err.message);
  }
  const { learnPath } = writeOutputs(root, course);
  process.stdout.write(`${green('✔')} Rendered ${learnPath}\n`);
}

function cmdRank(args, opts) {
  let src;
  try {
    src = resolveSource(args[0] || '.', { dest: opts.out, log: (m) => process.stderr.write(dim(`› ${m}\n`)) });
  } catch (err) {
    fail(err.message);
  }
  const ing = ingest(src.root);
  const ranked = rankFiles(ing.files).slice(0, int(opts.top, 'top') ?? 30);
  process.stdout.write(`${bold(src.repoId)} ${dim(`${ing.files.length} files`)}\n\n`);
  for (const r of ranked) {
    process.stdout.write(`${String(r.score.toFixed(2)).padStart(6)}  ${r.entry ? green(r.path) : r.path}  ${dim(r.reasons.join(', '))}\n`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        offline: { type: 'boolean' },
        lessons: { type: 'string' },
        top: { type: 'string' },
        budget: { type: 'string' },
        concurrency: { type: 'string' },
        out: { type: 'string' },
        'no-cache': { type: 'boolean' },
        learn: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${err.message}\nRun ${cyan('curriculo --help')} for usage.`);
  }
  const { values: opts, positionals } = parsed;
  const [cmd, ...args] = positionals;
  if (opts.version) return void process.stdout.write(`${pkg.version}\n`);
  if (opts.help || !cmd || cmd === 'help') return void process.stdout.write(HELP);
  switch (cmd) {
    case 'gen':
    case 'generate':
      return cmdGen(args, opts);
    case 'learn':
      return cmdLearn(args);
    case 'render':
      return cmdRender(args);
    case 'rank':
      return cmdRank(args, opts);
    case 'badge':
      return void process.stdout.write(badgeMarkdown() + '\n');
    default:
      fail(`Unknown command "${cmd}". Run ${cyan('curriculo --help')}.`);
  }
}

main();
