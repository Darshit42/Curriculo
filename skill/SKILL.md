---
name: curriculo
description: Turn the current repository into a guided onboarding course — ordered lessons grounded in real files, code-based quizzes, and a committable LEARN.md. Use when the user wants to learn a codebase, onboard to this repo, understand where to start reading, or generate a course or LEARN.md.
---

# Curriculo — make a course for this repo

Curriculo's engine (ingest, rank, manifest, LEARN.md render) runs locally via
`scripts/run.js`. You — the host model — write the lessons and quizzes from the
ranked context the engine hands you. The output manifest uses the same schema as
the `curriculo` CLI, so courses from either are interchangeable.

Requires Node.js 18+. All commands take an optional repo path (default: the
current working directory). `SKILL_DIR` below is the directory containing this file.

## Steps

1. **Build the context pack.**
   ```bash
   node "$SKILL_DIR/scripts/run.js" context <repo-path>
   ```
   This ranks the repo's files (entry points, fan-in, path heuristics), skips
   `.gitignore`d and secret-looking files, and writes `.curriculo/context.json`
   containing the README excerpt, a directory overview, and the ranked teaching set
   with line-numbered excerpts. Read that file.

2. **Write the course** to `<repo-path>/.curriculo/course.json`:
   ```json
   {
     "repo": "<value of repo from context.json>",
     "summary": "One paragraph: what the project is, how it is organized, where to start.",
     "lessons": [
       {
         "title": "Where execution starts",
         "files": ["src/main.ts", "src/cli.ts"],
         "body": "Markdown, 250-450 words, grounded in the listed files.",
         "quiz": [
           { "q": "Which file parses CLI args?", "choices": ["src/cli.ts", "src/main.ts", "src/index.ts"], "answer": 0, "why": "src/cli.ts defines the arg parser." }
         ]
       }
     ]
   }
   ```
   Rules:
   - 5-8 lessons ordered **entry points → core abstractions and data flow → supporting modules → what trips newcomers up**.
   - `files` must come from the teaching set in `context.json` (1-4 per lesson). Open the files themselves if the excerpts are not enough.
   - Each body cites exact paths in backticks (e.g. `` `src/app.ts:42` ``), explains responsibilities and connections, uses at most `###` headings, and ends with a `**Watch out:**` line.
   - 1-2 multiple-choice questions per lesson, answerable from the code (which file/function does X, what happens when Y). `answer` is the 0-based index of the correct choice. No trivia.
   - Never invent files, functions or behavior.

3. **Validate and render.**
   ```bash
   node "$SKILL_DIR/scripts/run.js" finalize <repo-path>
   ```
   This fills in `id`, `order`, `generatedAt` and `model`, validates every lesson and
   quiz against the repo, and writes `LEARN.md`. If it reports errors, fix
   `course.json` and run it again.

4. **Summarize** for the user: the lesson list, and that they can take the course
   interactively with `npx github:Darshit42/Curriculo learn` or commit `LEARN.md` (badge:
   `npx github:Darshit42/Curriculo badge`).

## Alternative: BharatCode backend

If `BHARATCODE_API_KEY` is set (model and base URL have defaults),
the engine can generate the whole course itself:

```bash
node "$SKILL_DIR/scripts/run.js" gen <repo-path>
```

Add `--offline` for a heuristic course with no model at all.
