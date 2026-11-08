/**
 * Ask a question about the codebase, grounded in the selected file or folder
 * plus its import neighbours. Used by `curriculo explore`, `curriculo ask`, and the skill.
 */
import { treeOverview } from './ingest.js';
import { signalSlice } from './slice.js';

const SYSTEM = `You are Curriculo, a senior engineer helping a newcomer understand a codebase.
Answer ONLY from the provided excerpts. Cite exact repo-relative paths in backticks, with line numbers where the excerpt shows them (e.g. \`src/app.ts:42\`).
If the excerpts do not contain the answer, say so plainly and name the file(s) most likely to contain it.
Be concise: short paragraphs or bullets, no preamble.`;

/**
 * Build the grounded prompt.
 * target: '' (whole repo), a file path, or a folder path.
 */
export function askPrompt({ ing, map, target = '', question, repo, summary }) {
  const byPath = new Map(ing.files.map((f) => [f.path, f]));
  const slice = (p, maxChars) => (byPath.has(p) ? signalSlice(byPath.get(p), { maxChars }) : '');
  const parts = [];
  let scope;
  const info = map.files.get(target);
  if (info) {
    scope = `the file \`${target}\``;
    parts.push(`## Selected file\n${slice(target, 7000)}`);
    const conn = [
      `Imports: ${info.imports.length ? info.imports.join(', ') : '(none detected)'}`,
      `Imported by: ${info.importedBy.length ? info.importedBy.slice(0, 15).join(', ') : '(none detected)'}`,
    ];
    parts.push(`## Connections\n${conn.join('\n')}`);
    const neighbours = [...info.imports.slice(0, 3), ...info.importedBy.slice(0, 2)];
    if (neighbours.length) parts.push(`## Neighbouring files\n${neighbours.map((p) => slice(p, 1600)).join('\n\n')}`);
  } else if (target) {
    scope = `the folder \`${target}/\``;
    const inside = [...map.files.values()].filter((f) => f.path.startsWith(target + '/')).sort((a, b) => b.score - a.score);
    parts.push(`## Files in ${target}/ (most important first)\n${inside.slice(0, 40).map((f) => `- ${f.path} (${f.lines} lines${f.reasons.length ? `; ${f.reasons.join(', ')}` : ''})`).join('\n')}`);
    parts.push(`## Key files\n${inside.slice(0, 4).map((f) => slice(f.path, 2200)).join('\n\n')}`);
    const out = map.moduleEdges.filter((e) => target.startsWith(e.from) || e.from.startsWith(target));
    if (out.length) parts.push(`## Module connections\n${out.slice(0, 15).map((e) => `${e.from} -> ${e.to} (${e.count} imports)`).join('\n')}`);
  } else {
    scope = 'the whole repository';
    parts.push(`## Directory overview\n${treeOverview(ing.files)}`);
    parts.push(`## Module connections\n${map.moduleEdges.slice(0, 20).map((e) => `${e.from} -> ${e.to} (${e.count})`).join('\n') || '(none)'}`);
    const readme = ing.keyDocs.find((d) => /^readme/i.test(d.path));
    if (readme) parts.push(`## README (excerpt)\n${readme.content.slice(0, 2500)}`);
    parts.push(`## Most important files\n${map.ranked.slice(0, 4).map((r) => slice(r.path, 1800)).join('\n\n')}`);
  }
  const user = `Repository: ${repo}${summary ? `\nOrientation: ${summary}` : ''}

The question is about ${scope}.

${parts.join('\n\n')}

## Question
${question}`;
  return { system: SYSTEM, user, maxTokens: 1500 };
}

/** Run the question through a ModelClient; returns Markdown text. */
export async function askAboutCode({ client, ...rest }) {
  const prompt = askPrompt(rest);
  const text = await client.complete(prompt);
  return text.trim();
}
