/**
 * Dump THIS repository's git-compressed commit-draft task into
 * `tests/fixtures/commit-draft-task.json` for offline testing/inspection.
 *
 * Runs the exact production pipeline the `git.commit-draft` route uses —
 * {@link buildCommitContext} (the -U0 hunks, --stat, porcelain status and
 * style refs, all capped) then {@link composeCommitDraftPrompt} — and records
 * the resulting task verbatim, plus before/after size metadata contrasting
 * the compressed patch with the -U3 diff this design replaced.
 *
 * Usage (from the repo root; requires a dirty working tree or staged index):
 *
 *   pnpm exec unrun scripts/dump-commit-draft-task.ts
 */
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import * as git from '../src/git.ts'
import {
  STAGED_DIFF_CAP,
  buildCommitContext,
  composeCommitDraftPrompt,
  resolveCommitTemplate,
} from '../src/agents/git-commit-agent.ts'
import { COMMIT_HISTORY_REFS_DEFAULT } from '../src/agents/commit-draft-shared.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const context = await buildCommitContext(repoRoot, COMMIT_HISTORY_REFS_DEFAULT)
if (context === null) {
  console.error('The index and working tree are both clean — nothing to dump. Make a change first.')
  process.exit(1)
}

const template = resolveCommitTemplate(undefined, undefined)
const prompt = composeCommitDraftPrompt(context, template.instructions)

// The -U3 diff this design replaced, measured for the size contrast only.
const uncompressed = await git.diff(repoRoot, undefined, context.source === 'staged')

const dump = {
  meta: {
    repo: basename(repoRoot),
    branch: context.branch,
    source: context.source,
    template: template.id,
    historyRefs: COMMIT_HISTORY_REFS_DEFAULT,
    generatedAt: new Date().toISOString(),
  },
  sizes: {
    diffCap: STAGED_DIFF_CAP,
    compressedPatchChars: context.patch.length,
    uncompressedPatchChars: uncompressed.length,
    statChars: context.stat.length,
    statusChars: context.status.length,
  },
  context,
  prompt,
}

const out = resolve(repoRoot, 'tests/fixtures/commit-draft-task.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${JSON.stringify(dump, null, 2)}\n`, 'utf8')

const ratio = uncompressed.length > 0 ? context.patch.length / uncompressed.length : 1
console.log(`dumped ${out}`)
console.log(
  `source=${context.source} files=${context.fileCount} +${context.insertions} −${context.deletions} `
  + `patch=${context.patch.length}/${uncompressed.length} chars (${(ratio * 100).toFixed(0)}%) `
  + `capped=${context.patchTruncated} statusCapped=${context.statusTruncated}`,
)