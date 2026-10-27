import type { Register } from 'claude-code'

const TOOL_NAME = 'compact_session'
const TOOL = 'mcp__self-compact__compact_session'

type Job = { keep: string; then?: string }

const DESCRIPTION = [
  'Compacts this conversation as soon as your current turn ends, exactly as if the user typed `/compact <keep>`.',
  'Call it only when the user asked you to compact your session (e.g. "plan, then compact, then implement").',
  'Compaction is lossy: before calling, write anything that must survive verbatim (a plan, a spec, findings) to a file, and name that file in `keep` and `then`.',
  'After calling it, end your turn immediately with a one-line status and no further tool calls.',
  'If `then` is given, it is sent to you as the next prompt right after compaction, so make it a self-contained instruction.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    keep: {
      type: 'string',
      description:
        'What the compaction summary must preserve: the plan file path, decisions, constraints, open questions. Passed to /compact as its instructions.',
    },
    then: {
      type: 'string',
      description:
        'Optional prompt to resume with after compaction, e.g. "Implement the plan in PLAN.md, starting with step 1." Omit to stop after compacting.',
    },
  },
  required: ['keep'],
  additionalProperties: false,
}

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const register: Register = on => {
  let pending: Job | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: TOOL }, ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main session can compact itself, not a subagent.' }
    }
    const keep = asText(e.keep)
    if (keep === '') return { deny: '`keep` is required: say what the summary must preserve.' }
    const then = asText(e.then) || undefined
    pending = { keep, then }
    $.ui.status('compaction queued for end of turn')
    return {
      result: then
        ? 'Compaction queued. End your turn now without further tool calls; after compaction you will receive your `then` prompt.'
        : 'Compaction queued. End your turn now without further tool calls.',
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'self-compact failed to queue the compaction.' },
  )

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || pending === undefined) return done

    const job = pending
    pending = undefined
    $.ui.status(undefined)
    if (e.reason !== 'answer') {
      void $.ui.toast(`self-compact: turn ended (${e.reason}), compaction cancelled`)
      return done
    }

    // $.command.run rejects inside a hook the turn waits on, so it runs from a timer.
    $.clock.after(0, () => {
      void (async () => {
        try {
          await $.command.run({ command: 'compact', args: job.keep })
        } catch (err) {
          void $.ui.toast(`self-compact: /compact failed: ${String(err)}`)
          return
        }
        if (job.then) await $.prompt.submit({ text: job.then })
      })()
    })
    return done
  })
}
