import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Progress, Steps } from '../types'

// The bar moves on one thing only: the model's own progress tags, and only forward.
const progress = atom(
  { plugin: 'progress-bar', key: 'progress' } as const,
  { percent: null, phase: 'idle' } as Progress,
)

// The session's task list (the desktop app's plan, or TodoWrite's list): the bar is cut into one
// section per step, the finished steps fill theirs, and the model's estimate fills the one it's on.
const steps = atom({ plugin: 'progress-bar', key: 'steps' } as const, { total: 0, done: 0 } as Steps)

// `[D20.9%]`; the leading D is optional so a plain `[20.9%]` counts too.
const TAG = /\[D?\s*(\d{1,3}(?:\.\d+)?)\s*%\]/g

const INSTRUCTIONS = `# Progress estimate

The person tracks your progress on their latest request with a progress bar. Each time you write text to them while working on it (a status update between tool calls, a note on what you found or will do next), include your honest estimate of how complete the work is, as a tag like [D20.9%], anywhere in that text.

- While you keep a task list, the bar has one section per step and the tag is your estimate for the step you have in progress: [D50%] means that step is half done. A section fills only when its step is checked off, and a message that checks off a step tags the step it starts. With no list, the tag is your estimate for the whole request.
- The bar only moves forward: a lower estimate than an earlier one leaves it where it is, so don't overshoot early.
- When you finish, end your final message with [D100%]. Leave the tag out of replies to quick questions that take no work.
- The tag is removed from your message before it's saved, so you won't see your earlier estimates; judge each one fresh.`

// After this many tool calls in a row with no estimate, the next result carries a reminder.
const REMIND_AFTER = 3

const REMINDER = `The progress bar has had no estimate for the last ${REMIND_AFTER} tool calls. Include a tag like [D40%] in your next update to the person, with your estimate for the step you have in progress (or for the whole request, with no task list).`

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

// How far into its section an estimate fills a step that isn't checked off: a full section always
// means a checked-off step.
const STEP_CAP = 90

/**
 * Where on the whole bar (0-100) an estimate puts it: with a task list, that far into the step in
 * progress (short of its end), after the steps done; with none, the estimate itself.
 */
export function place(stated: number, { total, done }: Steps): number {
  if (total < 1) return stated
  if (done >= total) return 100
  return ((done + Math.min(stated, STEP_CAP) / 100) / total) * 100
}

/** A list's steps and how many are done, from its items' statuses. */
export function tally(statuses: readonly string[]): Steps {
  return { total: statuses.length, done: statuses.filter(status => status === 'completed').length }
}

function format(percent: number): string {
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

const H = 14
const PAD = 5 // room around the bar for the gold glow and sparkles
const MARGIN = 6

// The fill's easing, in and out: a cubic bezier from time to distance, as SMIL spells it.
const EASE = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
const KEY_SPLINE = `${EASE.x1} ${EASE.y1} ${EASE.x2} ${EASE.y2}`

/** Seconds the fill takes to ease from `from` to `to`: a short move is quick, a long one unhurried. */
export function fillSeconds(from: number, to: number): number {
  return to - from < 0.0005 ? 0 : 0.35 + 0.9 * (to - from)
}

/** Where along the ease (0-1 of its time) the fill has covered fraction `k` of its move. */
function easeTime(k: number): number {
  const bezier = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t
  let lo = 0
  let hi = 1
  for (let step = 0; step < 24; step++) {
    const mid = (lo + hi) / 2
    if (bezier(EASE.y1, EASE.y2, mid) < k) lo = mid
    else hi = mid
  }
  return bezier(EASE.x1, EASE.x2, (lo + hi) / 2)
}

// The finale's timing, in seconds after it starts.
const SHINE_S = 0.6
const BLINK_S = 1.2
const BLINKS = [0, 1, 0, 1, 0, 1, 0.45]
const SPARKLES = [0.04, 0.16, 0.28, 0.4, 0.52, 0.64, 0.76, 0.88, 0.97]
const SPARKLE_S = 0.6

/** Seconds a section that has just filled blinks gold. */
const SECTION_BLINK_S = 0.6

/**
 * When (seconds into the drawing) each section the move from `from` to `to` finishes blinks: as
 * the fill passes its end, but never before the section before it has finished blinking, so
 * finishing several reads as one blink after another. The last section's blink is the finale's
 * when the ask is done.
 */
export function blinkTimes(from: number, to: number, n: number, isDone: boolean): { i: number; at: number }[] {
  if (n < 2 || to - from < 0.0005) return []
  const seconds = fillSeconds(from, to)
  const times: { i: number; at: number }[] = []
  for (let i = 0; i < n - (isDone ? 1 : 0); i++) {
    const end = (i + 1) / n
    if (from < end - 0.0005 && end <= to + 0.0005) {
      const arrival = seconds * easeTime((end - from) / (to - from))
      const previous = times.length === 0 ? -Infinity : times[times.length - 1]!.at + SECTION_BLINK_S
      times.push({ i, at: Math.max(arrival, previous) })
    }
  }
  return times
}

/** A sparkle that pops once at CSS position `x` and row `y`, `begin` seconds into the drawing. */
function sparkle(x: string, y: number, scale: number, begin: number): string {
  const t = begin.toFixed(3)
  return `<use href="#star" y="${y}" opacity="0" style="x:${x};transform-box:fill-box;transform-origin:center">
  <animate attributeName="opacity" values="0;1;0" dur="${SPARKLE_S}s" begin="${t}s" fill="freeze"/>
  <animateTransform attributeName="transform" type="scale" values="${0.2 * scale};${1.4 * scale};${0.6 * scale}" dur="${SPARKLE_S}s" begin="${t}s" fill="freeze"/>
</use>`
}

/**
 * The bar: a rounded outline across the band with an inset fill that eases from `from` to `to`
 * (fractions of the bar) and stays there. The fill reveals a fixed blue-to-green ramp laid along
 * the whole bar, so its colour follows how far it has got. Each section the move finishes blinks
 * gold as the fill passes its end; when the ask is done the outline turns gold on arrival and the
 * finale plays once, leaving a soft gold glow. Everything in it plays from when the drawing is
 * mounted and freezes where it ends, so a drawing is one state and never needs another to finish
 * it. Explicit colours: the drawing doesn't inherit currentColor, and the band refuses a drawing
 * with a <style> element.
 */
export function battery(from: number, to: number, isDone: boolean, n = 1): string {
  const inset = 2.5
  const bar = `(100% - ${2 * MARGIN}px)`
  const along = (k: number) => `calc(${MARGIN}px + ${bar} * ${k.toFixed(4)})`
  const inner = `(${bar} - ${2 * inset}px)`
  const seconds = fillSeconds(from, to)
  // The fill is the whole inner bar, shown through a clip that is scaled to the estimate; easing
  // the clip's scale moves the fill without moving the ramp under it.
  const move = seconds > 0
    ? `<animateTransform attributeName="transform" type="scale" additive="sum" from="${from.toFixed(4)} 1" to="${to.toFixed(4)} 1" dur="${seconds.toFixed(3)}s" calcMode="spline" keySplines="${KEY_SPLINE}" keyTimes="0;1" fill="freeze"/>`
    : ''
  const reveal = `<clipPath id="fill"><rect y="${inset}" height="${H - 2 * inset}" transform="translate(${MARGIN + inset} 0)${move ? '' : ` scale(${to.toFixed(4)} 1)`}" style="x:0;width:calc${inner}">${move}</rect></clipPath>`
  const body = `<rect y="${inset}" height="${H - 2 * inset}" rx="2.5" fill="url(#ramp)" clip-path="url(#fill)" style="x:${MARGIN + inset}px;width:calc${inner}"/>`
  // The outline turns gold as the fill arrives at the end of a finished ask.
  const outlineAt = (begin: number) => isDone
    ? `<animate attributeName="stroke" to="#d9a521" dur="0.25s" begin="${begin.toFixed(3)}s" fill="freeze"/>`
    : ''
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
  const blinks = blinkTimes(from, to, n, isDone)
  const finaleAt = Math.max(seconds, ...blinks.map(({ at }) => at + SECTION_BLINK_S))
  const outlines = n > 1
    ? Array.from({ length: n }, (_, i) => `<rect y="0.5" height="${H - 1}" rx="${n > 6 ? 3 : 4}" fill="none" stroke="#8a8a8a" stroke-width="1" style="${section(i, -0.5)}">${outlineAt(finaleAt)}</rect>`).join('')
    : `<rect y="0.5" height="${H - 1}" rx="4" fill="none" stroke="#8a8a8a" stroke-width="1" style="x:${MARGIN + 0.5}px;width:calc(${bar} - 1px)">${outlineAt(finaleAt)}</rect>`
  // A section the move finishes blinks gold, with a few sparkles, one after another.
  const blinking = blinks
    .map(({ i, at }) =>
      `<rect y="-1.5" height="${H + 2}" rx="5" fill="none" stroke="#ffd54a" stroke-width="2" filter="url(#glow)" opacity="0" style="${section(i, 1.5)}"><animate attributeName="opacity" values="0;1;0;1;0" dur="${SECTION_BLINK_S}s" begin="${at.toFixed(3)}s" fill="freeze"/></rect>`
      + [0.2, 0.5, 0.8].map((k, j) => sparkle(along((i + k) / n), j % 2 ? -2 : H + 2, 0.6, at + 0.05 + j * 0.08)).join(''))
    .join('')
  // The ask's end: a shine sweeps across, the gold border blinks three times and settles to a
  // glow, and a burst of sparkles pops along the bar. The glow stays.
  const flourish = isDone
    ? `<rect clip-path="url(#c)" x="-10%" y="0" width="36" height="${H}" fill="url(#shine)" transform="skewX(-20)" opacity="0">
  <animate attributeName="opacity" to="1" dur="0.01s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/>
  <animate attributeName="x" from="-10%" to="110%" dur="${SHINE_S}s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/>
</rect>
<rect y="-1.5" height="${H + 2}" rx="5" fill="none" stroke="#ffd54a" stroke-width="3" filter="url(#glow)" opacity="0" style="x:${MARGIN - 1.5}px;width:calc(${bar} + 3px)"><animate attributeName="opacity" values="${BLINKS.join(';')}" dur="${BLINK_S}s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/></rect>
${SPARKLES.map((k, j) => sparkle(along(k), j % 2 ? -2 : H + 2, 1.3, finaleAt + 0.1 + j * 0.08)).join('\n')}`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H + 2 * PAD}" overflow="visible">
<defs>
<linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="${MARGIN}" x2="100%" y1="0" y2="0"><stop offset="0" stop-color="#4a8ce0"/><stop offset="0.45" stop-color="#3fc7a0"/><stop offset="1" stop-color="#00dc00"/></linearGradient>
<path id="star" d="M0 -4 L1.1 -1.1 L4 0 L1.1 1.1 L0 4 L-1.1 1.1 L-4 0 L-1.1 -1.1 Z" fill="#fff3b0"/>
<clipPath id="c"><rect y="0" height="${H}" rx="4" style="x:${MARGIN}px;width:calc${bar}"/></clipPath>${cut}${reveal}
<filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<g transform="translate(0 ${PAD})">
${outlines}
${n > 1 ? `<g clip-path="url(#sec)">${body}</g>` : body}
${blinking}
${flourish}
</g>
</svg>`
}

// The bar's last state: the fill eased to `to` (a fraction of the bar) from `from`, cut into `n`
// sections, with the ask done or not. The next estimate's drawing eases on from `to`.
type State = { from: number; to: number; isDone: boolean; n: number }
let last: State | null = null

// Tool calls since the model's last estimate, and whether this lapse has had its reminder.
let untagged = 0
let reminded = false

// The task list's items' statuses, kept so a plan update that names no items can be applied.
let statuses: string[] = []

// The model's highest estimate for the step in progress (for the whole ask, with no list); the
// highest tag in its current response, which a check-off later in that response carries to the
// step it starts; and whether its last tag was [D100%].
let estimate: number | null = null
let fresh: number | null = null
let finishing = false

/** Forgets the last ask's drawing: a new ask starts its bar from empty. */
function startAsk() {
  last = null
  untagged = 0
  reminded = false
  statuses = []
  estimate = null
  fresh = null
  finishing = false
}

/** The list's statuses after one of the desktop app's plan updates. */
export function applyPlan(before: readonly string[], e: { items?: unknown; advance?: unknown; done?: unknown; start?: unknown }): string[] {
  if (Array.isArray(e.items)) {
    return e.items.map(item => (item && typeof item === 'object' && typeof (item as { status?: unknown }).status === 'string' ? (item as { status: string }).status : 'pending'))
  }
  const after = [...before]
  if (Array.isArray(e.done)) for (const i of e.done) if (typeof i === 'number' && after[i - 1] !== undefined) after[i - 1] = 'completed'
  if (typeof e.start === 'number' && after[e.start - 1] !== undefined) after[e.start - 1] = 'in_progress'
  if (e.advance === true) {
    const current = after.indexOf('in_progress')
    if (current !== -1) after[current] = 'completed'
    const following = after.indexOf('pending')
    if (following !== -1) after[following] = 'in_progress'
  }
  return after
}

/**
 * The drawing of the bar for `percent`: the same string for as long as nothing has changed, so the
 * band keeps the drawing it has (and whatever is playing in it plays on); a new estimate is a new
 * drawing that eases the fill on from the last one. A change to the list alone redraws the bar
 * where it is.
 */
export function draw(percent: number, isDone: boolean, n = 1): string {
  const to = percent / 100
  if (last === null || last.to !== to || last.isDone !== isDone || last.n !== n) {
    const from = last === null ? 0 : last.to === to ? to : Math.min(to, last.to)
    last = { from, to, isDone, n }
  }
  return battery(last.from, last.to, last.isDone, n)
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
        await update($, steps, (): Steps => ({ total: 0, done: 0 }))
        startAsk()
        await syncStatus($)
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
        untagged = 0
        reminded = false
        estimate = settle(estimate, percent)
        fresh = settle(fresh, percent)
        finishing = percent >= 100
        await redraw($, true)
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

  // Each model response starts with no tag of its own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) fresh = null
    return yield* next(e)
  })

  // The turn's end only marks the ask as no longer working, so the next typed ask starts afresh;
  // an answer that ended on [D100%] with steps still unchecked fills the bar then.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, progress, (p): Progress => {
        if (p.phase !== 'working') return p
        if (p.percent === null) return { percent: null, phase: 'idle' }
        if (e.reason === 'answer' && finishing) return { percent: 100, phase: 'done' }
        return { ...p, phase: e.reason === 'answer' ? 'done' : 'stopped' }
      })
      await syncStatus($)
    }
    return next(e)
  })

  // A Remote Control client joining or leaving changes whether the status line carries the bar.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    await syncStatus($)
    return joined
  }).catch(($, e, next) => next(e))

  on('session.detach', async ($, e, next) => {
    const left = await next(e)
    await syncStatus($)
    return left
  }).catch(($, e, next) => next(e))

  // Tool calls that go by with no estimate get one reminder, attached to the third one's result
  // for the model alone; it says nothing again until the model has tagged.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || 'deny' in result && result.deny !== undefined) return result
    if ((await read($, progress)).phase !== 'working') return result
    untagged += 1
    if (untagged < REMIND_AFTER || reminded) return result
    reminded = true
    return { ...result, context: [...(result.context ?? []), REMINDER] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await listed($, applyPlan(statuses, e))
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && Array.isArray(e.todos)) await listed($, applyPlan([], { items: e.todos }))
    return result
  }).catch(($, e, next) => next(e))

  // The desktop app's wrap-up checks off the whole list.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && statuses.length > 0) await listed($, statuses.map(() => 'completed'))
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

  // The tags are for the bar, not the reader: a reply is drawn without them. The stored row loses
  // them in session.append; this is the live drawing, which the surface makes before that.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = stripTags(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // A terminal keeps its own hint line under the prompt (its pills stay live) with a block bar
  // added at the end.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const bar = await shown($)
    if (bar === null || e.surface !== 'terminal') {
      return next(e)
    }
    return next({ ...e, props: { ...e.props, tail: `  ${textBar(bar)}` } })
  })
}

let lastError = ''

/**
 * The task list cuts the bar into sections and fills a finished step's, as it is checked off; the
 * step in progress is the model's estimate's to fill. A step that starts begins empty, unless the
 * response that started it tagged it.
 */
async function listed($: EngineInterface, next: string[]) {
  const before = tally(statuses)
  const after = tally(next)
  if (next.indexOf('in_progress') !== statuses.indexOf('in_progress') || after.done !== before.done || after.total !== before.total) {
    estimate = fresh !== null && fresh < 100 ? fresh : null
  }
  statuses = next
  await redraw($, false)
}

/**
 * Puts the bar where the list and the estimate say: with a list, the checked-off steps' sections
 * full and the estimate's share of the step in progress, so a new plan resets it to match; with
 * none, the estimate for the whole ask, only ever forward. A list change alone moves a bar that is
 * working; a tag moves any, a continuation's carrying on from where it was.
 */
async function redraw($: EngineInterface, tagged: boolean) {
  const list = tally(statuses)
  await update($, steps, () => list)
  await update($, progress, (p): Progress => {
    if (!tagged && p.phase !== 'working') return p
    if (p.percent === null && estimate === null && list.total < 1) return p
    const at = list.total > 0 ? place(estimate ?? 0, list) : settle(p.phase === 'idle' ? null : p.percent, estimate ?? 0)
    return { percent: at, phase: at >= 100 ? 'done' : 'working' }
  })
  await syncStatus($)
}

/** The bar in the band above the prompt, or the engine's own band when there's nothing to show. */
async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>, next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>) {
  const bar = await shown($)
  const ui = $.ui.resolve(e)
  if (bar === null || e.surface === 'terminal' || e.props.hasSurvey || !('Svg' in ui)) {
    return next(e)
  }
  const { Box } = ui
  const source = draw(bar.percent, bar.isDone, Math.max(1, (await read($, steps)).total))
  return (
    <Box flexGrow={1}>
      <ui.Svg
        source={source}
        alt={`Progress on the current request: ${bar.label}`}
        // With no width of its own the drawing is the browser's default 300px; one wider than any
        // band is held to the band's width, and the drawing lays out inside it at 100%.
        width={4000}
        height={H + 2 * PAD}
        // A frame, not an image: the app re-decodes an image whenever it redraws the band, which
        // replays any animation in it from the start, where a frame plays once from when it's
        // mounted and is only mounted again on a new source (which blanks it for a moment).
        isInteractive
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

/** The bar as text: 16 cells filling in eighths, so it moves smoothly, then the label. */
export function textBar(bar: { percent: number; label: string }): string {
  const cells = 16
  const eighths = Math.round((cells * 8 * bar.percent) / 100)
  const filled = '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? '▏▎▍▌▋▊▉'[(eighths % 8) - 1] : '')
  return `${filled}${'░'.repeat(cells - filled.length)} ${bar.label}`
}

// Only the terminal and the desktop app draw the band above the prompt and the hint line under it.
// While another surface is attached (a phone or claude.ai over Remote Control, VS Code), the text
// bar is also pinned as the mod's status line, which every surface draws.
const DRAWS_BAR = new Set(['terminal', 'desktop'])

async function syncStatus($: EngineInterface) {
  try {
    const surfaces = await $.session.surfaces()
    const bar = surfaces.some(s => !DRAWS_BAR.has(s)) ? await shown($) : null
    $.ui.status(bar === null ? undefined : textBar(bar))
  } catch {
    // Best effort: a missed status line never costs the bar or the tag stripping.
  }
}
