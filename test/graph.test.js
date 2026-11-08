import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { askAboutCode, askPrompt, buildCodeMap, ingest, mermaidModules, moduleOf, textModuleMap } from '../engine/index.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculo-graph-'));
  const files = {
    'package.json': JSON.stringify({ name: 'demo', main: 'src/app/index.js' }),
    'README.md': '# Demo\n\nA demo app used to test the code map and question answering.\n',
    'src/app/index.js': "import { route } from './router.js';\nimport { db } from '../data/db.js';\nexport function start() { return route(db); }\n",
    'src/app/router.js': "import { log } from '../util/log.js';\nexport function route(x) { log('r'); return x; }\n",
    'src/data/db.js': "import { log } from '../util/log.js';\nexport const db = {};\nlog('db');\n",
    'src/util/log.js': 'export function log(m) { console.log(m); }\n',
    'scripts/seed.js': "import { db } from '../src/data/db.js';\nconsole.log(db);\n",
    '.env': 'SECRET=1',
  };
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}

test('moduleOf groups src/<x> two levels deep, other folders one level', () => {
  assert.equal(moduleOf('src/app/index.js'), 'src/app');
  assert.equal(moduleOf('scripts/seed.js'), 'scripts');
  assert.equal(moduleOf('README.md'), '(root)');
  assert.equal(moduleOf('src/x.js'), 'src');
});

test('code map records imports in both directions, a folder tree, and module links', () => {
  const ing = ingest(repo());
  const map = buildCodeMap(ing);
  const log = map.files.get('src/util/log.js');
  assert.deepEqual([...log.importedBy].sort(), ['src/app/router.js', 'src/data/db.js']);
  assert.deepEqual(map.files.get('src/app/index.js').imports.sort(), ['src/app/router.js', 'src/data/db.js']);
  assert.ok(map.files.get('src/app/index.js').entry);
  assert.ok(!map.files.has('.env'), 'secrets never enter the map');

  const src = map.tree.children.find((c) => c.name === 'src');
  assert.ok(src.dir && src.fileCount === 4);
  assert.deepEqual(src.children.map((c) => c.name), ['app', 'data', 'util']);

  const edge = (a, b) => map.moduleEdges.find((e) => e.from === a && e.to === b)?.count;
  assert.equal(edge('src/app', 'src/data'), 1);
  assert.equal(edge('src/app', 'src/util'), 1);
  assert.equal(edge('scripts', 'src/data'), 1);
  assert.equal(edge('src/app', 'src/app'), undefined, 'no self-links');

  assert.match(textModuleMap(map), /src\/app\/ ──1──▶ src\/data\//);
  const mm = mermaidModules(map);
  assert.match(mm, /^flowchart LR/);
  assert.match(mm, /m_src_app -->\|1\| m_src_data/);
});

test('ask prompts are grounded in the selection and its neighbours', async () => {
  const ing = ingest(repo());
  const map = buildCodeMap(ing);
  const file = askPrompt({ ing, map, target: 'src/data/db.js', question: 'Who uses db?', repo: 'demo' });
  assert.match(file.user, /the file `src\/data\/db.js`/);
  assert.match(file.user, /Imported by: .*src\/app\/index.js/);
  assert.match(file.user, /--- src\/util\/log.js/, 'neighbour excerpt included');
  assert.match(file.user, /Who uses db\?$/);
  const folder = askPrompt({ ing, map, target: 'src/app', question: 'What is this?', repo: 'demo' });
  assert.match(folder.user, /the folder `src\/app\/`/);
  assert.match(folder.user, /- src\/app\/index.js/);
  const whole = askPrompt({ ing, map, question: 'Where do I start?', repo: 'demo' });
  assert.match(whole.user, /the whole repository/);
  assert.match(whole.user, /tiny|demo app/);
  for (const p of [file, folder, whole]) assert.ok(!p.user.includes('SECRET=1'));

  const client = { complete: async ({ user }) => `  answer for ${user.length > 0 ? 'ok' : ''}  ` };
  assert.equal(await askAboutCode({ client, ing, map, target: '', question: 'q', repo: 'demo' }), 'answer for ok');
});
