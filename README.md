# Curriculo

**Turn any Git repository into a guided, interactive course.** Point it at a repo, and Curriculo reads the code, orders the concepts, and produces a learning path: sequenced lessons tied to real files, quizzes drawn from the actual code, and a `LEARN.md` you can commit.

[![Course: LEARN.md](https://img.shields.io/badge/onboarding-LEARN.md-4c6ef5?logo=bookstack&logoColor=white)](LEARN.md)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

```bash
npx curriculo gen expressjs/express --learn
```

---

## Why

Ramping onto a large codebase is slow, and the first few weeks mostly cost a senior engineer's time answering the same questions. READMEs explain intent rather than structure, architecture docs are too abstract for a first change, and pasting the repo into a chat answers one question at a time with no path through the code.

Curriculo produces that **path**: an ordered walk through the parts that matter, tied to real files, that checks you understood each step. One command produces it, and the maintainer commits it, so every future contributor gets it for free.

## Quick start

```bash
# 1. Configure the BharatCode API (read from the environment only, never written to disk)
export BHARATCODE_API_KEY=...
export BHARATCODE_BASE_URL=https://<bharatcode-host>/v1
export BHARATCODE_MODEL=<model-id>

# 2. Generate a course for a public repo (shallow-cloned to ~/.curriculo/repos) or a local path
npx curriculo gen pallets/click
npx curriculo gen .

# 3. Take it
npx curriculo learn
```

No API key? `npx curriculo gen . --offline` builds a heuristic course with zero model calls. Its lessons come from file structure, doc comments and declarations, and its quizzes are checkable facts such as "which file defines `X`?"

## What you get

| Artifact | What it is |
| --- | --- |
| `LEARN.md` | Orientation, a course map, one section per lesson with linked files, and collapsible quizzes. It's readable on GitHub without the tool, and you commit it. |
| `.curriculo/course.json` | The manifest that `learn` and `LEARN.md` render from. It's the source of truth. |
| `.curriculo/progress.json` | Your own position and quiz answers, so you can resume anytime. It's gitignored. |
| `.curriculo/cache/` | Model responses keyed by content hash. Re-running on unchanged code costs no tokens. |

### The interactive course

```
 curriculo · github.com/expressjs/express                              1/6 done
2. The application object

Files (press the number to open in your editor):
  1  lib/application.js
  2  lib/express.js

 lib/express.js builds the app with createApplication(), mixing in the
 prototype from lib/application.js …

 Watch out: …

↑/↓ scroll · 1-9 open file · enter quiz · ← back · n/p next/prev · q quit
```

## Commands

| Command | Does |
| --- | --- |
| `curriculo gen <url-or-path>` | Ingest, rank, synthesize, then write `course.json` and `LEARN.md` |
| `curriculo learn [path]` | Interactive TUI: lesson list → lesson → quiz, with saved progress |
| `curriculo render [path]` | Re-render `LEARN.md` from the manifest, e.g. after hand edits |
| `curriculo rank <url-or-path>` | Show which files would be taught, and why |
| `curriculo badge` | Print the README badge that links to `LEARN.md` |

`gen` options: `--offline`, `--lessons <n>` (8), `--top <n>` teaching-set size (24), `--budget <tokens>` hard cap (250k), `--concurrency <n>` (4), `--out <dir>`, `--no-cache`, `--learn`.

## How it works

```
clone / read repo → build file tree → rank & select
                                          │
             ┌──────────── BharatCode API ▼ ────────────┐
             │ repo summary → lesson synthesis → quizzes │   (lessons run in parallel)
             └──────────────────────┬────────────────────┘
                                    ▼
                           .curriculo/course.json ──► LEARN.md
                                                  └─► interactive TUI
```

1. **Ingest.** It lists files with `git ls-files`, so `.gitignore` is honored, and skips binaries, lockfiles and vendored directories. It never reads secret-looking files (`.env*`, keys, certificates, `*credential*`, `*secret*`).
2. **Rank.** Each file is scored by declared entry points (`package.json` `main`/`bin`, `Cargo.toml`, `cmd/*/main.go`, Python package roots), regex-based import **fan-in** across JS/TS, Python, Go, Rust, JVM, C/C++ and Ruby, path heuristics (core vs. tests and examples), and size.
3. **Synthesize.** A short three-step prompt chain: (1) a repo summary and lesson outline from the tree, README and entry points, (2) each lesson written from *only its own files' excerpts*, (3) a quiz checked against that lesson's code. Files are cut down to signal regions (file head plus declarations, with line numbers) before they go into a prompt.
4. **Validate.** Every response is schema-checked. A lesson body must cite its files, and quiz answers must be valid indices. A bad response is retried once. If it fails again, that lesson degrades to an annotated file list instead of failing the run.

The token spend is printed after each run.

## Use it as a Claude skill

The same engine ships as a Claude skill in [`skill/`](skill/SKILL.md). Copy that folder into your skills directory (e.g. `~/.claude/skills/curriculo`) and ask Claude to *"make a course for this repo"*. The engine ranks the files and hands Claude a context pack. Claude writes the lessons, and the engine validates them and renders `LEARN.md`. Courses from the skill and the CLI are interchangeable.

## For maintainers

```bash
npx curriculo gen .        # review LEARN.md
git add LEARN.md .curriculo/course.json
npx curriculo badge        # paste into your README
```

Regenerate after a refactor. Unchanged files hit the cache.

## Privacy and safety

- Only the ranked, truncated file excerpts are sent to the model, never the whole working tree.
- `.gitignore` is respected, and secret-pattern files are never read or transmitted.
- The API key is read from the environment and is never written to the manifest, cache or `LEARN.md`.
- `curriculo learn` works fully offline from the local manifest.

## Development

```bash
npm test                 # node:test, no dependencies
node cli/index.js gen . --offline
```

```
engine/   ingest, rank, slice, prompts, synth, manifest, render (UI-less shared core)
cli/      command-line adapter and terminal UI
skill/    SKILL.md + scripts/run.js (Claude skill adapter)
test/     engine tests (fixture repo + mocked BharatCode API)
```

## Roadmap

- **v0.1:** `.curriculo.yml` include/exclude/pin, caching polish
- **v0.2:** framework presets, difficulty levels, tree-sitter symbol parsing
- **v1:** architecture diagrams, a hosted course viewer, and a GitHub Action that regenerates the course on merge

Curriculo's own onboarding course is in [LEARN.md](LEARN.md), generated by Curriculo.
