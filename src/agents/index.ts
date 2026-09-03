/** Host-facing exports for better-sidebar's specialized agents. */
export * from './commit-draft-shared.ts'
export {
  COMMIT_DRAFT_TIMEOUT_MS,
  LLM_PROBE_TIMEOUT_MS,
  COMMIT_TEMPLATES as COMMIT_AGENT_TEMPLATES,
  STAGED_DIFF_CAP,
  WORKTREE_STATUS_CAP,
  buildCommitContext,
  catalogOf,
  composeCommitDraftPrompt,
  draftCommitMessage,
  probeLlmConnection,
  resolveCommitTemplate,
} from './git-commit-agent.ts'
export type {
  CommitDraftContext,
  CommitDraftPrompt,
  CommitDraftSource,
  CommitTemplate,
} from './git-commit-agent.ts'
