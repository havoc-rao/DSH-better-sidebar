/** Scratch-profile-only data seed. No LLM, command execution or production routes. */
export const name = 'fixture-code-block-run'
export const inject = ['agents']
const SESSION_ID = 'session-e2e-code-block-run'
const COMMAND = "printf 'RUN_CWD='; pwd; printf 'RUN_OUTPUT_OK\\n'"
export function apply(ctx) {
  let timer
  let attempts = 0
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined }
  const tick = () => {
    if (++attempts > 600) { stop(); return }
    const agent = ctx.agents.get(SESSION_ID)
    if (agent === undefined) return
    const session = agent.session
    if (session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message?.id === 'e2e-run-assistant')) { stop(); return }
    // Same durable event shapes as the session validator integration fixture.
    // The session remains idle: these are recorded events, not agent.run().
    session.append('user/message', { id: 'e2e-run-user', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Show a command to inspect this workspace.' }] }, { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
      id: 'e2e-run-assistant', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: `Run fixture command:\n\n\`\`\`sh\n${COMMAND}\n\`\`\`\n` }],
    } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    console.log(`[e2e-code-block-run] seeded ${SESSION_ID}`)
    stop()
  }
  timer = setInterval(tick, 200)
  ctx.effect(() => () => stop(), 'e2e-code-block-run.seed')
  tick()
}
