import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Progress } from '../types'

// The bar moves on one thing only: the model's own progress tags, and only forward.
const progress = atom(
  { plugin: 'progress-bar', key: 'progress' } as const,
  { percent: null, phase: 'idle' } as Progress,
)

// How many steps the session's task list has (the desktop app's plan, or TodoWrite's list): the
// bar is cut into that many sections. Only the model's estimate fills them.
const steps = atom({ plugin: 'progress-bar', key: 'steps' } as const, 0)

// Bumped at each swap while the bar moves, so the band takes a fresh drawing of it.
const tick = atom({ plugin: 'progress-bar', key: 'tick' } as const, 0)


// `[D20.9%]`; the leading D is optional so a plain `[20.9%]` counts too.
const TAG = /\[D?\s*(\d{1,3}(?:\.\d+)?)\s*%\]/g

const INSTRUCTIONS = `# Progress estimate

The person tracks your progress on their latest request with a progress bar. Each time you write text to them while working on it (a status update between tool calls, a note on what you found or will do next), include your honest estimate of how complete the whole request is, as a tag like [D20.9%], anywhere in that text.

- Estimate the whole request, not the current step. Use any precision you like.
- The bar only moves forward: a lower estimate than an earlier one leaves it where it is, so don't overshoot early.
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

/** Where the bar goes on a new estimate: forward to it, or nowhere; it never moves back. */
export function settle(shown: number | null, stated: number): number {
  return shown === null ? stated : Math.max(shown, stated)
}

function format(percent: number): string {
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

const H = 14
const PAD = 5 // room around the bar for the gold glow and sparkles
const MARGIN = 6

/** Seconds a fill takes to ease from where it is to a new estimate. */
const RAMP_S = 0.55
/** Seconds the finale's flourish runs after the fill reaches the end. */
const FINALE_S = 2.6
// The ease, as SMIL keySplines and as the same cubic for working out where a sweep is.
const SPLINE = [0.45, 0, 0.25, 1] as const

/** How far through the ease (0 to 1) a sweep is when `t` (0 to 1) of its time has gone by. */
function eased(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const [x1, y1, x2, y2] = SPLINE
  const bez = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (bez(x1, x2, mid) < t) lo = mid
    else hi = mid
  }
  return bez(y1, y2, (lo + hi) / 2)
}

// The finale's timing, in seconds after the fill reaches the end.
const SHINE_S = 0.6
const BLINK_S = 1.2
const BLINKS = [0, 1, 0, 1, 0, 1, 0.45]
const SPARKLES = [0.04, 0.16, 0.28, 0.4, 0.52, 0.64, 0.76, 0.88, 0.97]
const SPARKLE_S = 0.6

/** How far through its time (0 to 1) an ease is when it has gone `p` (0 to 1) of the way. */
function uneased(p: number): number {
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (eased(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Seconds a section that has just filled blinks gold. */
const SECTION_BLINK_S = 0.6

/**
 * When (seconds into the ease from `from` to `to`) each section the fill finishes blinks: as the
 * fill reaches its end, but never before the one before it has finished blinking, so a sweep across
 * several reads as one blink after another. The last section's blink is the finale's when the ask is
 * done.
 */
export function blinkTimes(from: number, to: number, n: number, isDone: boolean): { i: number; at: number }[] {
  if (n < 2 || to - from < 0.0005) return []
  const times: { i: number; at: number }[] = []
  for (let i = 0; i < n - (isDone ? 1 : 0); i++) {
    const end = (i + 1) / n
    if (from < end - 0.0005 && end <= to + 0.0005) {
      const reached = RAMP_S * uneased((end - from) / (to - from))
      const free = times.length > 0 ? times[times.length - 1]!.at + SECTION_BLINK_S : 0
      times.push({ i, at: Math.max(reached, free) })
    }
  }
  return times
}

/** A sparkle that pops once at CSS position `x` and row `y`, starting `begin` seconds from now (negative: already that far in). */
function sparkle(x: string, y: number, scale: number, begin: number): string {
  if (begin < -SPARKLE_S) return ''
  const t = begin.toFixed(3)
  return `<use href="#star" y="${y}" opacity="0" style="x:${x};transform-box:fill-box;transform-origin:center">
  <animate attributeName="opacity" values="0;1;0" dur="${SPARKLE_S}s" begin="${t}s" fill="freeze"/>
  <animateTransform attributeName="transform" type="scale" values="${0.2 * scale};${1.4 * scale};${0.6 * scale}" dur="${SPARKLE_S}s" begin="${t}s" fill="freeze"/>
</use>`
}

/**
 * The bar: a rounded outline across the band with an inset fill, easing from `from` to `to`
 * (fractions of the bar) and already `elapsed` seconds into that ease, so a drawing handed over
 * partway through carries on from where the last one was rather than starting over. The fill
 * reveals a fixed blue-to-green ramp laid along the whole bar, so its colour follows how far it
 * has got. `finale` is how many seconds into the end-of-ask flourish the drawing starts (null for
 * none; it may be negative, still to come). With `from` equal to `to` and no finale it holds no
 * animation at all. Explicit colours: the drawing doesn't inherit currentColor, and the band
 * refuses a drawing with a <style> element.
 */
export function battery(from: number, to: number, elapsed: number, isDone: boolean, finale: number | null, n = 1): string {
  const inset = 2.5
  const bar = `(100% - ${2 * MARGIN}px)`
  const along = (k: number) => `calc(${MARGIN}px + ${bar} * ${k.toFixed(4)})`
  const inner = `(${bar} - ${2 * inset}px)`
  const base = Math.max(from, to)
  const isEasing = Math.abs(from - to) > 0.0005 && elapsed !== Infinity
  const ramp = isEasing
    ? `<animateTransform attributeName="transform" type="scale" values="${(from / base).toFixed(4)} 1;${(to / base).toFixed(4)} 1" dur="${RAMP_S}s" begin="${(-elapsed).toFixed(3)}s" calcMode="spline" keyTimes="0;1" keySplines="${SPLINE.join(' ')}" fill="freeze"/>`
    : ''
  const shown = isEasing ? base : to
  const body = shown > 0.0005
    ? `<rect y="${inset}" height="${H - 2 * inset}" rx="2.5" fill="url(#ramp)" transform="scale(${isEasing ? (onCurve(from, to, Math.min(elapsed, RAMP_S)) / base).toFixed(4) : '1'} 1)" style="x:${MARGIN + inset}px;width:max(2px, calc(${inner} * ${shown.toFixed(4)}));transform-box:fill-box;transform-origin:left center">${ramp}</rect>`
    : ''
  const outline = isDone ? '#d9a521' : '#8a8a8a'
  // With a task list, the one fill shows through n sections, so it moves exactly as one bar does
  // and reads as one bar filling across them.
  const gap = 4
  const section = (i: number, grow: number) => {
    const before = (i === 0 ? 0 : gap / 2) - grow
    const after = (i === n - 1 ? 0 : gap / 2) - grow
    return `x:calc(${along(i / n)} + ${before}px);width:calc(${bar} / ${n} - ${before + after}px)`
  }
  const cut = n > 1
    ? `<clipPath id="sec">${Array.from({ length: n }, (_, i) => `<rect y="${inset}" height="${H - 2 * inset}" rx="2.5" style="${section(i, -inset)}"/>`).join('')}</clipPath>`
    : ''
  const outlines = n > 1
    ? Array.from({ length: n }, (_, i) => `<rect y="0.5" height="${H - 1}" rx="${n > 6 ? 3 : 4}" fill="none" stroke="${outline}" stroke-width="1" style="${section(i, -0.5)}"/>`).join('')
    : `<rect y="0.5" height="${H - 1}" rx="4" fill="none" stroke="${outline}" stroke-width="1" style="x:${MARGIN + 0.5}px;width:calc(${bar} - 1px)"/>`
  // A section the fill finishes during this ease blinks gold, with a few sparkles, one after another.
  const blinks = !isEasing
    ? ''
    : blinkTimes(from, to, n, isDone)
        .map(({ i, at }) => {
          const begin = at - elapsed
          if (begin < -SECTION_BLINK_S - SPARKLE_S) return ''
          return `<rect y="-1.5" height="${H + 2}" rx="5" fill="none" stroke="#ffd54a" stroke-width="2" filter="url(#glow)" opacity="0" style="${section(i, 1.5)}"><animate attributeName="opacity" values="0;1;0;1;0" dur="${SECTION_BLINK_S}s" begin="${begin.toFixed(3)}s" fill="freeze"/></rect>`
            + [0.2, 0.5, 0.8].map((k, j) => sparkle(along((i + k) / n), j % 2 ? -2 : H + 2, 0.6, begin + 0.05 + j * 0.08)).join('')
        })
        .join('')
  const gold = (opacity: string, inner = '') =>
    `<rect y="-1.5" height="${H + 2}" rx="5" fill="none" stroke="#ffd54a" stroke-width="3" filter="url(#glow)" opacity="${opacity}" style="x:${MARGIN - 1.5}px;width:calc(${bar} + 3px)">${inner}</rect>`
  // The ask's end: a shine sweeps across, the gold border blinks three times and settles to a
  // glow, and a burst of sparkles pops along the bar. Past it, only the glow stays.
  let flourish = ''
  if (isDone) {
    if (finale === null || finale >= FINALE_S) {
      flourish = gold('0.45')
    } else {
      const at = (s: number) => (s - finale).toFixed(3)
      flourish = `${finale < SHINE_S ? `<rect clip-path="url(#c)" x="-10%" y="0" width="36" height="${H}" fill="url(#shine)" transform="skewX(-20)">
  <animate attributeName="x" from="-10%" to="110%" dur="${SHINE_S}s" begin="${at(0)}s" fill="freeze"/>
</rect>` : ''}
${gold('0', `<animate attributeName="opacity" values="${BLINKS.join(';')}" dur="${BLINK_S}s" begin="${at(0)}s" fill="freeze"/>`)}
${SPARKLES.map((k, j) => sparkle(along(k), j % 2 ? -2 : H + 2, 1.3, 0.1 + j * 0.08 - finale)).join('\n')}`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H + 2 * PAD}" overflow="visible">
<defs>
<linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="${MARGIN}" x2="100%" y1="0" y2="0"><stop offset="0" stop-color="#4a8ce0"/><stop offset="0.45" stop-color="#3fc7a0"/><stop offset="1" stop-color="#00dc00"/></linearGradient>
<path id="star" d="M0 -4 L1.1 -1.1 L4 0 L1.1 1.1 L0 4 L-1.1 1.1 L-4 0 L-1.1 -1.1 Z" fill="#fff3b0"/>
<clipPath id="c"><rect y="0" height="${H}" rx="4" style="x:${MARGIN}px;width:calc${bar}"/></clipPath>${cut}
<filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<g transform="translate(0 ${PAD})">
${outlines}
${n > 1 ? `<g clip-path="url(#sec)">${body}</g>` : body}
${blinks}
${flourish}
</g>
</svg>`
}

/** Where an ease from `from` to `to` is, `elapsed` seconds in. */
function onCurve(from: number, to: number, elapsed: number): number {
  return from + (to - from) * eased(elapsed / RAMP_S)
}

/**
 * Seconds into an ease that the band takes one fresh drawing. The app re-creates the image now and
 * then on its own, which replays the drawing from where it started, so each is handed over already
 * as far in as the time gone by. A swap costs a frame or two, so there is just the one, then the
 * drawing with no animation in it once the fill is at rest.
 */
const SWAP_S = 0.28

/** Seconds a drawing takes to reach the screen: each is drawn this far ahead so it lands in step. */
const LEAD_S = 0.06
/**
 * Further seconds the first drawing of an ease takes to show, handed over as the app adds the
 * message that moved it: drawn that much further ahead too. Measured from a recording.
 */
const FIRST_LAG_S = 0.03
/** Seconds the fill rests at its end, frozen there, before the still drawing replaces it. */
const SETTLE_S = 0.05

// The ease the bar is on: from `from` to `to` (fractions of the bar), starting at `at` (ms).
// `doneAt` is when the fill reaches the end on the model's [D100%], which starts the finale.
type Sweep = { from: number; to: number; at: number; isDone: boolean; doneAt: number | null }
let last: Sweep | null = null
let frameDue = false

/** Forgets the last ask's drawing: a new ask starts its bar from empty. */
function startAsk() {
  last = null
}

/** How far ahead of the clock a drawing made `elapsed` seconds into an ease is drawn. */
function leadAt(elapsed: number): number {
  return LEAD_S + (elapsed < SWAP_S ? FIRST_LAG_S : 0)
}

/**
 * The drawing of the bar for `percent` at `now` (ms), and in how many ms the band should take
 * another (null: it is at rest and drawn still). A new estimate eases on from wherever the fill
 * shows now, never back.
 */
export function draw(percent: number, isDone: boolean, now: number, n = 1): { source: string; wakeIn: number | null } {
  const to = percent / 100
  if (last === null || last.to !== to || last.isDone !== isDone) {
    // Where the last drawing shows the fill: drawn ahead, so from there, not from behind it.
    const was = last === null ? 0 : (now - last.at) / 1000
    const from = last === null ? 0 : Math.min(to, onCurve(last.from, last.to, Math.min(RAMP_S, was + leadAt(was))))
    last = { from, to, at: now, isDone, doneAt: isDone ? now + RAMP_S * 1000 : null }
  }
  const elapsed = (now - last.at) / 1000
  const finale = last.doneAt === null ? null : (now - last.doneAt) / 1000
  // At rest once the fill has arrived and the last section has blinked (or the finale played).
  const blinked = blinkTimes(last.from, last.to, n, last.isDone).reduce((end, { at }) => Math.max(end, at + SECTION_BLINK_S + SPARKLE_S), 0)
  const restAt = Math.max(blinked, last.doneAt !== null ? (last.doneAt - last.at) / 1000 + FINALE_S : RAMP_S + SETTLE_S)
  if (elapsed >= restAt) {
    return { source: battery(last.to, last.to, Infinity, last.isDone, null, n), wakeIn: null }
  }
  const lead = leadAt(elapsed)
  const source = battery(last.from, last.to, elapsed + lead, last.isDone, finale === null ? null : finale + lead, n)
  // The next swap: partway, then at rest.
  return { source, wakeIn: ((elapsed < SWAP_S ? SWAP_S : restAt) - elapsed) * 1000 }
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return {
      sections: [...sections, { id: 'progress-bar:instructions', text: INSTRUCTIONS, scope: 'session' }],
    }
  })

  // A typed ask starts a new bar. A message sent while an ask is still working joins it, and a
  // continuation turn (empty text) keeps it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      const { phase } = await read($, progress)
      if (phase !== 'working') {
        await update($, progress, (): Progress => ({ percent: null, phase: 'working' }))
        await update($, steps, () => 0)
        startAsk()
      }
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
        await update($, progress, (p): Progress => {
          // A tag after the ask ended (a continuation turn) carries on from where it was.
          const shown = settle(p.phase === 'idle' ? null : p.percent, percent)
          return { percent: shown, phase: shown >= 100 ? 'done' : 'working' }
        })
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

  // The turn's end doesn't move the bar: it only marks the ask as no longer working, so the
  // next typed ask starts afresh.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, progress, (p): Progress => {
        if (p.phase !== 'working') return p
        if (p.percent === null) return { percent: null, phase: 'idle' }
        return { ...p, phase: e.reason === 'answer' ? 'done' : 'stopped' }
      })
    }
    return next(e)
  })

  // The task list sets how many sections the bar has; only its length counts, never its progress.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && Array.isArray(e.items)) await update($, steps, () => e.items.length)
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && Array.isArray(e.todos)) await update($, steps, () => e.todos.length)
    return result
  }).catch(($, e, next) => next(e))

  // The app surfaces draw the bar across the band above the prompt: the desktop app doesn't
  // raise PromptHint. A survey has the band to itself.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      return await drawBand($, e, next)
    } catch (error) {
      // A drawing that fails leaves the band to the engine and says why, once per message.
      const message = `progress-bar: ${error instanceof Error ? error.message : String(error)}`
      if (message !== lastError) {
        lastError = message
        $.ui.toast(message)
      }
      return next(e)
    }
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

let lastError = ''



/** The bar in the band above the prompt, or the engine's own band when there's nothing to show. */
async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>, next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>) {
  const bar = await shown($)
  const ui = $.ui.resolve(e)
  if (bar === null || e.surface === 'terminal' || e.props.hasSurvey || !('Svg' in ui)) {
    return next(e)
  }
  const { Box } = ui
  await read($, tick)
  const now = await $.clock.now()
  const { source, wakeIn } = draw(bar.percent, bar.isDone, now, Math.max(1, await read($, steps)))
  // While the bar moves, the band takes a fresh drawing at the next swap.
  if (wakeIn !== null && !frameDue) {
    frameDue = true
    void $.clock.sleep(wakeIn + 20).then(async () => {
      frameDue = false
      await update($, tick, n => n + 1)
    }).catch(() => {
      frameDue = false
    })
  }
  return (
    <Box flexGrow={1}>
      <ui.Svg
        source={source}
        alt={`Progress on the current request: ${bar.label}`}
        // With no width of its own the drawing is the browser's default 300px; one wider than any
        // band is held to the band's width, and the drawing lays out inside it at 100%.
        width={4000}
        height={H + 2 * PAD}
        // An image, not a frame: a frame reloads on every new source and blanks for a moment.
      />
    </Box>
  )
}

/** What the bar shows now, or null while there's no estimate to show. */
async function shown($: EngineInterface) {
  const { percent, phase } = await read($, progress)
  if (phase === 'idle' || percent === null) {
    return null
  }
  return {
    percent,
    isDone: phase === 'done' && percent >= 100,
    label: phase === 'stopped' ? `${format(percent)} · stopped` : format(percent),
  }
}
