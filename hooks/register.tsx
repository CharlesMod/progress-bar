import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Progress } from '../types'

const progress = atom(
  { plugin: 'progress-bar', key: 'progress' } as const,
  { percent: null, phase: 'idle' } as Progress,
)

// `[D20.9%]`; the leading D is optional so a plain `[20.9%]` counts too.
const TAG = /\[D?\s*(\d{1,3}(?:\.\d+)?)\s*%\]/g

const INSTRUCTIONS = `# Progress estimate

The person tracks your progress on their latest request with a progress bar. Each time you write text to them while working on it (a status update between tool calls, a note on what you found or will do next), include your honest estimate of how complete the whole request is, as a tag like [D20.9%], anywhere in that text.

- Estimate the whole request, not the current step. Use any precision you like.
- Revise freely: raise it as work lands, lower it when you discover more work than you expected.
- When you finish, end your final message with [D100%]. Leave the tag out of replies to quick questions that take no work.`

/** The last progress tag in a message's text blocks, clamped to 0-100. */
export function lastPercent(texts: readonly string[]): number | null {
  let found: number | null = null
  for (const text of texts) {
    for (const match of text.matchAll(TAG)) {
      found = Math.min(100, Math.max(0, Number(match[1])))
    }
  }
  return found
}

function format(percent: number): string {
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

/** A slim rounded track with a gradient fill, for surfaces that draw Svg. */
function barSvg(percent: number, isDone: boolean): string {
  const width = 160
  const fill = Math.max(percent > 0 ? 3 : 0, (width * percent) / 100)
  const [from, to] = isDone ? ['#3fb68b', '#5ad6a4'] : ['#c96442', '#e8a25c']
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="${width}" height="6" rx="3" fill="currentColor" opacity="0.14"/>
<rect width="${fill.toFixed(1)}" height="6" rx="3" fill="url(#g)"/>
</svg>`
}

/** Eighth-block characters so the terminal bar moves smoothly. */
function barText(percent: number, cells: number): { filled: string; empty: string } {
  const eighths = Math.round((cells * 8 * percent) / 100)
  const full = Math.floor(eighths / 8)
  const partial = eighths % 8
  const filled = '█'.repeat(full) + (partial ? '▏▎▍▌▋▊▉'[partial - 1] : '')
  return { filled, empty: '░'.repeat(cells - filled.length) }
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return {
      sections: [...sections, { id: 'progress-bar:instructions', text: INSTRUCTIONS, scope: 'session' }],
    }
  })

  // A typed ask starts a new bar; a continuation turn (empty text) keeps it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      await update($, progress, (): Progress => ({ percent: null, phase: 'working' }))
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'model' && e.message.type === 'assistant') {
      const texts = e.message.content.flatMap(block =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
      )
      const percent = lastPercent(texts)
      if (percent !== null) {
        await update($, progress, p => ({ ...p, percent }))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, progress, (p): Progress => {
        if (p.phase !== 'working') return p
        if (e.reason !== 'answer') return { ...p, phase: 'stopped' }
        // A tagged ask that finished counts as done even if the model forgot [D100%].
        return p.percent === null ? { percent: null, phase: 'idle' } : { percent: 100, phase: 'done' }
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { percent, phase } = await read($, progress)
    if (phase === 'idle' || (phase === 'working' && percent === null)) {
      return next(e)
    }

    const shown = percent ?? 0
    const isDone = phase === 'done'
    const label = phase === 'stopped' ? `${format(shown)} · stopped` : format(shown)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const modes = e.props.modes.length > 0 ? await next(e) : null

    if ('Svg' in ui) {
      const { Svg } = ui
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg
            source={barSvg(shown, isDone)}
            alt={`Progress on the current request: ${label}`}
            width={160}
            height={6}
          />
          <Text dimColor tabular size="footnote">
            {label}
          </Text>
          {modes}
        </Box>
      )
    }

    const { filled, empty } = barText(shown, 16)
    return (
      <Box flexDirection="row" gap={1}>
        <Text>
          <Text color={isDone ? 'success' : 'claude'}>{filled}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
        <Text dimColor>{label}</Text>
        {modes}
      </Box>
    )
  })
}
