#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  ModelClient,
  STATE_DIR,
  askAboutCode,
  badgeMarkdown,
  buildCodeMap,
  generateCourse,
  mermaidModules,
  resolveProvider,
  textModuleMap,
  ingest,
  loadCourse,
  manifestPath,
  rankFiles,
  resolveSource,
  writeOutputs,
} from '../engine/index.js';
import { formatDuration, readJSON } from '../engine/util.js';
import { runTUI, printCourse } from './tui.js';
import { cmdLogin, cmdLogout, cmdProviders, cmdUse } from './providers-cmd.js';
import { runExplorer } from './explore.js';

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

${bold('Explore the code')}
  curriculo explore [path]           Visual explorer: folder tree, import graph, module map,
                                     open files/folders, and ask questions about any of them
  curriculo map [path]               Print the module map (--mermaid for a diagram, --json for data)
  curriculo ask "<question>" [path]  Ask about the repo (--about <file-or-folder> to focus)

${bold('Model providers')}
  curriculo login <provider> [key]   Save an API key locally (~/.curriculo/config.json)
  curriculo use <provider>           Make a provider the default (--model to pin a model)
  curriculo providers                List providers, saved keys and the active one
  curriculo logout <provider>        Remove a saved key
  Providers: bharatcode (default), anthropic, openai, gemini, openrouter, groq, ollama, custom

${bold('gen options')}
  --provider <name>    Model provider for this run (default: your saved choice, else BharatCode)
  --model <id>         Model id for this run
  --offline            Heuristic course, no model calls (no API key needed)
  --lessons <n>        Maximum lessons (default ${DEFAULTS.maxLessons})
  --top <n>            Size of the ranked teaching set (default ${DEFAULTS.top})
  --budget <tokens>    Hard token budget per run (default ${DEFAULTS.budget})
  --concurrency <n>    Parallel lesson calls (default ${DEFAULTS.concurrency})
  --out <dir>          Where to clone a remote repo (default ~/.curriculo/repos/...)
  --no-cache           Ignore cached model responses
  --learn              Open the course right after generating it

${bold('Environment')}
  BHARATCODE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
  OPENROUTER_API_KEY, GROQ_API_KEY   Keys (env vars win over saved keys)
  CURRICULO_PROVIDER / CURRICULO_MODEL  Override the provider / model
  CURRICULO_BASE_URL + CURRICULO_API_KEY  Endpoint and key for the "custom" provider
  CURRICULO_REASONING_EFFORT  Reasoning effort where supported (default low; Anthropic medium)

${bold('Examples')}
  npx github:Darshit42/Curriculo gen expressjs/express --learn
  npx github:Darshit42/Curriculo gen . --offline
  npx github:Darshit42/Curriculo gen . --provider anthropic
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
      provider: opts.provider,
      model: opts.model,
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
    out.push(`  ${dim('model')}   ${course.provider ? `${course.provider} · ` : ''}${course.model}`);
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

/** Ingest a repo and build its code map (plus the course, if one exists). */
function loadMap(target, opts) {
  let src;
  try {
    src = resolveSource(target || '.', { dest: opts.out, log: (m) => process.stderr.write(dim(`› ${m}\n`)) });
  } catch (err) {
    fail(err.message);
  }
  const ing = ingest(src.root);
  if (!ing.files.length) fail(`No readable source files found in ${src.root}`);
  const map = buildCodeMap(ing);
  let course = null;
  try {
    course = loadCourse(src.root);
  } catch {
    /* no course yet, or unreadable: the explorer still works */
  }
  return { src, ing, map, course };
}

function clientFor(root, opts) {
  const provider = resolveProvider({ provider: opts.provider, model: opts.model });
  return new ModelClient({ provider, cacheDir: path.join(root, STATE_DIR, 'cache'), useCache: !opts['no-cache'] });
}

async function cmdExplore(args, opts) {
  const { src, ing, map, course } = loadMap(args[0], opts);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(textModuleMap(map) + '\n');
    return;
  }
  let client;
  await runExplorer({
    map,
    ing,
    root: src.root,
    repoId: src.repoId,
    course,
    getClient: () => (client ??= clientFor(src.root, opts)),
  });
}

function cmdMap(args, opts) {
  const { src, map } = loadMap(args[0], opts);
  if (opts.json) {
    const files = [...map.files.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, int(opts.top, 'top') ?? 60)
      .map(({ path: p, lines, score, entry, reasons, module, imports, importedBy }) => ({ path: p, lines, score, entry, reasons, module, imports, importedBy }));
    process.stdout.write(JSON.stringify({ repo: src.repoId, modules: map.modules, moduleEdges: map.moduleEdges, files }, null, 2) + '\n');
  } else if (opts.mermaid) {
    process.stdout.write(mermaidModules(map) + '\n');
  } else {
    process.stdout.write(`${bold(src.repoId)} ${dim(`${map.files.size} files · ${map.edgeCount} import links`)}\n\n${textModuleMap(map)}\n`);
  }
}

async function cmdAsk(args, opts) {
  const question = args[0];
  if (!question) fail('Usage: curriculo ask "<question>" [repo-path] [--about <file-or-folder>]');
  const { src, ing, map, course } = loadMap(args[1], opts);
  const target = (opts.about || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  if (target && !map.files.has(target) && ![...map.files.keys()].some((p) => p.startsWith(target + '/'))) {
    fail(`"${target}" is not a file or folder Curriculo indexed in ${src.repoId}.`);
  }
  try {
    const client = clientFor(src.root, opts);
    process.stderr.write(dim(`› Asking ${client.label} about ${target || 'the whole repo'}…\n`));
    const answer = await askAboutCode({ client, ing, map, target, question, repo: src.repoId, summary: course?.summary });
    process.stdout.write(answer + '\n');
  } catch (err) {
    fail(err.message);
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
        provider: { type: 'string' },
        model: { type: 'string' },
        default: { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        json: { type: 'boolean' },
        mermaid: { type: 'boolean' },
        about: { type: 'string' },
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
    case 'explore':
      return cmdExplore(args, opts);
    case 'map':
      return cmdMap(args, opts);
    case 'ask':
      return cmdAsk(args, opts);
    case 'login':
      return cmdLogin(args, opts, fail);
    case 'logout':
      return cmdLogout(args, opts, fail);
    case 'use':
      return cmdUse(args, opts, fail);
    case 'providers':
      return void cmdProviders();
    case 'badge':
      return void process.stdout.write(badgeMarkdown() + '\n');
    default:
      fail(`Unknown command "${cmd}". Run ${cyan('curriculo --help')}.`);
  }
}

main();
