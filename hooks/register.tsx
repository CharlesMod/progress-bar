import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
- When you finish, end your final message with [D100%]. Leave the tag out of replies to quick questions that take no work.
- The tag is removed from your message before it's saved, so you won't see your earlier estimates; judge each one fresh.`

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

/** A text with its progress tags taken out, along with the spaces before them. */
export function stripTags(text: string): string {
  return text.replace(/[ \t]*\[D?\s*\d{1,3}(?:\.\d+)?\s*%\]/g, '').trimEnd()
}

function format(percent: number): string {
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

const W = 220
const H = 14
const PAD = 5 // room around the bar for the gold glow and sparkles

const START = '#4a8ce0'
const END = '#00dc00'

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  if (d === 0) return [0, 0, l * 100]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return [h < 0 ? h + 360 : h, s * 100, l * 100]
}

const FROM = hexToHsl(START)
const TO = hexToHsl(END)

/** START at 0% to END at 100% through HSL, eased so most of the shift comes early (mostly END by 85%). */
function fillColor(percent: number): string {
  const t = 1 - Math.pow(1 - percent / 100, 2.2)
  let dh = TO[0] - FROM[0]
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  const hue = (FROM[0] + dh * t + 360) % 360
  return `hsl(${hue.toFixed(0)} ${(FROM[1] + (TO[1] - FROM[1]) * t).toFixed(0)}% ${(FROM[2] + (TO[2] - FROM[2]) * t).toFixed(0)}%)`
}

/** A battery with no terminal: rounded outline, inset fill. Explicit colors, as an image doesn't inherit currentColor. */
function battery(percent: number, isDone: boolean): string {
  const inset = 2.5
  const inner = W - 2 * inset
  const fill = percent > 0 ? Math.max(3, (inner * percent) / 100) : 0
  const x0 = PAD, y0 = PAD
  const stops = isDone
    ? '<stop offset="0" stop-color="#e9a917"/><stop offset="0.55" stop-color="#ffd54a"/><stop offset="1" stop-color="#fff0a8"/>'
    : `<stop offset="0" stop-color="${fillColor(Math.max(0, percent - 50))}"/><stop offset="1" stop-color="${fillColor(percent)}"/>`
  // The visual "ding" when it completes: the bar pops, a shine sweeps across, a gold border blinks three times then keeps a slow glow until the next ask, sparkles pop.
  const flourish = isDone
    ? `<clipPath id="c"><rect x="${x0 + inset}" y="${y0 + inset}" width="${inner}" height="${H - 2 * inset}" rx="2.5"/></clipPath>
<rect clip-path="url(#c)" x="${x0 - 40}" y="${y0}" width="28" height="${H}" fill="url(#s)" transform="skewX(-20)">
  <animate attributeName="x" from="${x0 - 40}" to="${x0 + W + 40}" dur="0.7s" begin="0.05s;1.0s" fill="freeze"/>
</rect>
<rect x="${x0 - 1.5}" y="${y0 - 1.5}" width="${W + 2}" height="${H + 2}" rx="5" fill="none" stroke="#ffd54a" stroke-width="2.5" filter="url(#glow)" opacity="0">
  <animate id="blink" attributeName="opacity" values="0;1;0;1;0;1;0.35" keyTimes="0;0.12;0.3;0.45;0.6;0.75;1" dur="1.5s" begin="0s" fill="freeze"/>
  <animate attributeName="opacity" values="0.35;0.9;0.35" dur="2.4s" begin="blink.end" repeatCount="indefinite"/>
</rect>
${[0.18, 0.42, 0.66, 0.9].map((f, i) => {
  const cx = x0 + W * f, cy = i % 2 ? y0 - 1 : y0 + H + 1
  return `<path d="M${cx} ${cy - 4} L${cx + 1.1} ${cy - 1.1} L${cx + 4} ${cy} L${cx + 1.1} ${cy + 1.1} L${cx} ${cy + 4} L${cx - 1.1} ${cy + 1.1} L${cx - 4} ${cy} L${cx - 1.1} ${cy - 1.1} Z" fill="#fff3b0" opacity="0" transform-origin="${cx} ${cy}">
  <animate attributeName="opacity" values="0;1;0" dur="0.6s" begin="${(0.1 + i * 0.12).toFixed(2)}s" fill="freeze"/>
  <animateTransform attributeName="transform" type="scale" values="0.2;1.3;0.6" dur="0.6s" begin="${(0.1 + i * 0.12).toFixed(2)}s" fill="freeze"/>
</path>`
}).join('\n')}`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 2 * PAD}" height="${H + 2 * PAD}" viewBox="0 0 ${W + 2 * PAD} ${H + 2 * PAD}">
<defs><linearGradient id="g" x1="0" x2="1">${stops}</linearGradient>
<filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<g transform-origin="${x0 + W / 2} ${y0 + H / 2}">${isDone
  ? '<animateTransform attributeName="transform" type="scale" values="1;1.06;0.98;1" keyTimes="0;0.3;0.65;1" dur="0.45s" fill="freeze"/>'
  : ''}
<rect x="${x0 + 0.5}" y="${y0 + 0.5}" width="${W - 1}" height="${H - 1}" rx="4" fill="#8888881f" stroke="${isDone ? '#d9a521' : '#8a8a8a'}" stroke-width="1"/>
<rect x="${x0 + inset}" y="${y0 + inset}" width="${fill.toFixed(1)}" height="${H - 2 * inset}" rx="2.5" fill="url(#g)"/>
${flourish}
</g>
</svg>`
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
        // A tag while idle (say, after a reload mid-ask) starts the bar rather than being dropped.
        await update($, progress, (p): Progress => ({ percent, phase: p.phase === 'idle' ? 'working' : p.phase }))
        // Keep the tags out of the stored row, so neither the transcript nor the model's context carries them.
        const content = e.message.content.flatMap(block => {
          if (block.type !== 'text' || typeof block.text !== 'string') return [block]
          const text = stripTags(block.text)
          return text === '' ? [] : [{ ...block, text }]
        })
        // A row that was nothing but a tag stays as it was: an empty row isn't valid.
        if (content.length > 0) {
          return next({ ...e, message: { ...e.message, content } })
        }
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

  // The app surfaces draw the battery, centered, in the band above the prompt: the desktop
  // app doesn't raise PromptHint. A survey has the band to itself.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const bar = await shown($)
    const ui = $.ui.resolve(e)
    if (bar === null || e.surface === 'terminal' || e.props.hasSurvey || !('Svg' in ui)) {
      return next(e)
    }
    const { Box, Text } = ui
    return (
      <Box flexDirection="row" flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
        <ui.Svg
          source={battery(bar.percent, bar.isDone)}
          alt={`Progress on the current request: ${bar.label}`}
          width={W + 2 * PAD}
          height={H + 2 * PAD}
          isInteractive={bar.isDone}
        />
        <Text dimColor>{bar.label}</Text>
      </Box>
    )
  })

  // A terminal keeps its own hint line under the prompt (its pills stay live) with a block bar
  // added at the end.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const bar = await shown($)
    if (bar === null || e.surface !== 'terminal') {
      return next(e)
    }
    // Eighth-block characters so the terminal bar moves smoothly.
    const cells = 16
    const eighths = Math.round((cells * 8 * bar.percent) / 100)
    const filled = '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? '▏▎▍▌▋▊▉'[(eighths % 8) - 1] : '')
    return next({ ...e, props: { ...e.props, tail: `  ${filled}${'░'.repeat(cells - filled.length)} ${bar.label}` } })
  })
}

/** What the bar shows now, or null while there's no estimate to show. */
async function shown($: EngineInterface) {
  const { percent, phase } = await read($, progress)
  if (phase === 'idle' || (phase === 'working' && percent === null)) {
    return null
  }
  const value = percent ?? 0
  return {
    percent: value,
    isDone: phase === 'done',
    label: phase === 'stopped' ? `${format(value)} · stopped` : format(value),
  }
}
