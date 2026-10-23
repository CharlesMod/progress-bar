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

// The bar's state the person has seen: written as it changes while the session is in view (the
// app attaches a session's view while the person is on it, and detaches it when they leave). It is
// kept in the session's state, which outlives the module: when the app starts the plugin afresh,
// a drawing of a state already seen is drawn finished rather than played again.
const shownState = atom({ plugin: 'progress-bar', key: 'shown' } as const, null as string | null)
const inView = atom({ plugin: 'progress-bar', key: 'inView' } as const, true)

/** The bar's state as one string: two equal ones draw the same bar. */
function stateKey(p: Progress, st: Steps): string {
  return `${p.percent}|${p.phase}|${p.quiet === true}|${st.total}|${st.done}|${st.workers ?? 0}`
}

/** Marks the bar's state now as seen, when the session is in view. */
async function seen($: EngineInterface) {
  if (!(await read($, inView))) return
  const key = stateKey(await read($, progress), await read($, steps))
  if ((await read($, shownState)) !== key) await update($, shownState, () => key)
}

// `[D20.9%]`; the leading D is optional so a plain `[20.9%]` counts too.
const TAG = /\[D?\s*(\d{1,3}(?:\.\d+)?)\s*%\]/g

const INSTRUCTIONS = `# Progress estimate

The person tracks your progress on their latest request with a progress bar. Each time you write text to them while working on it (a status update between tool calls, a note on what you found or will do next), include your honest estimate of how complete the work is, as a tag like [D20.9%], anywhere in that text.

- While you keep a task list, the bar has one section per step and the tag is your estimate for the step you have in progress: [D50%] means that step is half done. A section fills only when its step is checked off, and a message that checks off a step tags the step it starts. With no list, the tag is your estimate for the whole request.
- The bar only moves forward: a lower estimate than an earlier one leaves it where it is, so don't overshoot early.
- The bar reads a tag only once the message carrying it has finished streaming. So as soon as you judge the work done, say [D100%] at the very start of the message that says so, before the rest of your final answer, not at its end. If you know the work is done before a last tool call (a final check, a commit), put [D100%] in the update before that call. Leave the tag out of replies to quick questions that take no work.
- The tag is removed from your message before it's saved, so you won't see your earlier estimates; judge each one fresh.`

// When the person adds to an ask while it works (or right after stopping it), the model is asked
// for a fresh estimate; one this far below the bar rolls it back, as the ask has grown. A smaller
// drop is the usual noise, and the bar holds.
export const ROLLBACK_MIN = 15

/** The note the model gets beside the person's message, with what the bar shows now. */
export function rescope(shown: number, hasList: boolean): string {
  const at = `${Math.round(shown)}%`
  return hasList
    ? `The person added to their request while you were working on it. The progress bar shows ${at} through your task list. If what they asked for adds work, update the list, and in your next update to them give a fresh tag like [D40%] for the step you then have in progress.`
    : `The person added to their request while you were working on it. The progress bar shows ${at}. In your next update to them, give a fresh tag like [D40%] for where the whole request now stands, counting any new work they asked for: if it is much more than was left, a lower estimate is right, and the bar goes back to it.`
}

// After this many tool calls in a row with no estimate, the next result carries a reminder; one
// the model lets pass is said again after this many more, while the step (or the ask) goes on.
const REMIND_AFTER = 3
const REMIND_AGAIN = 8

// The tools that keep the task list.
const LIST_TOOLS = new Set(['TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up'])

/** The reminder for a lapse: with a list, the step in progress's section stays empty until tagged. */
export function reminder(hasList: boolean): string {
  return hasList
    ? `The progress bar's section for the step you have in progress stays empty until you estimate it: it has had no estimate for several tool calls. Include a tag like [D40%] in your next update to the person, with how far along that step is (not the whole request).`
    : `The progress bar has had no estimate for several tool calls. Include a tag like [D40%] in your next update to the person, with your estimate for the whole request.`
}

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

// A command's own count: a `PROGRESS 3/4` or `PROGRESS 40%` marker anywhere, or a line that opens
// with `N of M` (after any indent or markup), as a gate's batch lines do.
const MARKER = /\bPROGRESS\s+(\d+)\s*(?:\/\s*(\d+)|%)/g
const COUNT = /^(?:\s|<[^>]*>)*(\d+) of (\d+)\b/gm
// A test runner's `[ 45%]` at a line's end (pytest), and a build's `[12/40]` at its start (ninja).
const PERCENT_END = /\[\s*(\d{1,3})%\]\s*$/gm
const BRACKETED = /^\s*\[(\d+)\/(\d+)\]/gm

/** How far (0-100) the last count in a command's output says it has got, or null with none. */
export function progressIn(text: string): number | null {
  let found: { at: number; percent: number } | null = null
  const consider = (at: number, done: number, total: number | null) => {
    const percent = total === null ? done : total > 0 && done <= total ? (done / total) * 100 : null
    if (percent !== null && percent <= 100 && (found === null || at >= found.at)) found = { at, percent }
  }
  for (const m of text.matchAll(MARKER)) consider(m.index!, Number(m[1]), m[2] === undefined ? null : Number(m[2]))
  for (const m of text.matchAll(COUNT)) consider(m.index!, Number(m[1]), Number(m[2]))
  for (const m of text.matchAll(PERCENT_END)) consider(m.index!, Number(m[1]), null)
  for (const m of text.matchAll(BRACKETED)) consider(m.index!, Number(m[1]), Number(m[2]))
  return found === null ? null : (found as { percent: number }).percent
}

// The tools whose output is a command's own: a file read or a search that quotes a count is not.
const COMMANDS = new Set(['Bash', 'BashOutput', 'TaskOutput', 'Monitor'])

/** The text of a row's blocks, a tool result's included. */
function rowText(content: readonly { type: string; [field: string]: unknown }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool_result') {
      const inner = block.content
      if (typeof inner === 'string') parts.push(inner)
      else if (Array.isArray(inner)) for (const b of inner) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n')
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
// The fill's rounded corners, across (in the bar's stretched units) and down (in pixels): the
// outline's own corners, less the gap between them, so the fill's ends sit inside it evenly.
const FILL_RX = 3
const FILL_RY = 2.5
// The light flowing along a working fill: one band every FLOW_U units, moving one band a FLOW_S.
const FLOW_U = 160
const FLOW_S = 1.4
// The rings closing in on an empty working bar: RINGS of them, spread evenly over a RING_S loop,
// each starting RING_OUT pixels outside the outline.
const RINGS = 3
const RING_S = 2.4
const RING_OUT = 5
// About how many of the bar's stretched units a pixel is across, on a band of a usual width, so
// a ring grows as far out at its ends as above and below.
const U_PER_PX = 1.4

// Bubbles rising through a working fill, in a few layers, each a tile of bubbles repeated along
// the bar and moved up one tile a loop: tiles of unlike widths, so the layers' bubbles fall
// irregularly against each other, and loops of unlike lengths and easings, so they rise at their
// own speeds, some gathering pace, some slowing. One animated attribute a layer.
const BUBBLES: { u: number; s: number; ease: string; dots: [number, number, number][] }[] = [
  { u: 137, s: 2.3, ease: '0.5 0 0.9 0.6', dots: [[18, 0.3, 2], [91, 0.8, 1.4]] },
  { u: 211, s: 3.7, ease: '0.2 0.5 0.6 1', dots: [[57, 0.15, 2.4], [160, 0.6, 1.2]] },
  { u: 173, s: 5.1, ease: '0.4 0 0.6 1', dots: [[33, 0.5, 1.6], [122, 0.1, 1.9], [149, 0.85, 1.1]] },
]

/** The rising bubbles' layers, as patterns laid over a fill `inset` pixels from the outline. */
function bubbles(inset: number, loopAt: (period: number) => string): string {
  const h = H - 2 * inset
  return BUBBLES.map(({ u, s, ease, dots }, i) => {
    // A bubble: a light ring round a faint, see-through middle. Across, in stretched units, it is
    // drawn about half again as wide as it is tall, so it reads round on a bar the band squeezes.
    // A tile clips what crosses its edge, so each is drawn again a tile above and below: the part
    // cut off one edge shows at the other, and a bubble rises through it whole.
    const rings = dots.flatMap(([x, y, r]) => [-h, 0, h].map(dy => `<ellipse cx="${x}" cy="${(y * h + dy).toFixed(2)}" rx="${(r * 1.5).toFixed(2)}" ry="${r}" fill="#fff" fill-opacity="0.12" stroke="#fff" stroke-opacity="0.55" stroke-width="0.7" vector-effect="non-scaling-stroke"/>`)).join('')
    return `<pattern id="bubbles${i}" patternUnits="userSpaceOnUse" x="0" y="${inset}" width="${u}" height="${h}">${rings}<animateTransform attributeName="patternTransform" type="translate" values="0 0;0 ${-h}" keyTimes="0;1" calcMode="spline" keySplines="${ease}" dur="${s}s" begin="${loopAt(s)}" repeatCount="indefinite"/></pattern>`
  }).join('')
}

// The fill's easing: a gentle start and a long, soft landing (a cubic bezier from time to distance,
// as SMIL spells it), so a move glides to a stop rather than braking at its end.
const EASE = { x1: 0.35, y1: 0, x2: 0.1, y2: 1 }
const KEY_SPLINE = `${EASE.x1} ${EASE.y1} ${EASE.x2} ${EASE.y2}`

/** Seconds the fill takes to ease from `from` to `to`: a short move is quick, a long one unhurried. */
export function fillSeconds(from: number, to: number): number {
  return to - from < 0.0005 ? 0 : 0.6 + 1.5 * (to - from)
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
 * when the ask is done. `from` and `to` are places on the bar, whose sections end at `edges`; the
 * fill starts `delay` seconds into the drawing.
 */
export function blinkTimes(from: number, to: number, n: number, isDone: boolean, edges = layout(n, n), delay = 0): { i: number; at: number }[] {
  if (n < 2 || to - from < 0.0005) return []
  const seconds = fillSeconds(from, to)
  const times: { i: number; at: number }[] = []
  for (let i = 0; i < n - (isDone ? 1 : 0); i++) {
    const end = edges[i + 1]!
    if (from < end - 0.0005 && end <= to + 0.0005) {
      const arrival = delay + seconds * easeTime((end - from) / (to - from))
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

// The share of the bar the step in progress takes, the others sharing the rest, and how long the
// sections take to slide to their new widths when a step is checked off.
export const ZOOM = 0.65
export const REFLOW_S = 0.5

// A drawing's clock starts as its frame begins to load, before the band shows it; everything in it
// waits this long first, so a move plays on screen rather than while the frame is still blank.
export const LEAD_S = 0.3

/**
 * Where the sections' edges fall (0-1 along the bar) for `n` steps with step `current` in progress:
 * it takes ZOOM of the bar and the others share the rest; with no step in progress, or no more room
 * to give it than its equal share, they are equal.
 */
export function layout(n: number, current: number, zoom = ZOOM): number[] {
  if (n < 2 || current < 0 || current >= n || zoom <= 1 / n) return Array.from({ length: n + 1 }, (_, i) => i / n)
  const rest = (1 - zoom) / (n - 1)
  const edges = [0]
  for (let i = 0; i < n; i++) edges.push(edges[i]! + (i === current ? zoom : rest))
  edges[n] = 1
  return edges
}

/** Where on the bar (0-1) a place `p` of the way through the ask (0-1, its steps equal) is drawn. */
export function onBar(p: number, edges: readonly number[]): number {
  const n = edges.length - 1
  if (p >= 1) return 1
  const i = Math.min(n - 1, Math.floor(p * n + 1e-9))
  return edges[i]! + (p * n - i) * (edges[i + 1]! - edges[i]!)
}

// The bar's own units: the band stretches them to its width, so a section's place and width are
// plain numbers the drawing can ease (a CSS length with calc() can't be).
const U = 1000
const GAP_U = 5
const INSET_U = 3
// The room left of and right of the bar for its glow, in the same units: the bar and everything
// around it lay out in one stretched span, so nothing needs a calc() (which a nested drawing's
// width doesn't take).
const MARGIN_U = 11
const SPAN_U = U + 2 * MARGIN_U

/** An eased move of one attribute, `begin` seconds in, or nothing when it doesn't move. */
function ease(attribute: string, from: number, to: number, seconds: number, begin = 0): string {
  return seconds > 0 && Math.abs(from - to) >= 0.01
    ? `<animate attributeName="${attribute}" from="${from.toFixed(2)}" to="${to.toFixed(2)}" dur="${seconds}s" begin="${Math.max(MIN_BEGIN_S, begin).toFixed(3)}s" calcMode="spline" keyTimes="0;1" keySplines="${KEY_SPLINE}" fill="freeze"/>`
    : ''
}

/**
 * Moves every animation in `markup` out of it, each pointed at the element it animated by an id
 * (one given where the element had none). A nested <svg> can run its animations on a clock of its
 * own that a Chromium page doesn't always start, so a drawing's animations all go on the outermost
 * <svg> and still drive the elements inside.
 */
export function hoist(markup: string, prefix = 'm'): { markup: string; animations: string } {
  const out: string[] = []
  const animations: string[] = []
  const open: { at: number; id: string | null }[] = []
  let next = 0
  let last = 0
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    out.push(markup.slice(last, m.index))
    last = m.index! + m[0].length
    const [tag, closing, name, , selfClosing] = m
    if (closing) {
      open.pop()
      out.push(tag)
    } else if (selfClosing && /^(animate|animateTransform|animateMotion|set)$/.test(name!) && open.length > 0) {
      const parent = open[open.length - 1]!
      if (parent.id === null) {
        const has = out[parent.at]!.match(/\sid="([^"]+)"/)
        parent.id = has ? has[1]! : `${prefix}${next++}`
        if (!has) out[parent.at] = out[parent.at]!.replace(/^<([a-zA-Z][\w:-]*)/, `<$1 id="${parent.id}"`)
      }
      animations.push(tag.replace(/^<([a-zA-Z][\w:-]*)/, `<$1 href="#${parent.id}"`))
    } else {
      out.push(tag)
      if (!selfClosing) open.push({ at: out.length - 1, id: null })
    }
  }
  out.push(markup.slice(last))
  return { markup: out.join(''), animations: animations.join('\n') }
}

// The earliest any animation in a drawing begins. The desktop app runs a drawing's clock for a
// while before it shows the drawing, and an animation that begins at 0 is over (shown at its end)
// by then; one that begins any later plays from its start, in view.
export const MIN_BEGIN_S = 0.05

/** When a drawing's last animation ends, in seconds from when it is shown. */
export function endOf(svg: string): number {
  let end = 0
  for (const m of svg.matchAll(/<(?:animate|animateTransform|animateMotion|set)\b[^>]*>/g)) {
    const begin = Number(m[0].match(/\bbegin="(-?[\d.]+)s"/)?.[1] ?? 0)
    const dur = Number(m[0].match(/\bdur="([\d.]+)s"/)?.[1] ?? 0)
    end = Math.max(end, begin + dur)
  }
  return end
}

/**
 * The drawing as it stands `elapsed` seconds after it was first shown: every animation begun that
 * much earlier. One begun and over by then is drawn finished; one that hasn't begun keeps a begin
 * of at least MIN_BEGIN_S, so it still plays in view. Past the drawing's end it's one still string,
 * which is how a drawing is drawn once the person comes back to the session.
 */
export function played(svg: string, elapsed: number): string {
  if (elapsed <= 0) return svg
  const by = Math.min(elapsed, endOf(svg) + 0.001)
  return svg.replace(/\bbegin="(-?[\d.]+)s"/g, (_, b: string) => {
    const at = Number(b) - by
    return `begin="${(at > 0 ? Math.max(MIN_BEGIN_S, at) : at).toFixed(3)}s"`
  })
}

// A finished ask's bar holds this long after its last animation, then fades out over FADE_S, until
// the next ask brings it back.
const FADE_HOLD_S = 1.2
const FADE_S = 0.8

/** The drawing, fading out once its last animation has ended and held a moment. */
export function fadingOut(svg: string): string {
  const at = Math.max(MIN_BEGIN_S, endOf(svg) + FADE_HOLD_S)
  const open = svg.indexOf('>') + 1
  const close = svg.lastIndexOf('</svg>')
  return `${svg.slice(0, open)}<g><animate attributeName="opacity" from="1" to="0" begin="${at.toFixed(3)}s" dur="${FADE_S}s" fill="freeze"/>${svg.slice(open, close)}</g>${svg.slice(close)}`
}

/**
 * One attribute eased through `points` (seconds, value), holding between them, frozen at the last.
 * A hold at the start is the animation's begin, never part of it, so it never begins at 0.
 */
function path(attribute: string, points: readonly [number, number][]): string {
  let kept = points.filter(([t], i) => i === 0 || t - points[i - 1]![0] > 1e-6)
  if (kept.length < 2 || kept.every(([, v]) => Math.abs(v - kept[0]![1]) < 0.005)) return ''
  while (kept.length > 2 && Math.abs(kept[1]![1] - kept[0]![1]) < 0.005) kept = kept.slice(1)
  const begin = Math.max(MIN_BEGIN_S, kept[0]![0])
  const shift = begin - kept[0]![0]
  const end = kept[kept.length - 1]![0] + shift
  const dur = end - begin
  return `<animate attributeName="${attribute}" values="${kept.map(([, v]) => v.toFixed(2)).join(';')}" keyTimes="${kept.map(([t]) => ((t + shift - begin) / dur).toFixed(4)).join(';')}" calcMode="spline" keySplines="${kept.slice(1).map(() => KEY_SPLINE).join(';')}" begin="${begin.toFixed(3)}s" dur="${dur.toFixed(3)}s" fill="freeze"/>`
}

/**
 * The bar: a rounded outline across the band with an inset fill that eases from `from` to `to`
 * (fractions of the ask, its steps equal) and stays there. With `n` steps the bar is cut into
 * sections, the step in progress (`slices.at`) zoomed to ZOOM of it; when that step is not the one
 * the last drawing zoomed (`was`), the sections first slide to their new widths, the fill keeping
 * to them, and then the fill eases on. The fill reveals a fixed blue-to-green ramp laid along the
 * whole bar, so its colour follows how far it has got. Each section the move finishes blinks gold
 * as the fill passes its end; when the ask is done the outline turns gold on arrival and the
 * finale plays once, leaving a soft gold glow. Everything in it plays from when the drawing is
 * mounted and freezes where it ends, so a drawing is one state and never needs another to finish
 * it. Explicit colours: the drawing doesn't inherit currentColor, and the band refuses a drawing
 * with a <style> element.
 */
export function battery(from: number, to: number, isDone: boolean, n = 1, slices = { at: 0, of: 0 }, was = slices.at, stepBlinks = true, made: number | null = null): string {
  // The loops (the flowing light, the bubbles) keep to the wall clock when the drawing says when it
  // was made: each new drawing picks them up where the last one's were, rather than starting them
  // over, which the eye reads as a flicker. A drawing on its own starts them after LEAD_S.
  // `lag` holds a loop that many seconds behind the clock, for one that follows another.
  const loopAt = (period: number, lag = 0) => made === null
    ? `${(LEAD_S + lag).toFixed(3)}s`
    : `${(-((((made - lag) % period) + period) % period)).toFixed(3)}s`
  // Whole pixels, so the fill's top and bottom edges are crisp: a half-pixel edge is drawn half
  // see-through, and where the drawing beneath shows through it, the fill looks a pixel thicker.
  const inset = 3
  // A place along the bar (0-1) as a share of the drawing's width, for what is drawn unstretched.
  const along = (k: number) => `${(((MARGIN_U + k * U) / SPAN_U) * 100).toFixed(3)}%`
  const edges = layout(n, slices.at)
  const before = layout(n, was)
  const reflow = before.some((x, i) => Math.abs(x - edges[i]!) > 1e-6) ? REFLOW_S : 0
  // A check-off plays out in the old layout first: the fill reaches the end of the steps checked
  // off while they are still wide and they blink there; only then do the sections slide to their
  // new widths, and the fill eases on into the step in progress.
  const finished = reflow > 0 && was < slices.at ? Math.max(from, Math.min(to, slices.at / n)) : from
  const a = onBar(from, before)
  const m1 = onBar(finished, before)
  const reach = LEAD_S + fillSeconds(a, m1)
  // A drawing made on the person's return blinks no step: they finished while the person was away.
  const blinksBefore = stepBlinks ? blinkTimes(a, m1, n, isDone, before, LEAD_S) : []
  const slideAt = reflow > 0 ? Math.max(reach, ...blinksBefore.map(({ at }) => at + SECTION_BLINK_S)) : LEAD_S
  const m2 = onBar(finished, edges)
  const c = onBar(to, edges)
  const fillAt = slideAt + reflow
  const seconds = fillSeconds(m2, c)
  const total = fillAt + seconds
  // The fill keeps to its place through the sections' slide, then eases to the new estimate.
  const W = U - 2 * INSET_U
  const move = path('width', [[0, a * W], [LEAD_S, a * W], [reach, m1 * W], [slideAt, m1 * W], [fillAt, m2 * W], [total, c * W]])
  // The fill's leading edge is rounded, a meniscus rather than a cut. While the ask works, a soft
  // light flows along it, as a loading bar does; a finished ask's fill is still.
  const fill = (attributes: string) => `<rect ${attributes} x="${INSET_U}" y="${inset}" height="${H - 2 * inset}" rx="${FILL_RX}" ry="${FILL_RY}" width="${((move ? a : c) * W).toFixed(2)}">${move}</rect>`
  const body = fill('data-fill="" fill="url(#ramp)"') + (isDone ? '' : BUBBLES.map((_, i) => fill(`fill="url(#bubbles${i})"`)).join('') + fill('fill="url(#flow)"'))
  // The outline turns gold as the fill arrives at the end of a finished ask.
  const outlineAt = (begin: number) => isDone
    ? `<animate attributeName="stroke" to="#d9a521" dur="0.25s" begin="${begin.toFixed(3)}s" fill="freeze"/>`
    : ''
  // With a task list, the one fill shows through n sections, so it moves exactly as one bar does
  // and reads as one bar filling across them. A section slides from its last place to its new one.
  const place = (e: readonly number[], i: number, grow: number) => {
    const start = (i === 0 ? 0 : GAP_U / 2) - grow
    const end = (i === n - 1 ? 0 : GAP_U / 2) - grow
    return { x: e[i]! * U + start, w: (e[i + 1]! - e[i]!) * U - start - end }
  }
  const section = (i: number, grow: number, attributes: string, inner = '') => {
    const o = place(before, i, grow)
    const m = place(edges, i, grow)
    const at = reflow > 0 ? o : m
    return `<rect x="${at.x.toFixed(2)}" width="${at.w.toFixed(2)}" ${attributes}>${ease('x', o.x, m.x, reflow, slideAt)}${ease('width', o.w, m.w, reflow, slideAt)}${inner}</rect>`
  }
  const cut = n > 1
    ? `<clipPath id="sec">${Array.from({ length: n }, (_, i) => section(i, -INSET_U, `y="${inset}" height="${H - 2 * inset}" rx="3" ry="2.5"`)).join('')}</clipPath>`
    : ''
  // The step in progress is cut once more, faintly, into a slice per worker it sent out.
  const span = (edges[slices.at + 1] ?? 1) - (edges[slices.at] ?? 0)
  const ticks = slices.of > 1 && slices.at < n
    ? Array.from({ length: slices.of - 1 }, (_, k) =>
      `<rect data-tick="" x="${(((edges[slices.at] ?? 0) + span * (k + 1) / slices.of) * U).toFixed(2)}" y="${inset + 2}" width="1.2" height="${H - 2 * inset - 4}" fill="#8a8a8a" opacity="${reflow > 0 ? 0 : 0.7}">${reflow > 0 ? `<animate attributeName="opacity" to="0.7" dur="0.2s" begin="${fillAt.toFixed(3)}s" fill="freeze"/>` : ''}</rect>`).join('')
    : ''
  const blinksAfter = stepBlinks ? blinkTimes(m2, c, n, isDone, edges, fillAt) : []
  const finaleAt = Math.max(total, ...[...blinksBefore, ...blinksAfter].map(({ at }) => at + SECTION_BLINK_S))
  const stroke = 'fill="none" stroke="#8a8a8a" stroke-width="1" vector-effect="non-scaling-stroke"'
  const outlines = n > 1
    ? Array.from({ length: n }, (_, i) => section(i, 0.5, `y="0.5" height="${H - 1}" rx="${n > 6 ? 3.5 : 5}" ry="${n > 6 ? 3 : 4}" ${stroke}`, outlineAt(finaleAt))).join('')
    : `<rect x="0.5" y="0.5" width="${U - 1}" height="${H - 1}" rx="5" ry="4" ${stroke}>${outlineAt(finaleAt)}</rect>`
  // A section the move finishes blinks gold where it stands then, with a few sparkles, one after
  // another: a step checked off blinks while it is still wide.
  const blinks = [...blinksBefore.map(b => ({ ...b, e: before })), ...blinksAfter.map(b => ({ ...b, e: edges }))]
  const blinking = blinks.map(({ i, at, e }) => {
    const m = place(e, i, 1.5)
    return `<rect x="${m.x.toFixed(2)}" width="${m.w.toFixed(2)}" y="-1.5" height="${H + 2}" rx="6" ry="5" fill="none" stroke="#ffd54a" stroke-width="2" vector-effect="non-scaling-stroke" filter="url(#glow)" opacity="0"><animate attributeName="opacity" values="0;1;0;1;0" dur="${SECTION_BLINK_S}s" begin="${at.toFixed(3)}s" fill="freeze"/></rect>`
  }).join('')
  // The sparkles stay outside the stretched units, so they keep their shape.
  const sparkles = blinks
    .map(({ i, at, e }) => [0.2, 0.5, 0.8].map((k, j) => sparkle(along(e[i]! + k * (e[i + 1]! - e[i]!)), j % 2 ? -2 : H + 2, 0.6, at + 0.05 + j * 0.08)).join(''))
    .join('')
  // The ask's end: a shine sweeps across, the gold border blinks three times and settles to a
  // glow, and a burst of sparkles pops along the bar. The glow stays.
  // The shine sweeps in the bar's own units: an eased number, where a percentage doesn't move.
  const shine = isDone
    ? `<rect clip-path="url(#c)" x="-80" y="0" width="70" height="${H}" fill="url(#shine)" transform="skewX(-35)" opacity="0">
  <animate attributeName="opacity" to="1" dur="0.01s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/>
  <animate attributeName="x" from="-80" to="${U + 80}" dur="${SHINE_S}s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/>
</rect>`
    : ''
  const flourish = isDone
    ? `<rect x="-2" width="${U + 4}" y="-1.5" height="${H + 2}" rx="6" ry="5" fill="none" stroke="#ffd54a" stroke-width="3" vector-effect="non-scaling-stroke" filter="url(#glow)" opacity="0"><animate attributeName="opacity" values="${BLINKS.join(';')}" dur="${BLINK_S}s" begin="${finaleAt.toFixed(3)}s" fill="freeze"/></rect>
`
    : ''
  // An empty bar of a working ask isn't left blank: rings of the outline's own shape close in on
  // it from just outside, one after another, fading as they arrive, until the first estimate
  // gives the fill something to show.
  const rings = !isDone && from === 0 && to === 0
    ? Array.from({ length: RINGS }, (_, i) => {
      const begin = loopAt(RING_S, (i * RING_S) / RINGS)
      const at = (out: number) => ({ x: 0.5 - out * U_PER_PX, y: 0.5 - out, w: U - 1 + 2 * out * U_PER_PX, h: H - 1 + 2 * out })
      const a = at(RING_OUT)
      const b = at(0)
      const loop = (name: string, from: number, to: number) => `<animate attributeName="${name}" values="${from.toFixed(2)};${to.toFixed(2)}" keyTimes="0;1" calcMode="spline" keySplines="0.3 0 0.4 1" dur="${RING_S}s" begin="${begin}" repeatCount="indefinite"/>`
      return `<rect x="${a.x.toFixed(2)}" y="${a.y.toFixed(2)}" width="${a.w.toFixed(2)}" height="${a.h.toFixed(2)}" rx="7" ry="6" fill="none" stroke="#7fb0ec" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0">${loop('x', a.x, b.x)}${loop('y', a.y, b.y)}${loop('width', a.w, b.w)}${loop('height', a.h, b.h)}<animate attributeName="opacity" values="0;0.55;0" keyTimes="0;0.45;1" dur="${RING_S}s" begin="${begin}" repeatCount="indefinite"/></rect>`
    }).join('')
    : ''
  const burst = isDone ? SPARKLES.map((k, j) => sparkle(along(k), j % 2 ? -2 : H + 2, 1.3, finaleAt + 0.1 + j * 0.08)).join('\n') : ''
  // The stretched bar is a nested <svg>; its animations are hoisted onto the outer one.
  const stretched = hoist(`<svg x="0" y="0" width="100%" height="${H}" viewBox="${-MARGIN_U} 0 ${SPAN_U} ${H}" preserveAspectRatio="none" overflow="visible">
<defs><linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="0" x2="${U}" y1="0" y2="0"><stop offset="0" stop-color="#4a8ce0"/><stop offset="0.45" stop-color="#3fc7a0"/><stop offset="1" stop-color="#00dc00"/></linearGradient>
${isDone ? '' : `<linearGradient id="flow" gradientUnits="userSpaceOnUse" x1="0" x2="${FLOW_U}" y1="0" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/><animateTransform attributeName="gradientTransform" type="translate" from="0" to="${FLOW_U}" dur="${FLOW_S}s" begin="${loopAt(FLOW_S)}" repeatCount="indefinite"/></linearGradient>`}
${isDone ? '' : bubbles(inset, loopAt)}
<clipPath id="c"><rect x="0" y="0" width="${U}" height="${H}" rx="5" ry="4"/></clipPath>${cut}</defs>
${outlines}
${n > 1 ? `<g clip-path="url(#sec)">${body}</g>` : body}
${ticks}
${blinking}
${rings}
${shine}
${flourish}
</svg>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H + 2 * PAD}" overflow="visible">
<defs>
<path id="star" d="M0 -4 L1.1 -1.1 L4 0 L1.1 1.1 L0 4 L-1.1 1.1 L-4 0 L-1.1 -1.1 Z" fill="#fff3b0"/>
<filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<g transform="translate(0 ${PAD})">
${stretched.markup}
${sparkles}
${burst}
</g>
${stretched.animations}
</svg>`
}

// What the bar learns across sessions, from the person's own work: how many tool calls each
// finished step took (each finished ask with no list), and what the model's estimates turned out
// to mean, as pairs of [what it said, the share of the step's calls it had made when it said it].
export type History = { steps: number[]; asks: number[]; said: [number, number][] }
const KEEP = 60
const KEEP_SAID = 300
// The finished steps (or asks) a fill from calls needs before it is drawn at all.
const LEARN_MIN = 3
// An ask with no list shorter than this is a quick one, no guide to the long asks the bar is for;
// a step or an ask shorter than CALIBRATE_MIN says too little of what an estimate meant.
const ASK_MIN = 5
const CALIBRATE_MIN = 5
// A fill from calls alone never claims more than this: only a check-off or the model says done.
const INFER_CAP = 85
// How many estimates near one it takes for the learned meaning to count as much as the words.
const CALIBRATE_WEIGHT = 5

function emptyHistory(): History {
  return { steps: [], asks: [], said: [] }
}

/** A stored history, with anything that isn't one dropped. */
export function readHistory(value: unknown): History {
  const v = (value ?? {}) as Partial<Record<keyof History, unknown>>
  const counts = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && n >= 1) : [])
  const said = Array.isArray(v.said)
    ? v.said.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2 && pair.every(n => typeof n === 'number'))
    : []
  return {
    steps: counts(v.steps).slice(-KEEP),
    asks: counts(v.asks).filter(n => n >= ASK_MIN).slice(-KEEP),
    said: said.slice(-KEEP_SAID),
  }
}

/**
 * How far along (0-100) a step or an ask is after `calls` tool calls, from how many the finished
 * ones took: the mean share done over those that ran longer than this, so the longer it runs the
 * longer the work it is taken for. Capped short of done; null until there's enough history.
 */
export function inferred(calls: number, took: readonly number[]): number | null {
  if (took.length < LEARN_MIN || calls < 1) return null
  const longer = took.filter(k => k > calls)
  if (longer.length === 0) return INFER_CAP
  return Math.min(INFER_CAP, (longer.reduce((sum, k) => sum + calls / k, 0) / longer.length) * 100)
}

/**
 * What a model's estimate has meant: its words blended with the mean share of calls done when it
 * said about as much before (within 10), the more such the more the history counts. Done is done.
 */
export function calibrated(said: number, pairs: readonly [number, number][]): number {
  if (said >= 100) return said
  const near = pairs.filter(([s]) => Math.abs(s - said) <= 10)
  if (near.length < 1) return said
  const meant = near.reduce((sum, [, real]) => sum + real, 0) / near.length
  const weight = near.length / (near.length + CALIBRATE_WEIGHT)
  return Math.min(99, Math.max(0, weight * meant + (1 - weight) * said))
}

/** The history with one finished step (or ask) of `took` calls added, and its estimates' pairs. */
export function learnedFrom(h: History, kind: 'steps' | 'asks', took: number, tags: readonly [number, number][]): History {
  const said = took < CALIBRATE_MIN ? [] : tags.filter(([s]) => s < 100).map(([s, at]): [number, number] => [s, (100 * at) / took])
  const kept = kind === 'asks' && took < ASK_MIN ? h[kind] : [...h[kind], took].slice(-KEEP)
  return {
    ...h,
    [kind]: kept,
    said: [...h.said, ...said].slice(-KEEP_SAID),
  }
}

// Kept under a key of its own: an earlier key's history learned from quick asks and goes unread.
const HISTORY_KEY = 'history.2'
let history: History | null = null

/** The history, read once a load of the module; a store that can't be read is no history. */
async function learned($: EngineInterface): Promise<History> {
  if (history === null) {
    try {
      history = readHistory(await $.store.get(HISTORY_KEY))
    } catch {
      history = emptyHistory()
    }
  }
  return history
}

/** Adds the step (or ask) that just finished to the history, read afresh so other sessions' work is kept. */
async function learn($: EngineInterface, kind: 'steps' | 'asks') {
  const took = calls
  const said = tags
  calls = 0
  tags = []
  if (took < 1) return
  try {
    history = learnedFrom(readHistory(await $.store.get(HISTORY_KEY)), kind, took, said)
    await $.store.set(HISTORY_KEY, history)
  } catch {
    history = learnedFrom(history ?? emptyHistory(), kind, took, said)
  }
}

// Tool calls in the step in progress (the ask, with no list), and the model's estimates in it,
// each with the calls made when it was given.
let calls = 0
let tags: [number, number][] = []
// How many of `tags` the current response gave: a check-off later in it carries them to the step it starts.
let responseTags = 0
// Whether the model has tagged this ask at all: a fill from the history is no word of its.
let modelTagged = false
// Whether the ask left work running that will wake it (a background command or agent, a monitor,
// a scheduled wake-up), since its last wake.
let waiting = false

/** Whether a tool call leaves work running that will wake the session when it moves. */
function waits(e: { tool: string }): boolean {
  if (e.tool === 'Monitor' || e.tool === 'ScheduleWakeup' || e.tool === 'CronCreate') return true
  return (e.tool === 'Bash' || e.tool === 'Agent') && (e as { run_in_background?: unknown }).run_in_background === true
}

// The bar's last state: the fill eased to `to` (a fraction of the ask) from `from`, cut into `n`
// sections with step `at` zoomed, having slid from step `was` zoomed, with the ask done or not.
// The next estimate's drawing eases on from `to`.
type State = { from: number; to: number; isDone: boolean; n: number; at: number; was: number; stepBlinks: boolean; made: number }
let last: State | null = null

// Tool calls since the model's last estimate, and whether this lapse has had its reminder.
let untagged = 0
let reminded = false

// Whether the system prompt carries the instructions. A host that composes its prompt without the
// mods' sections leaves the model with no word of the bar, and with no task list to draw it the
// bar would wait on a tag that never comes: then an ask's first tool call carries them instead.
let composed = false
let instructed = false

// The task list's items' statuses, kept so a plan update that names no items can be applied.
let statuses: string[] = []

// The model's highest estimate for the step in progress (for the whole ask, with no list); the
// highest tag in its current response, which a check-off later in that response carries to the
// step it starts; and whether its last tag was [D100%].
let estimate: number | null = null
let fresh: number | null = null
let finishing = false

// The highest real word on the step (the ask, with no list): the model's tags, the history's fill,
// a command's count, workers back. `estimate` is that or the creep over it, whichever is higher.
let real: number | null = null
let creep: number | null = null

// Each tool call done creeps the bar this share of the way to a ceiling CREEP_ROOM of the way from
// the real word to CREEP_CAP: always a little forward, less each time, never the ceiling, and at
// most that much ahead of what anything has said.
const CREEP_RATE = 0.2
const CREEP_ROOM = 0.25
const CREEP_CAP = 90

/** Where the creep stands after one more tool call, from where it was and the real word under it. */
export function crept(was: number | null, said: number | null): number {
  const base = said ?? 0
  const from = Math.max(was ?? 0, base)
  const ceiling = Math.max(from, base + CREEP_ROOM * (CREEP_CAP - base))
  return from + CREEP_RATE * (ceiling - from)
}

/** A real word on the step moves the bar forward, never back, under or over the creep. */
function heard(percent: number) {
  real = settle(real, percent)
  estimate = settle(estimate, percent)
}

/** Forgets the last ask's drawing: a new ask starts its bar from empty. */
function startAsk() {
  waiting = false
  last = null
  untagged = 0
  reminded = false
  instructed = false
  statuses = []
  workers.clear()
  estimate = null
  real = null
  creep = null
  fresh = null
  finishing = false
  calls = 0
  tags = []
  modelTagged = false
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

// A new drawing remounts the band's frame, which blanks it for a moment: a move smaller than this
// share of the bar keeps the drawing it has, so small estimates don't blink the bar.
const MIN_MOVE = 0.03

/**
 * The drawing of the bar for `percent`: the same string for as long as nothing visible has changed,
 * so the band keeps the drawing it has (and whatever is playing in it plays on); an estimate that
 * moves the fill far enough to see is a new drawing that eases the fill on from the last one. A
 * change to the list alone redraws the bar where it is.
 */
export function draw(percent: number, isDone: boolean, n = 1, slices = { at: 0, of: 0 }, isReturn = false): string {
  const to = percent / 100
  const at = slices.at
  const edges = layout(n, at)
  const unseen = last !== null && last.isDone === isDone && last.n === n && last.at === at && to < 1
    && Math.abs(onBar(to, edges) - onBar(last.to, edges)) < MIN_MOVE
  if (!unseen && (last === null || last.to !== to || last.isDone !== isDone || last.n !== n || last.at !== at)) {
    // A drawing made on the person's return shows where the ask stands, as if it had all happened
    // in view: no fill moving, no section sliding, no step blinking; only a finished ask's finale.
    const from = isReturn ? to : last === null ? 0 : last.to === to ? to : Math.min(to, last.to)
    // The sections slide only between two layouts of the same list.
    const was = isReturn ? at : last !== null && last.n === n ? last.at : at
    // How a drawing was made stays its own: a later redraw of it draws it the same.
    last = { from, to, isDone, n, at, was, stepBlinks: !isReturn, made: Date.now() / 1000 }
  }
  return battery(last.from, last.to, last.isDone, n, slices, last.was, last.stepBlinks, last.made)
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    composed = true
    return {
      sections: [...sections, { id: 'progress-bar:instructions', text: INSTRUCTIONS, scope: 'session' }],
    }
  })

  // A background task's notification wakes a turn of the same ask, carrying what it says: its count
  // moves the bar, and the turn it starts is no new ask.
  on('prompt.submit', async ($, e, next) => {
    const notified = e.origin.kind === 'task-notification'
    if (notified) {
      woken = true
      waiting = false
      await counted($, progressIn(e.text))
      return next(e)
    }
    woken = false
    // The person adds to an ask still working, or one they just stopped: the model is asked where
    // it stands now, and its next tag may roll the bar back if the ask has grown a lot.
    const p = await read($, progress)
    if ((p.phase === 'working' || p.phase === 'stopped') && e.command === undefined && e.isMeta !== true && e.text.trim() !== '') {
      rescoping = p.percent ?? 0
      return next({ ...e, context: [...(e.context ?? []), rescope(rescoping, statuses.length > 0)] })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A typed ask starts a new bar, empty and on screen from the start. A message sent while an ask
  // is still working joins it, and a continuation turn (empty text) or one a notification woke
  // keeps it.
  on('turn.start', async ($, e, next) => {
    const wasWoken = woken
    woken = false
    if (e.agentId === undefined && e.text !== '' && !wasWoken) {
      const { phase } = await read($, progress)
      // A message right after stopping an ask carries it on, to be re-estimated.
      if (phase === 'stopped' && rescoping !== null) {
        await update($, progress, (p): Progress => ({ ...p, phase: 'working' }))
        await syncStatus($)
      } else if (phase !== 'working') {
        await update($, progress, (): Progress => ({ percent: 0, phase: 'working' }))
        await update($, steps, (): Steps => ({ total: 0, done: 0 }))
        startAsk()
        await seen($)
        await syncStatus($)
      }
    }
    return next(e)
  })

  // A command's output on the main loop moves the step in progress by its own count.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const origin = e.origin as { kind: string; tool?: string }
    if (e.agentId === undefined && origin.kind === 'tool' && origin.tool !== undefined && COMMANDS.has(origin.tool)) {
      await counted($, progressIn(rowText(e.message.content)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'model' && e.message.type === 'assistant') {
      const texts = e.message.content.flatMap(block =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
      )
      const percent = lastPercent(texts)
      if (percent !== null) {
        untagged = 0
        reminded = false
        tags.push([percent, calls])
        responseTags += 1
        modelTagged = true
        const meant = calibrated(percent, (await learned($)).said)
        // The first tag after the person added to the ask: well below the bar, the bar goes back.
        let rewind = false
        if (rescoping !== null) {
          const list = tally(statuses)
          const now = (await read($, progress)).percent ?? 0
          rewind = (list.total > 0 ? place(meant, list) : meant) < now - ROLLBACK_MIN
          rescoping = null
        }
        if (rewind) {
          real = meant
          estimate = meant
          creep = null
        } else {
          heard(meant)
        }
        fresh = settle(fresh, meant)
        finishing = percent >= 100
        await redraw($, true, rewind)
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
    if (e.agentId === undefined) {
      fresh = null
      responseTags = 0
    }
    return yield* next(e)
  })

  // The turn's end only marks the ask as no longer working, so the next typed ask starts afresh;
  // an answer that ended on [D100%] with steps still unchecked fills the bar then. A worker's turn
  // ending is that worker back.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && workers.get(e.agentId) === false) {
      workers.set(e.agentId, true)
      await workersMoved($)
    } else if (e.agentId === undefined) {
      // Learning the ask resets its count, so whether it did any work is read first.
      const worked = calls > 0
      if (e.reason === 'answer' && statuses.length === 0 && (await read($, progress)).phase === 'working') await learn($, 'asks')
      await update($, progress, (p): Progress => {
        if (p.phase !== 'working') return p
        if (p.percent === null) return { percent: null, phase: 'idle' }
        if (e.reason === 'answer' && finishing) return { percent: 100, phase: 'done' }
        // A quick answer (no tool calls, no estimate) fills its bar, without the finale.
        if (e.reason === 'answer' && !modelTagged && statuses.length === 0 && !worked) return { percent: 100, phase: 'done', quiet: true }
        // An answer ends the ask, whatever the last estimate said: the bar fills, its finale plays,
        // and it fades. Only a stopped ask keeps where it stood.
        // An ask that ends its turn to wait on work it left running holds, until that work wakes it.
        if (e.reason === 'answer' && waiting) return { ...p, phase: 'done' }
        return e.reason === 'answer' ? { percent: 100, phase: 'done' } : { ...p, phase: 'stopped' }
      })
      await seen($)
      await syncStatus($)
    }
    return next(e)
  })

  // A Remote Control client joining or leaving changes whether the status line carries the bar.
  on('session.attach', async ($, e, next) => {
    // The app attaches a session's view when the person comes back to it (and draws nothing while
    // they're away): the next drawing is made for their return.
    returning = true
    await update($, inView, () => true)
    const joined = await next(e)
    await seen($)
    await syncStatus($)
    return joined
  }).catch(($, e, next) => next(e))

  on('session.detach', async ($, e, next) => {
    await update($, inView, () => false)
    const left = await next(e)
    await syncStatus($)
    return left
  }).catch(($, e, next) => next(e))

  // A worker the main loop sends out while a step is in progress is a slice of that step, filled
  // when its turn ends (in turn.complete). A worker's own helpers are its business.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (e.parentAgentId === undefined && result.agentId !== undefined && statuses.includes('in_progress')) {
      workers.set(result.agentId, false)
      await workersMoved($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // An ask's first tool call carries the instructions where the system prompt doesn't. Tool calls
  // that go by with no estimate get a reminder, attached to the third one's result for the model
  // alone, and again every eighth after while it lets them pass; a tag or a new step starts the
  // count again.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || 'deny' in result && result.deny !== undefined) return result
    if ((await read($, progress)).phase !== 'working') return result
    if (waits(e)) waiting = true
    // A call that moves the list starts or ends a step: it is neither work on the one in progress
    // nor a lapse of it.
    if (LIST_TOOLS.has(e.tool)) return result
    calls += 1
    // The finished work's calls fill the step (the ask) as it goes, under any estimate the model gives.
    const h = await learned($)
    const hasList = statuses.length > 0
    const fill = inferred(calls, hasList ? h.steps : h.asks)
    if (fill !== null) {
      heard(fill)
    }
    // And a little more, for the call done, however little anything has said.
    creep = crept(creep, real)
    estimate = settle(estimate, creep)
    await redraw($, false)
    if (!composed && !instructed && real === null) {
      instructed = true
      return { ...result, context: [...(result.context ?? []), INSTRUCTIONS] }
    }
    untagged += 1
    // Once the history fills the bar, a lapse the model lets pass isn't said again.
    if (untagged < (reminded ? (fill !== null ? Infinity : REMIND_AGAIN) : REMIND_AFTER)) return result
    untagged = 0
    reminded = true
    return { ...result, context: [...(result.context ?? []), reminder(statuses.includes('in_progress'))] }
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

// What the bar showed when the person last added to the ask, until the model's next tag.
let rescoping: number | null = null

// Whether the person has just come back to the session, until the band is next drawn.
let returning = false

// Whether the submission the next turn starts from was a background task's notification.
let woken = false

// A command's count never fills its step or the ask: only a check-off or the model's [D100%] does.
const COUNT_CAP = 99

/** A command's count moves the step in progress (the whole ask, with no list) forward, never back. */
async function counted($: EngineInterface, percent: number | null) {
  if (percent === null) return
  heard(Math.min(percent, COUNT_CAP))
  await redraw($, true)
}

// The workers the step in progress sent out, by agent id: true once each has reported back.
const workers = new Map<string, boolean>()

/** How far the step's workers put it: the share of them back, or null with none sent out. */
export function workersBack(sent: ReadonlyMap<string, boolean>): number | null {
  if (sent.size < 1) return null
  return ([...sent.values()].filter(Boolean).length / sent.size) * 100
}

/** A worker's coming or going moves the step in progress forward by its share, never back. */
async function workersMoved($: EngineInterface) {
  const share = workersBack(workers)
  if (share === null) return
  heard(share)
  await redraw($, false)
}

/**
 * The task list cuts the bar into sections and fills a finished step's, as it is checked off; the
 * step in progress is the model's estimate's to fill. A step that starts begins empty, unless the
 * response that started it tagged it.
 */
async function listed($: EngineInterface, next: string[]) {
  const before = tally(statuses)
  const after = tally(next)
  if (next.indexOf('in_progress') !== statuses.indexOf('in_progress') || after.done !== before.done || after.total !== before.total) {
    // The response's own tags are for the step it starts, made at its first call.
    const carried = tags.slice(tags.length - responseTags).map(([s]): [number, number] => [s, 0])
    tags = tags.slice(0, tags.length - responseTags)
    if (before.total > 0 && after.done > before.done) await learn($, 'steps')
    calls = 0
    tags = carried
    estimate = fresh !== null && fresh < 100 ? fresh : null
    real = estimate
    creep = null
    workers.clear()
    // A step that starts untagged gets its own reminders, at the first lapse's pace.
    if (estimate === null) {
      untagged = 0
      reminded = false
    }
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
async function redraw($: EngineInterface, tagged: boolean, rewind = false) {
  const list = tally(statuses)
  await update($, steps, (): Steps => ({ ...list, workers: workers.size }))
  await update($, progress, (p): Progress => {
    if (!tagged && p.phase !== 'working') return p
    if (p.percent === null && estimate === null && list.total < 1) return p
    const at = list.total > 0 ? place(estimate ?? 0, list) : rewind ? estimate ?? 0 : settle(p.phase === 'idle' ? null : p.percent, estimate ?? 0)
    return { percent: at, phase: at >= 100 ? 'done' : 'working' }
  })
  await seen($)
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
  const list = await read($, steps)
  const n = Math.max(1, list.total)
  const of = list.workers ?? 0
  // Back in the session, the app draws the band afresh: the drawings it had are drawn finished, as
  // they would stand by now, and a new one is made still. Otherwise a drawing is never changed once
  // made: a changed source is a new frame to the app, which blanks the band while it loads.
  if (returning) for (const l of [top, below]) if (l !== null) l.settled = true
  const fresh = top === null
  const drawn = draw(bar.percent, bar.isDone, n, { at: list.done, of }, returning)
  returning = false
  const source = bar.isOver ? fadingOut(drawn) : drawn
  layer(source, last!, of)
  // A fading drawing fades alone: the one beneath it, kept while it loads, would stay on show once
  // it had gone. The next time the band is drawn, by when the fading one is up and covers it, the
  // one beneath is drawn as the fading one ends, so nothing is left. It stays mounted, as taking it
  // out would move the one on top into its place and load it again, which blanks the band.
  if (bar.isOver && below !== null && !below.over) {
    if (top!.drawn === true) {
      below.source = played(top!.source, Infinity)
      below.over = true
    } else top!.drawn = true
  }
  // The drawing on top says what the bar shows now; the one beneath keeps what it last said.
  top!.alt = `Progress on the current request: ${bar.label}`
  // The module started afresh on a state the person had already seen: draw it as it stands.
  if (fresh && (await read($, shownState)) === stateKey(await read($, progress), list)) top!.settled = true
  const svg = (drawing: Layer) => (
    <ui.Svg
      source={drawing.settled ? played(drawing.source, Infinity) : drawing.source}
      alt={drawing.alt}
      // With no width of its own the drawing is the browser's default 300px; one wider than any
      // band is held to the band's width, and the drawing lays out inside it at 100%.
      width={4000}
      height={H + 2 * PAD}
      // A frame, not an image: the app re-decodes an image whenever it redraws the band, which
      // replays any animation in it from the start, where a frame plays once from when it's
      // mounted and is only mounted again on a new source (which blanks it for a moment).
      isInteractive
    />
  )
  // The new drawing's frame is blank while it loads, so the last one stays mounted beneath it and
  // shows through until it has. Each is keyed by its drawing, so the one beneath is never mounted
  // again: it was on top a moment ago, and only its place in the band changes.
  return (
    <Box flexGrow={1}>
      {below !== null && <Box key={`d${below.key}`} flexGrow={1}>{svg(below)}</Box>}
      <Box key={`d${top!.key}`} flexGrow={1} {...(below !== null ? { position: 'absolute' as const, top: 0, left: 0, right: 0 } : {})}>
        {svg(top!)}
      </Box>
    </Box>
  )

}


// The band's drawings: the one on top, and the last one, kept beneath it while it loads.
type Layer = { key: number; source: string; alt: string; drawn?: boolean; over?: boolean; to: number; n: number; at: number; of: number; settled?: boolean }
let top: Layer | null = null
let below: Layer | null = null
let layers = 0

/**
 * Puts a new drawing on top. The one it replaces stays beneath it only when the new one carries on
 * from it (the same sections and slices, its fill easing on from where that one's ended), so all
 * of it is covered once the new one shows; a bar that moves back or is cut afresh has nothing
 * beneath it, which no old fill could show through.
 */
function layer(source: string, state: State, of: number) {
  if (top !== null && top.source === source) return
  const carriesOn = top !== null && state.n === top.n && state.at === top.at && state.was === state.at && of === top.of
    && state.from === top.to && state.to >= top.to
  below = carriesOn ? top : null
  top = { key: ++layers, source, alt: '', to: state.to, n: state.n, at: state.at, of }
}

/** What the bar shows now, or null while there's no estimate to show. */
async function shown($: EngineInterface) {
  const { percent, phase, quiet } = await read($, progress)
  if (phase === 'idle' || percent === null) {
    return null
  }
  return {
    percent,
    isDone: phase === 'done' && percent >= 100 && !quiet,
    // The ask is over and its bar full, finale or none: the bar fades out after it.
    isOver: phase === 'done' && percent >= 100,
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
