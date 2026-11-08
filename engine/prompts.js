/**
 * The three-step prompt chain: repo summary + outline, lesson synthesis,
 * quiz generation. Every prompt sees only a ranked, budgeted slice of the repo.
 */

const SYSTEM = `You are Curriculo, a senior engineer who writes onboarding courses for codebases.
You teach navigation and intent: where things live, how they connect, and what trips newcomers up.
You only state facts you can see in the provided files. You cite exact repo-relative paths.
Never invent files, functions, or behavior.`;

export function outlinePrompt({ repo, tree, ranked, docs, entrySlices, maxLessons }) {
  const user = `Repository: ${repo}

## Directory overview
${tree}

## Ranked candidate files (most important first)
${ranked.map((r) => `- ${r.path}  [${r.reasons.join(', ') || 'general'}]`).join('\n')}

## Key documents
${docs || '(none)'}

## Entry-point excerpts
${entrySlices || '(none)'}

## Task
Write a short orientation to this repository and design an ordered learning path of ${Math.max(3, maxLessons - 2)}-${maxLessons} lessons.
Order lessons so a newcomer goes: where execution starts -> core abstractions and data flow -> supporting modules -> the parts most likely to trip them up.
Each lesson covers 1-4 files, chosen ONLY from the ranked candidate list above. A file may appear in at most two lessons.

Respond with JSON only, no prose, in exactly this shape:
{
  "summary": "One paragraph (3-5 sentences): what the project is, how it is organized, and where to start reading.",
  "lessons": [
    { "title": "Short title (max 8 words)", "goal": "What the learner will understand after this lesson", "files": ["path/from/list.ext"] }
  ]
}`;
  return { system: SYSTEM, user, maxTokens: 1800 };
}

export function lessonPrompt({ repo, summary, lesson, index, total, outline, slices }) {
  const user = `Repository: ${repo}
Course orientation: ${summary}

Course outline (this is lesson ${index} of ${total}):
${outline.map((l, i) => `${i + 1}. ${l.title}`).join('\n')}

## This lesson
Title: ${lesson.title}
Goal: ${lesson.goal || ''}
Files: ${lesson.files.join(', ')}

## File excerpts (line-numbered)
${slices}

## Task
Write the lesson body in GitHub-flavored Markdown, 250-450 words.
- Ground every claim in the excerpts above. Reference files by exact path in backticks, e.g. \`${lesson.files[0]}\`, and name concrete functions/classes with line numbers where useful (e.g. \`handle()\` at \`${lesson.files[0]}:42\`).
- Explain what each file is responsible for, how it connects to the rest of the course, and the order to read it in.
- End with a "**Watch out:**" line naming one non-obvious detail a newcomer could get wrong.
- Use at most "###" headings. Do not include the lesson title. Do not wrap the answer in a code fence.`;
  return { system: SYSTEM, user, maxTokens: 1100 };
}

export function quizPrompt({ lesson, body, slices }) {
  const user = `## Lesson: ${lesson.title}
${body}

## File excerpts (line-numbered)
${slices}

## Task
Write 2 multiple-choice questions that check whether the learner understood THIS code.
- Each answer must be verifiable from the excerpts (which file does X, what a function returns or calls, which module owns a responsibility, what happens in a given case).
- No trivia about line counts, licenses or authors. No "all of the above".
- 3 or 4 choices each; distractors must be plausible names/paths from this repo.

Respond with JSON only:
{ "quiz": [ { "q": "Question?", "choices": ["A", "B", "C"], "answer": 0, "why": "One sentence citing the file that proves it." } ] }
"answer" is the 0-based index of the correct choice.`;
  return { system: SYSTEM, user, maxTokens: 700 };
}

export function retrySuffix(error) {
  return `\n\nYour previous response was rejected: ${error}. Follow the required format exactly.`;
}
