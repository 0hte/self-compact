// The whole round trip: the tool queues a compaction, the end of the main turn runs /compact, then the follow-up prompt.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__self-compact__compact_session'
const START = { cwd: 'C:\\repo', surface: 'terminal' as const, isInteractive: true }

/** The engine beneath: what got registered, every slash command and prompt in the order they ran, toasts. */
const world = (on: On) => {
  const clock = mock.clock(on)
  const w = { clock, registered: [] as string[], ran: [] as string[], toasts: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__self-compact__${e.name}` } }
  })
  on('command.run', (_$, e) => {
    w.ran.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('prompt.submit', (_$, e) => {
    w.ran.push(`prompt: ${e.text}`)
    return { text: e.text } as never
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  return w
}

type ToolCaller = { tool: { call: (input: object) => Promise<{ deny?: string }> } }

// With many MCP servers connected, resolving $.tool.call's overloads exceeds tsc's instantiation depth.
const compactWith = ($: unknown) => (args: { keep: string; then?: string; agentId?: string }) =>
  ($ as ToolCaller).tool.call({ tool: TOOL, ...args })
const ended = (reason: 'answer' | 'aborted' | 'error', agentId?: string) => ({
  answer: 'compacting',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId: 'T1',
  reason,
  ...(agentId ? { agentId } : {}),
}) as never

test('it registers its tool when the session starts', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.registered).toEqual(['compact_session'])
})

test('an answered turn compacts with the keep instructions, then sends the follow-up prompt', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const queued = await compactWith($)({ keep: 'the plan in PLAN.md', then: 'Implement PLAN.md, step 1 first.' })
  expect(queued.deny).toBeUndefined()
  expect(w.ran).toEqual([])

  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual(['/compact the plan in PLAN.md', 'prompt: Implement PLAN.md, step 1 first.'])
})

test('without a follow-up it only compacts', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await compactWith($)({ keep: 'decisions so far', then: '   ' })
  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual(['/compact decisions so far'])
})

test('an interrupted or failed turn cancels the compaction and says so', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await compactWith($)({ keep: 'x', then: 'y' })
  await $.turn.complete(ended('aborted'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts).toEqual(['self-compact: turn ended (aborted), compaction cancelled'])

  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
})

test('a subagent cannot compact the session, and its turn ending does not run a pending one', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const denied = await compactWith($)({ keep: 'x', agentId: 'ag1' })
  expect(denied.deny).toBe('Only the main session can compact itself, not a subagent.')

  await compactWith($)({ keep: 'main plan' })
  await $.turn.complete(ended('answer', 'ag1'))
  await w.clock.settle()
  expect(w.ran).toEqual([])

  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual(['/compact main plan'])
})

test('a call without keep is refused and queues nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const denied = await compactWith($)({ keep: '  ' })
  expect(denied.deny).toBe('`keep` is required: say what the summary must preserve.')
  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
})

test('a turn with no queued compaction runs nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
})
