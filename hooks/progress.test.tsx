import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyPlan, crept, rescope, ROLLBACK_MIN, endOf, fadingOut, hoist, MIN_BEGIN_S, played, calibrated, inferred, learnedFrom, readHistory, reminder, battery, blinkTimes, fillSeconds, LEAD_S, lastPercent, layout, onBar, place, progressIn, REFLOW_S, settle, stripTags, tally, ZOOM } from './register'

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } } as const
const BAND_PROPS = {
  hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {},
}
const BAND = { component: 'AbovePrompt', props: BAND_PROPS } as const
const SURVEY = { component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } } as const
const SURFACES = ['terminal', 'desktop'] as const
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }
/** A drawing without the working fill's flowing light and bubbles, the animations meant to loop. */
const still = (svg: string) => svg
  .replace(/<linearGradient id="flow"[\s\S]*?<\/linearGradient>/, '').replace(/<pattern id="bubbles"[\s\S]*?<\/pattern>/, '')
  .replace(/<animateTransform[^>]*href="#(flow|bubbles)"[^>]*\/>/g, '')

/** Stands in for the engine beneath the plugin: its turns, the hint line under the prompt and the band above it. */
function engine(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint + (e.props.tail ?? '')}</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hasSurvey ? 'survey' : 'empty band'}</Text>
  })
}

function say($: Engine, text: string, uuid: string) {
  return $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid,
  })
}

/** The model starts a new response, with no tag of its own yet. */
async function respond($: Engine, index: number) {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 0 }));
}

/** The bar's label as drawn (the terminal's hint line, the desktop's band), or undefined when the engine's own shows alone. */
async function label($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface, ...(surface === 'terminal' ? HINT : BAND) })
  // The terminal adds the label to its hint line; the desktop draws it in the bar and says it in the alt.
  const text =
    surface === 'terminal'
      ? (await ui.find({ type: 'Text', text: /%/ }))?.text
      : ((await ui.findAll({ type: 'Svg' })).at(-1)?.props.alt as string | undefined)
  await ui.unmount()
  return text?.match(/\d+(?:\.\d+)?%(?: · stopped)?$/)?.[0]
}

test('reads the last tag, with or without the D, clamped', () => {
  expect(lastPercent(['Starting [D5%]', 'more [D20.9%] then'])).toBe(20.9)
  expect(lastPercent(['went back [ 12.5 %]'])).toBe(12.5)
  expect(lastPercent(['overshoot [D140%]'])).toBe(100)
  expect(lastPercent(['no tag here', '[x%]'])).toBe(null)
})

test('strips tags and the space before them', () => {
  expect(stripTags('Mapped the code. [D42.5%]')).toBe('Mapped the code.')
  expect(stripTags('Halfway [D50%] and going.')).toBe('Halfway and going.')
  expect(stripTags('[D100%]')).toBe('')
})

test('follows the estimate forward, holds on a lower one, and holds when the turn ends', async ($, on) => {
  engine(on)
  expect(await label($, 'terminal')).toBeUndefined()
  for (const surface of SURFACES) {
    // A new ask clears the last one's bar to empty, and keeps it on screen before its first estimate.
    await $.turn.start({ text: 'refactor everything', turnId: `t-${surface}` })
    expect(await label($, surface)).toBe('0%')

    await say($, 'Mapped the code. [D42.5%]', `a-${surface}`)
    expect(await label($, surface)).toBe('42.5%')

    // The bar only moves forward: a lower estimate leaves it where it is.
    await say($, 'Found more callers than expected. [D30%]', `b-${surface}`)
    expect(await label($, surface)).toBe('42.5%')

    // The answer ends the ask, whatever the last estimate said: the bar fills.
    await $.turn.complete({
      reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: `t-${surface}`,
    })
    expect(await label($, surface)).toBe('100%')
  }
})

test('the terminal keeps its own hint line with the bar at the end', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D50%]', 'a1')
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...HINT })
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe('esc to interrupt  ████████░░░░░░░░ 50%')
  await ui.unmount()
})

test('the desktop draws the battery in the band, leaving the hint line and the terminal band alone', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D50%]', 'a1')

  const band = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Svg' })).toBeDefined()
  await band.unmount()

  const hint = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...HINT })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('esc to interrupt')
  await hint.unmount()

  const terminalBand = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect((await terminalBand.find({ type: 'Text' }))?.text).toBe('empty band')
  await terminalBand.unmount()
})

test('a survey has the desktop band to itself', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D50%]', 'a1')
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...SURVEY })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('survey')
  await ui.unmount()
})

test('the stored message carries no tag, unless it was nothing but one', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  const stored = await say($, 'Mapped the code. [D42.5%]', 'a1')
  expect(stored.message?.content).toMatchObject([{ type: 'text', text: 'Mapped the code.' }])
  const bare = await say($, '[D60%]', 'a2')
  expect(bare.message?.content).toMatchObject([{ type: 'text', text: '[D60%]' }])
  expect(await label($, 'desktop')).toBe('60%')
})

test('a reply is drawn without its tags', async ($, on) => {
  engine(on)
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'progress-bar', surface, component: 'AssistantMessage', props: { text: 'Mapped the code. [D42.5%] Next, the tests.', isFirstOfReply: true } })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Mapped the code. Next, the tests.')
    await ui.unmount()
  }
})

test('an interrupted ask keeps its last estimate, marked stopped', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'long job', turnId: 't1' })
  await say($, 'Halfway. [D50%]', 'a1')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(await label($, 'terminal')).toBe('50% · stopped')
})


/**
 * A drawing with each hoisted animation put back inside the element it drives, so a test reads an
 * element's motion where it reads the element.
 */
function nested(svg: string): string {
  let out = svg
  for (const m of svg.matchAll(/<(animate|animateTransform|animateMotion|set) href="#([^"]+)"([^>]*?)\/>\n?/g)) {
    out = out.replace(m[0], '')
    const at = out.indexOf(` id="${m[2]}"`)
    const end = out.indexOf('>', at)
    const self = out[end - 1] === '/'
    const name = out.slice(out.lastIndexOf('<', at) + 1).match(/^[\w:-]+/)![0]
    const child = `<${m[1]}${m[3]}/>`
    out = self ? `${out.slice(0, end - 1)}>${child}</${name}>${out.slice(end + 1)}` : `${out.slice(0, end + 1)}${child}${out.slice(end + 1)}`
  }
  return out.replace(/ id="m\d+"/g, '')
}

/** The bar's label as a number, for a check that allows the creep's few points over the real word. */
async function near($: Engine, real: number) {
  const shown = Number((await label($, 'desktop'))!.replace('%', ''))
  expect(shown >= real && shown <= real + 5).toBe(true)
}

async function source($: Engine) {
  const band = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
  // the drawing on top is the last; one below it is the last drawing, kept while the new one loads
  const svg = (await band.findAll({ type: 'Svg' })).at(-1)?.props
  await band.unmount()
  expect(svg === undefined || svg.isInteractive === true).toBe(true)
  return svg === undefined ? undefined : nested(svg.source as string)
}

test('an estimate moves the bar forward or not at all', () => {
  expect(settle(null, 30)).toBe(30)
  expect(settle(40, 30)).toBe(40)
  expect(settle(40, 55)).toBe(55)
})

test('a task list shows the bar empty before any estimate, each tool call creeps it a little, and the wrap-up checks it all off', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  // A call done with nothing said: a fifth of the way to a quarter of the way to 90%.
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBe('4.5%')
  // A plan is up: the bar is cut into its sections, the step empty before anything is said of it.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }] })
  expect(await label($, 'desktop')).toBe('0%')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBe('4.5%')
  // A tag is the real word; the next call creeps on from it, a fifth of the way to 37.5%.
  await say($, 'Started. [D20%]', 'a1')
  expect(await label($, 'desktop')).toBe('20%')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBe('23.5%')
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' })
  expect(await label($, 'desktop')).toBe('100%')
})

test('with a task list the tag is the step in progress, and a finished step fills its section', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  // Five steps, the second in progress: [D75%] is three quarters of the second section.
  expect(place(75, { total: 5, done: 1 })).toBe(35)
  expect(place(75, { total: 0, done: 0 })).toBe(75)
  // An unchecked step never fills its section; a checked-off list fills the bar.
  expect(place(100, { total: 4, done: 1 })).toBe(47.5)
  expect(place(0, { total: 4, done: 4 })).toBe(100)
  expect(tally(['completed', 'in_progress', 'pending'])).toEqual({ total: 3, done: 1 })
  expect(applyPlan(['completed', 'in_progress', 'pending'], { advance: true })).toEqual(['completed', 'completed', 'in_progress'])
  expect(applyPlan(['in_progress', 'pending', 'pending', 'pending'], { done: [2], start: 4 })).toEqual(['in_progress', 'completed', 'pending', 'in_progress'])

  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  await respond($, 1)
  await say($, 'Halfway through the first step. [D50%]', 'a1')
  expect(await label($, 'desktop')).toBe('12.5%')
  // Checking off the step fills its section, and the second starts empty.
  await respond($, 2)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await label($, 'desktop')).toBe('25%')
  await say($, 'Second step, nearly. [D80%]', 'a2')
  expect(await label($, 'desktop')).toBe('45%')
  // A lower estimate for the step holds.
  await say($, 'Hmm. [D20%]', 'a3')
  expect(await label($, 'desktop')).toBe('45%')
  // [D100%] with steps unchecked stops short of the step's end, and fills the bar once the turn answers.
  await respond($, 3)
  await say($, 'Done. [D100%]', 'a4')
  expect(await label($, 'desktop')).toBe('47.5%')
  await $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await label($, 'desktop')).toBe('100%')
})

test('a tag in the response that checks off a step is for the step it starts', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await respond($, 0)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  await say($, 'First step, most of the way. [D80%]', 'a1')
  expect(await label($, 'desktop')).toBe('20%')
  // One response: the text comes before its check-off, and its 30% goes to the second step.
  await respond($, 1)
  await say($, 'First step done; into the second. [D30%]', 'a2')
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await label($, 'desktop')).toBe('32.5%')
  // A check-off in a response with no tag starts its step empty.
  await respond($, 2)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await label($, 'desktop')).toBe('50%')
  // A new plan puts the bar back in line with it, even behind where it was.
  await respond($, 3)
  const replanned = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((content, i) => ({ content, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: replanned })
  expect(await label($, 'desktop')).toBe('25%')
})

test('a message sent mid-ask keeps the bar where it was', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D30%]', 'a1')
  await $.turn.start({ text: 'also this', turnId: 't2' })
  expect(await label($, 'desktop')).toBe('30%')
})

// Where on the bar a drawing's fill starts and ends, 0 to 1 (the same place when it's drawn still).
function moveOf(svg: string): [number, number] {
  const W = 994
  const at = (x: string) => Math.round((Number(x) / W) * 10000) / 10000
  const fill = svg.match(/<rect data-fill=""[^>]*width="([\d.]+)"[^>]*>(.*?)<\/rect>/)!
  const values = fill[2]!.match(/values="([\d.;]+)"/)?.[1]?.split(';')
  if (values) return [at(values[0]!), at(values[values.length - 1]!)]
  const to = fill[2]!.match(/to="([\d.]+)"/)?.[1]
  return [at(fill[1]!), at(to ?? fill[1]!)]
}

test('the fill eases from the last estimate to the new one, and the finale plays once, frozen at its end', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D20%]', 'a1')
  let svg = (await source($))!
  expect(moveOf(svg)).toEqual([0, 0.2])
  expect(svg).toMatch(/keySplines="0.4 0 0.2 1(;0.4 0 0.2 1)*"/)
  expect(svg).toContain('fill="freeze"')
  // Nothing has changed: the band is handed the same drawing, so it keeps the one it has.
  expect(await source($)).toBe(svg)
  await say($, 'More. [D60%]', 'a2')
  svg = (await source($))!
  expect(moveOf(svg)).toEqual([0.2, 0.6])
  expect(svg).not.toContain('href="#star"')

  // The model's [D100%] eases the fill home, then the finale plays once and leaves the glow.
  await say($, 'Done. [D100%]', 'a3')
  svg = (await source($))!
  expect(moveOf(svg)).toEqual([0.6, 1])
  expect(svg).toContain('href="#star"')
  expect(svg).toContain('values="0;1;0;1;0;1;0.45"')
  expect(svg).toContain('to="#d9a521"')
  expect(svg).not.toContain('begin="-')
  expect(await source($)).toBe(svg)
})

test('the drawing holds no <style> element, which the band refuses', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Done. [D100%]', 'a1')
  expect(await source($)).not.toContain('<style')
})

test('the task list cuts the bar into sections, which only the model fills, each blinking as it is filled', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D10%]', 'a1')
  expect((await source($))!).not.toContain('id="sec"')
  // A four-step list with the first step in progress: four sections, and the 10% is the first step's.
  const items = ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  let svg = (await source($))!
  expect(svg.match(/<clipPath id="sec">(.*?)<\/clipPath>/)![1].match(/<rect /g)!.length).toBe(4)
  // The first step, in progress, is zoomed: its 10% is a tenth of its wide section.
  expect(moveOf(svg)).toEqual([0.065, 0.065])
  expect(still(svg)).not.toContain('<animate')
  expect(await label($, 'desktop')).toBe('2.5%')
  // Finishing the first step, then an estimate for the second: the fill crosses the first
  // section's end, and that section blinks, once, as it passes.
  await respond($, 1)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await say($, 'Into step two. [D60%]', 'a2')
  svg = (await source($))!
  const blinks = [...svg.matchAll(/values="0;1;0;1;0" dur="0.6s" begin="([\d.-]+)s"/g)].map(m => Number(m[1]))
  expect(blinks.length).toBe(1)
  // The first step fills and blinks while it is still wide; only then do the sections slide (the
  // first narrows, the second widens) and the fill eases on.
  const reached = fillSeconds(onBar(0.025, layout(4, 0)), onBar(0.25, layout(4, 0)))
  expect(blinks[0]! > LEAD_S && blinks[0]! <= LEAD_S + reached + 0.001).toBe(true)
  const slide = Number(svg.match(new RegExp(`dur="${REFLOW_S}s" begin="([\\d.]+)s"`))![1])
  close(slide, blinks[0]! + 0.6, 3)
  expect(moveOf(svg)).toEqual([0.065, Math.round(onBar(0.4, layout(4, 1)) * 10000) / 10000])
  // A new ask starts with one section again.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.start({ text: 'next', turnId: 't2' })
  await say($, 'Go. [D5%]', 'b1')
  expect((await source($))!).not.toContain('id="sec"')
})

test('sections finished in one step blink one after another', () => {
  // From 35% to 80% of four sections: the second and third finish, the third waits for the second.
  const [second, third] = blinkTimes(0.35, 0.8, 4, false)
  expect(second!.i).toBe(1)
  expect(third!.i).toBe(2)
  expect(third!.at - second!.at >= 0.6 - 0.001).toBe(true)
  // Alone, a section blinks as the fill passes its end, partway through the ease.
  const [only] = blinkTimes(0, 0.5, 4, false)
  expect(only!.i).toBe(0)
  expect(only!.at > 0.2 && only!.at < fillSeconds(0, 0.5) / 2).toBe(true)
  // A finished ask leaves the last section to the finale.
  expect(blinkTimes(0, 1, 4, true).map(b => b.i)).toEqual([0, 1, 2])
})

test('three tool calls in a row with no estimate get one reminder, and a tag starts the count again', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.prompt.compose(COMPOSE)
  const call = async () => ((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D10%]', 'a1')
  expect(await call()).toEqual([])
  expect(await call()).toEqual([])
  const third = await call()
  expect(third.length).toBe(1)
  expect(third[0]).toContain('[D40%]')
  // Not on every call: the fourth says nothing.
  expect(await call()).toEqual([])
  // A tag starts the count again.
  await say($, 'More. [D30%]', 'a2')
  expect(await call()).toEqual([])
  expect(await call()).toEqual([])
  expect((await call()).length).toBe(1)
  // Not between asks.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  for (let i = 0; i < 4; i++) expect(await call()).toEqual([])
})

test('with a Remote Control client attached, the bar is pinned as the status line too', async ($, on) => {
  engine(on)
  let surfaces: ('desktop' | 'mobile')[] = ['desktop']
  const status: (string | undefined)[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D50%]', 'a1')
  expect(status.at(-1)).toBeUndefined()

  surfaces = ['desktop', 'mobile']
  await say($, 'Further. [D75%]', 'a2')
  expect(status.at(-1)).toBe('████████████░░░░ 75%')

  surfaces = ['desktop']
  await say($, 'Nearly. [D90%]', 'a3')
  expect(status.at(-1)).toBeUndefined()
})

test('a step that sends out workers fills a slice as each reports back', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  let spawned = 0
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: (e as { resume?: { agentId: string } }).resume?.agentId ?? `w${++spawned}` }))
  const ended = (agentId: string) =>
    $.turn.complete({ reason: 'answer', answer: 'report', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId })

  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b'].map((content, i) => ({ content, status: i === 0 ? 'completed' : 'in_progress' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  expect(await label($, 'desktop')).toBe('50%')
  // Four workers out on the second step: each one back is a quarter of it, short of the step's end.
  for (let i = 0; i < 4; i++) await $.agent.spawn({ prompt: `batch ${i}` })
  expect(await label($, 'desktop')).toBe('50%')
  await ended('w1')
  expect(await label($, 'desktop')).toBe('62.5%')
  await ended('w2')
  expect(await label($, 'desktop')).toBe('75%')
  // A worker woken again is out again, but the bar never moves back.
  await $.agent.spawn({ prompt: 'one more thing', resume: { agentId: 'w1' } } as never)
  expect(await label($, 'desktop')).toBe('75%')
  // A worker's own sub-worker is its business, not a slice of the step.
  await $.agent.spawn({ prompt: 'helper', parentAgentId: 'w3' } as never)
  await ended('w3')
  await ended('w4')
  expect(await label($, 'desktop')).toBe('87.5%')
  await ended('w1')
  expect(await label($, 'desktop')).toBe('95%')
})

test('the step in progress is cut faintly into a slice per worker', () => {
  const ticks = (svg: string) => svg.split('data-tick').length - 1
  expect(ticks(battery(0, 0.5, false, 2, { at: 1, of: 4 }))).toBe(3)
  expect(ticks(battery(0, 0.5, false, 2, { at: 1, of: 1 }))).toBe(0)
  expect(ticks(battery(0, 0.5, false, 2))).toBe(0)
})

test('a quick answer with no estimate fills its bar without the finale', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'what time is it?', turnId: 't1' })
  expect(await label($, 'desktop')).toBe('0%')
  await $.turn.complete({ reason: 'answer', answer: 'Noon.', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await label($, 'desktop')).toBe('100%')
  expect(await source($)).not.toContain('href="#star"')
})

test('an estimate too small to see keeps the drawing the band has, so it does not blink', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D40%]', 'a1')
  const svg = (await source($))!
  await say($, 'A little more. [D41%]', 'a2')
  expect(await source($)).toBe(svg)
  expect(await label($, 'desktop')).toBe('41%')
  // Small moves add up: once the fill has gone far enough to see, it eases on from where it was drawn.
  await say($, 'More. [D44%]', 'a3')
  expect(moveOf((await source($))!)).toEqual([0.4, 0.44])
})

test('reads a PROGRESS marker or a line that starts with N of M, the last one in the text', () => {
  expect(progressIn('build\nPROGRESS 3/4\n')).toBe(75)
  expect(progressIn('  12 of 78 batch: batch 3 on a frame\n  39 of 78 batch: batch 9\n')).toBe(50)
  expect(progressIn('<event>  39 of 78 batch: ok</event>')).toBe(50)
  expect(progressIn('PROGRESS 40%')).toBe(40)
  // prose that happens to say "of" mid-line, a count with no total, and a count past its total are not progress
  expect(progressIn('read 3 of 10 files')).toBeNull()
  expect(progressIn('  0 of ? step: packing')).toBeNull()
  expect(progressIn('  9 of 4 batch')).toBeNull()
  expect(progressIn('PROGRESS 0/0')).toBeNull()
})

function bashResult($: Engine, text: string, uuid: string, tool = 'Bash') {
  return $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-' + uuid, content: text }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid,
  })
}

test('a command\'s output moves the step in progress, forward only, and never fills it', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'gate it', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'completed' }, { content: 'gate', status: 'in_progress' }] })
  await bashResult($, '  39 of 78 batch: batch 9 on a frame\n', 'r1')
  expect(await label($, 'desktop')).toBe('75%')
  await bashResult($, 'PROGRESS 1/4', 'r2')
  expect(await label($, 'desktop')).toBe('75%')
  await bashResult($, 'PROGRESS 78/78', 'r3')
  expect(await label($, 'desktop')).toBe('95%')
})

test('with no list a command\'s output moves the whole bar, short of done', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'gate it', turnId: 't1' })
  await bashResult($, 'PROGRESS 1/2', 'r1')
  expect(await label($, 'desktop')).toBe('50%')
  await bashResult($, 'PROGRESS 2/2', 'r2')
  expect(await label($, 'desktop')).toBe('99%')
  await bashResult($, 'PROGRESS 2/2 quoted', 'r3', 'Read')
  expect(await label($, 'desktop')).toBe('99%')
})

test('a background task\'s notification moves the bar and does not start a new ask', async ($, on) => {
  engine(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'gate it', turnId: 't1' })
  await say($, 'Gate started. [D10%]', 'a1')
  // A turn that ends waiting on work it left running holds its bar, rather than finishing it.
  await $.tool.call({ tool: 'Monitor', command: 'gate' })
  await $.turn.complete({ reason: 'answer', answer: 'waiting', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await label($, 'desktop')).not.toBe('100%')
  const text = '<task-notification><event>  39 of 78 batch: batch 9</event></task-notification>'
  await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text, turnId: 't2' })
  expect(await label($, 'desktop')).toBe('50%')
  // the person's own next ask still starts afresh
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2' })
  await $.prompt.submit({ text: 'new thing', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'new thing', turnId: 't3' })
  expect(await label($, 'desktop')).toBe('0%')
})

async function layers($: Engine) {
  const band = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
  const found = (await band.findAll({ type: 'Svg' })).filter(svg => svg.props.alt !== '').map(svg => svg.props.source as string)
  await band.unmount()
  return found
}

test('a new drawing goes on top of the last one, which stays mounted beneath it while it loads', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  const empty = await layers($)
  expect(empty).toHaveLength(1)
  await say($, 'Started. [D30%]', 'a1')
  const first = await layers($)
  expect(first).toEqual([empty[0], first[1]])
  await say($, 'More. [D60%]', 'a2')
  const second = await layers($)
  // the drawing that was on top is now beneath, unchanged, so its frame is never mounted again
  expect(second[0]).toBe(first[1])
  expect(second).toHaveLength(2)
  // nothing changed: the same two
  expect(await layers($)).toEqual(second)
})

test('a drawing that moves the bar back has nothing beneath it, so no old fill shows through', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Far. [D80%]', 'a1')
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.start({ text: 'new job', turnId: 't2' })
  expect(await layers($)).toHaveLength(1)
})

const close = (a: number, b: number, digits = 6) => expect(Math.abs(a - b) < 10 ** -digits).toBe(true)

test('the step in progress takes most of the bar, the others sharing the rest', () => {
  const edges = layout(5, 1)
  close(edges[2]! - edges[1]!, ZOOM)
  close(edges[1]! - edges[0]!, (1 - ZOOM) / 4)
  expect(edges[5]).toBe(1)
  // no step in progress, or too few steps to give it more than its share: equal
  expect(layout(5, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  expect(layout(1, 0)).toEqual([0, 1])
  // half of the step in progress is half of its wide section
  close(onBar(0.3, edges), edges[1]! + 0.5 * ZOOM)
})

test('a check-off fills and blinks the step while it is wide, then slides the sections, then fills on', () => {
  const svg = nested(battery(0.2, 0.375, false, 4, { at: 1, of: 0 }, 0))
  const before = layout(4, 0)
  const after = layout(4, 1)
  // the finished step blinks where it stood, wide
  const blink = svg.match(/<rect x="(-?[\d.]+)" width="([\d.]+)" y="-1.5"[^>]*><animate attributeName="opacity" values="0;1;0;1;0" dur="0.6s" begin="([\d.]+)s"/)!
  expect(Number(blink[2]) > 0.6 * 1000).toBe(true)
  const blinkAt = Number(blink[3])
  // the two sections that change (the finished one narrowing, the next widening) ease their
  // width once the blink is over, outline and fill cut alike; the others keep theirs
  const slides = [...svg.matchAll(new RegExp(`attributeName="width" from="[\\d.]+" to="[\\d.]+" dur="${REFLOW_S}s" begin="([\\d.]+)s"`, 'g'))]
  expect(slides.length).toBe(4)
  for (const m of slides) close(Number(m[1]), blinkAt + 0.6, 3)
  // the fill reaches the end of the step in the wide layout, holds through the blink, keeps to that
  // end as the sections slide, then eases into the next step
  // (the opening hold is the animation's begin, not one of its values)
  const values = svg.match(/<rect data-fill=""[^>]*>.*?values="([\d.;]+)"/)![1]!.split(';').map(v => Number(v) / 994)
  expect(values.length).toBe(5)
  close(values[0]!, onBar(0.2, before), 3)
  close(values[1]!, onBar(0.25, before), 3)
  close(values[2]!, onBar(0.25, before), 3)
  close(values[3]!, onBar(0.25, after), 3)
  close(values[4]!, onBar(0.375, after), 3)
  // a drawing with no check-off doesn't slide
  expect(battery(0.3, 0.35, false, 4, { at: 1, of: 0 }, 1)).not.toContain(`dur="${REFLOW_S}s"`)
})

test('a bar cut into a new plan fills in from empty, never jumping to its first estimate', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  // the first estimate and the plan arrive in one response: the text, then the call
  await say($, 'Starting. [D20%]', 'a1')
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] })
  const [from, to] = moveOf((await source($))!)
  expect(from).toBe(0)
  expect(to > 0).toBe(true)
})

test('every move waits a moment before it starts, so it plays once the frame is on screen', () => {
  const svg = nested(battery(0, 0.3, false))
  // the moment is the animation's begin; the fill is drawn empty until then
  const begin = svg.match(/<rect data-fill=""[^>]*>.*?begin="([\d.]+)s"/)!
  close(Number(begin[1]), LEAD_S, 3)
  const values = svg.match(/<rect data-fill=""[^>]*>.*?values="([\d.;]+)"/)![1]!.split(';').map(Number)
  expect(values[0]).toBe(0)
  expect(values[1]).toBeGreaterThan(0)
  expect(svg).toMatch(/<rect data-fill=""[^>]*width="0.00"/)
  // a drawing where nothing moves has no animation at all
  expect(battery(0.3, 0.3, false)).not.toContain('attributeName="width"')
})

test('the drawing sizes itself without calc(), and the finale shine sweeps in plain numbers', () => {
  const svg = nested(battery(0.6, 1, true, 3, { at: 3, of: 0 }, 2))
  // a nested drawing doesn't take a calc() width, so it would overflow the band
  expect(svg).not.toContain('calc(')
  // a percentage x doesn't animate, so the shine sweeps from a number to a number
  expect(svg).toMatch(/attributeName="x" from="-?\d+" to="\d+"/)
  expect(svg).not.toMatch(/attributeName="x" from="-?[\d.]+%"/)
})

test('with no system prompt section, an ask\'s first tool call carries the instructions, so a bar with no list still moves', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  const call = async () => ((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []
  await $.turn.start({ text: 'job', turnId: 't1' })
  // The bar is on screen from the ask's start, with no list and no estimate yet.
  for (const surface of SURFACES) expect(await label($, surface)).toBe('0%')
  const first = await call()
  expect(first.length).toBe(1)
  expect(first[0]).toContain('# Progress estimate')
  // Once per ask.
  expect(await call()).toEqual([])
  await say($, 'Halfway. [D50%]', 'a1')
  for (const surface of SURFACES) expect(await label($, surface)).toBe('50%')
  // Not once the ask has an estimate: the next ask's first call carries them again.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect((await call())[0]).toContain('# Progress estimate')
})

test('where the system prompt carries the instructions, the first tool call carries nothing', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.some(s => s.id === 'progress-bar:instructions')).toBe(true)
  await $.turn.start({ text: 'job', turnId: 't1' })
  expect(((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []).toEqual([])
})

test('a step left untagged is reminded again, each new step starts the count afresh, and the reminder names the step', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.prompt.compose(COMPOSE)
  const call = async () => ((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []
  const reminders = async (n: number) => {
    const said: number[] = []
    for (let i = 1; i <= n; i++) if ((await call()).length > 0) said.push(i)
    return said
  }
  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b', 'c'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  // The first lapse at the third call, then again every eighth while the model lets them pass.
  expect(await reminders(19)).toEqual([3, 11, 19])
  // A new step starts the count afresh, at the first lapse's pace.
  await respond($, 1)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  const third = await reminders(3)
  expect(third).toEqual([3])
  expect(reminder(true)).toContain('step you have in progress')
  expect(reminder(false)).toContain('whole request')
})

test('the finished work\'s calls say how far along a step is, short of done, once there is enough of it', () => {
  // Too little history: nothing inferred.
  expect(inferred(2, [4, 4])).toBe(null)
  expect(inferred(0, [4, 4, 4])).toBe(null)
  // Steps of 4 calls: two calls in is halfway.
  expect(inferred(2, [4, 4, 4])).toBe(50)
  // Past every step seen, it holds short of done.
  expect(inferred(9, [4, 4, 4])).toBe(85)
  // A step running long is taken for one of the longer ones.
  expect(inferred(5, [2, 4, 10, 10])).toBe(50)
})

test('an estimate is read as what such estimates have meant, the more of them the more so', () => {
  expect(calibrated(50, [])).toBe(50)
  expect(calibrated(100, [[95, 40]])).toBe(100)
  // Ten times "50%" came with a fifth of the calls made: "50%" now reads much nearer 20.
  const pairs = Array.from({ length: 10 }, (): [number, number] => [50, 20])
  const meant = calibrated(50, pairs)
  expect(meant).toBeGreaterThan(20)
  expect(meant).toBeLessThan(35)
  // Far-off estimates don't count.
  expect(calibrated(90, pairs)).toBe(90)
})

test('a finished step adds its calls and its estimates\' meanings, and a stored history is read defensively', () => {
  const h = learnedFrom(readHistory(undefined), 'steps', 4, [[50, 1], [100, 4]])
  expect(h).toEqual({ steps: [4], asks: [], said: [] })
  // Too short a step says nothing of what its estimates meant; a long enough one does.
  expect(learnedFrom(readHistory(undefined), 'steps', 8, [[50, 2], [100, 8]]).said).toEqual([[50, 25]])
  // A quick ask with no list is no guide to the long ones.
  expect(learnedFrom(readHistory(undefined), 'asks', 3, []).asks).toEqual([])
  expect(readHistory({ asks: [2, 3, 7] }).asks).toEqual([7])
  expect(readHistory({ steps: [3, 'x', 0, 5], said: [[1, 2], [3], 'y'] })).toEqual({ steps: [3, 5], asks: [], said: [[1, 2]] })
})

test('a step fills from the history as calls go by, is learned when checked off, and the history quiets the repeated reminder', async ($, on) => {
  engine(on)
  mock.store(on, { 'history.2': { steps: [4, 4, 4], asks: [], said: [] } })
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.prompt.compose(COMPOSE)
  const call = async () => ((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []
  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  expect(await label($, 'desktop')).toBe('0%')
  await call()
  await call()
  // Two calls into a step that takes four: half the first of two sections, and the creep's bit.
  await near($, 25)
  // The first lapse is still said; the history fills the bar after it, so it is not said again.
  const said: number[] = []
  for (let i = 3; i <= 20; i++) if ((await call()).length > 0) said.push(i)
  expect(said).toEqual([3])
  await respond($, 1)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await label($, 'desktop')).toBe('50%')
  // The 20-call step is learned: two calls into the next now read 40% of it, not half.
  await call()
  await call()
  await near($, 70)
})

test('with no list an ask fills from the asks before it, and an answered ask is learned', async ($, on) => {
  engine(on)
  mock.store(on, { 'history.2': { steps: [], asks: [10, 10, 10], said: [] } })
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
  await near($, 50)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  // Answered with no word from the model, the bar fills, whatever the history drew.
  expect(await label($, 'desktop')).toBe('100%')
  // The 5-call ask is learned: two calls into the next read a quarter, not a fifth.
  await $.turn.start({ text: 'again', turnId: 't2' })
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
  await near($, 25)
})

test('reads a test runner\'s percent at a line\'s end and a build\'s [n/m] at its start', () => {
  expect(progressIn('tests/a.py ....          [ 45%]\ntests/b.py ..   [ 60%]')).toBe(60)
  expect(progressIn('[12/40] Building CXX object foo.o')).toBe(30)
})

test('every animation runs on the outermost <svg>\'s clock: a nested <svg> holds none, each one points at its element', () => {
  for (const svg of [battery(0.2, 0.7, false), battery(0.6, 1, true, 3, { at: 3, of: 0 }, 2), battery(0.2, 0.375, false, 4, { at: 1, of: 2 }, 0)]) {
    const inner = svg.slice(svg.indexOf('<svg', 1), svg.indexOf('</svg>') + 6)
    expect(inner.length).toBeGreaterThan(0)
    expect(still(inner)).not.toMatch(/<(animate|animateTransform|animateMotion|set)\b/)
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))
    for (const m of svg.matchAll(/<animate\w* href="#([^"]+)"/g)) expect(ids.has(m[1])).toBe(true)
  }
  // The fill's own motion is among them.
  expect(battery(0.2, 0.7, false)).toMatch(/<rect id="(m\d+)" data-fill=""[\s\S]*<animate href="#\1" attributeName="width"/)
})

test('hoisting gives an animated element an id, keeps one it has, and leaves the rest as it was', () => {
  const { markup, animations } = hoist('<g><rect x="1"><animate attributeName="x" to="2"/></rect><rect id="k"><set attributeName="y" to="1"/></rect><use href="#s"/></g>')
  expect(markup).toBe('<g><rect id="m0" x="1"></rect><rect id="k"></rect><use href="#s"/></g>')
  expect(animations).toBe('<animate href="#m0" attributeName="x" to="2"/>\n<set href="#k" attributeName="y" to="1"/>')
})

test('no animation in a drawing begins at 0: each begins late enough to play in view', () => {
  const drawings = [
    battery(0, 0.2, false), battery(0.2, 0.7, false), battery(0.7, 1, true),
    battery(0.2, 0.375, false, 4, { at: 1, of: 2 }, 0), battery(0.6, 1, true, 3, { at: 3, of: 0 }, 2),
  ]
  for (const svg of drawings) {
    const animations = [...svg.matchAll(/<(animate|animateTransform|animateMotion|set)\b[^>]*>/g)].map(m => m[0])
    expect(animations.length).toBeGreaterThan(0)
    for (const a of animations) {
      const begin = a.match(/\bbegin="([\d.]+)s"/)
      expect(begin === null ? a : Number(begin[1]) >= MIN_BEGIN_S).toBe(true)
    }
  }
})

test('a drawing shown again later carries on from where it got to, and is still once it has played', () => {
  const svg = battery(0.2, 0.7, false)
  const end = endOf(svg)
  expect(end).toBeGreaterThan(0.5)
  const begins = (x: string) => [...x.matchAll(/\bbegin="(-?[\d.]+)s"/g)].map(m => Number(m[1]))
  // Shown again mid-move: the move's begin is already past, so it shows partway, not from its start.
  expect(Math.min(...begins(played(svg, 0.5)))).toBeLessThan(0)
  // Shown again after it has played: every animation is over, and later redraws are the same string.
  expect(endOf(played(svg, end + 5))).toBeLessThanOrEqual(0)
  expect(played(svg, end + 5)).toBe(played(svg, end + 50))
  // One that hasn't begun yet still begins late enough to play in view.
  const later = played(battery(0.6, 1, true), 0.2)
  expect(begins(later).filter(b => b > 0).every(b => b >= MIN_BEGIN_S)).toBe(true)
})

test('a finished ask\'s bar fades out after its finale, and a fresh ask brings it back', () => {
  const done = fadingOut(battery(0.7, 1, true))
  const fade = done.match(/<animate attributeName="opacity" from="1" to="0" begin="([\d.]+)s"/)!
  expect(Number(fade[1])).toBeGreaterThan(endOf(battery(0.7, 1, true)))
})

test('an ordinary redraw draws the very same drawing, and coming back draws it finished, still', async ($, on) => {
  engine(on)
  on('session.attach', () => ({ clientId: 'desktop' }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Going. [D60%]', 'a1')
  const first = (await source($))!
  expect(first).toContain('attributeName="width"')
  // Redrawn (a turn starting or stopping): the same string, so the app keeps its frame.
  expect(await source($)).toBe(first)
  // Back in the session: the same drawing, every animation over, and it stays so.
  await $.session.attach({ surface: 'desktop' } as never)
  const back = (await source($))!
  expect(endOf(back)).toBeLessThanOrEqual(0)
  expect(await source($)).toBe(back)
})

test('coming back to a session shows the bar where it stands, unanimated; only a finished ask\'s finale plays', async ($, on) => {
  engine(on)
  on('session.attach', () => ({ clientId: 'desktop' }))
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  const items = ['a', 'b', 'c'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  await source($)
  // Away mid-ask: a step checked off and another tagged, nothing drawn meanwhile.
  await respond($, 1)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await say($, 'Second step, halfway. [D50%]', 'a1')
  await $.session.attach({ surface: 'desktop' } as never)
  const midway = (await source($))!
  // On the step it's on, drawn still: no fill move, no section slide, no blink.
  expect(still(midway)).not.toMatch(/<(animate|animateTransform|set)\b/)
  // Away again: the ask finishes.
  await respond($, 2)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await respond($, 3)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up' })
  await say($, 'Done. [D100%]', 'a2')
  await $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.session.attach({ surface: 'desktop' } as never)
  const back = (await source($))!
  // Full and still, with the finale alone playing (and the fade after it).
  expect(back).not.toMatch(/attributeName="width"/)
  expect(back).not.toMatch(/values="0;1;0;1;0" dur="0.6s"/)
  expect(back).toContain('values="0;1;0;1;0;1;0.45"')
  // The same steps finished in view blink as they fill.
  expect(battery(0, 1, true, 3, { at: 3, of: 0 }, 0)).toMatch(/values="0;1;0;1;0" dur="0.6s"/)
})

test('the creep moves every call, less each time, never past its ceiling, and a real word above it takes over', () => {
  let c: number | null = null
  const seen: number[] = []
  for (let i = 0; i < 40; i++) seen.push(c = crept(c, 20))
  for (let i = 1; i < seen.length; i++) expect(seen[i]! > seen[i - 1]! && seen[i]! - seen[i - 1]! < seen[1]! - seen[0]! + 1e-9).toBe(true)
  expect(seen.at(-1)!).toBeLessThan(37.5)
  expect(seen[4]!).toBeGreaterThan(30)
  // A real word above the creep: it creeps on from there.
  expect(crept(30, 60)).toBeGreaterThan(60)
})

test('a message added mid-ask asks for a fresh estimate; one far below rolls the bar back, a small dip doesn\'t', async ($, on) => {
  engine(on)
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Most of it. [D70%]', 'a1')
  expect(await label($, 'desktop')).toBe('70%')
  // The person adds to it: the model is told what the bar shows and asked again.
  const sent = (await $.prompt.submit({ text: 'also do the other thing', wait: false, origin: { kind: 'composer' } })) as { context?: readonly string[] }
  expect(sent.context).toEqual([rescope(70, false)])
  expect(rescope(70, false)).toContain('70%')
  // A fresh estimate far below: the ask has grown, and the bar goes back.
  await respond($, 2)
  await say($, 'Bigger now. [D35%]', 'a2')
  expect(await label($, 'desktop')).toBe('35%')
  // Added to again, and a dip within ROLLBACK_MIN: the bar holds.
  await $.prompt.submit({ text: 'and a small tweak', wait: false, origin: { kind: 'composer' } })
  await respond($, 3)
  await say($, 'Nearly there. [D' + (35 - ROLLBACK_MIN + 5) + '%]', 'a3')
  expect(await label($, 'desktop')).toBe('35%')
  // Without the person adding anything, a lower tag never moves the bar back.
  await say($, 'Hmm. [D10%]', 'a4')
  expect(await label($, 'desktop')).toBe('35%')
})

test('a message right after stopping an ask carries it on, to be re-estimated, rather than starting afresh', async ($, on) => {
  engine(on)
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Halfway. [D50%]', 'a1')
  await $.turn.complete({ reason: 'interrupted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(await label($, 'desktop')).toBe('50% · stopped')
  const sent = (await $.prompt.submit({ text: 'actually, change course', wait: false, origin: { kind: 'composer' } })) as { context?: readonly string[] }
  expect(sent.context?.length).toBe(1)
  await $.turn.start({ text: 'actually, change course', turnId: 't2' })
  expect(await label($, 'desktop')).toBe('50%')
})
