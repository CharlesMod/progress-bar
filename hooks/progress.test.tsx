import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyPlan, blinkTimes, fillSeconds, lastPercent, place, settle, stripTags, tally } from './register'

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } } as const
const BAND_PROPS = {
  hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {},
}
const BAND = { component: 'AbovePrompt', props: BAND_PROPS } as const
const SURVEY = { component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } } as const
const SURFACES = ['terminal', 'desktop'] as const

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
      : ((await ui.find({ type: 'Svg' }))?.props.alt as string | undefined)
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
    // A new ask clears the last one's bar until its first estimate.
    await $.turn.start({ text: 'refactor everything', turnId: `t-${surface}` })
    expect(await label($, surface)).toBeUndefined()

    await say($, 'Mapped the code. [D42.5%]', `a-${surface}`)
    expect(await label($, surface)).toBe('42.5%')

    // The bar only moves forward: a lower estimate leaves it where it is.
    await say($, 'Found more callers than expected. [D30%]', `b-${surface}`)
    expect(await label($, surface)).toBe('42.5%')

    // The turn's end doesn't move it either: only the model's own [D100%] fills it.
    await $.turn.complete({
      reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: `t-${surface}`,
    })
    expect(await label($, surface)).toBe('42.5%')
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


async function source($: Engine) {
  const band = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
  const svg = (await band.find({ type: 'Svg' }))?.props
  await band.unmount()
  expect(svg === undefined || svg.isInteractive === true).toBe(true)
  return svg?.source as string | undefined
}

test('an estimate moves the bar forward or not at all', () => {
  expect(settle(null, 30)).toBe(30)
  expect(settle(40, 30)).toBe(40)
  expect(settle(40, 55)).toBe(55)
})

test('a task list shows the bar empty before any estimate, tool calls leave it alone, and the wrap-up checks it all off', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBeUndefined()
  // A plan is up, so the bar is too: empty, in its sections, before the first estimate.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }] })
  expect(await label($, 'desktop')).toBe('0%')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBe('0%')
  await say($, 'Started. [D20%]', 'a1')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBe('20%')
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

// Where a drawing's fill eases from and to, 0 to 1 (the same place when it's drawn still).
function moveOf(svg: string): [number, number] {
  const eased = svg.match(/type="scale" additive="sum" from="([\d.]+) 1" to="([\d.]+) 1"/)
  if (eased) return [Number(eased[1]), Number(eased[2])]
  const still = Number(svg.match(/translate\([\d.]+ 0\) scale\(([\d.]+) 1\)/)![1])
  return [still, still]
}

test('the fill eases from the last estimate to the new one, and the finale plays once, frozen at its end', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D20%]', 'a1')
  let svg = (await source($))!
  expect(moveOf(svg)).toEqual([0, 0.2])
  expect(svg).toContain('keySplines="0.42 0 0.58 1"')
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
  expect(moveOf(svg)).toEqual([0.025, 0.025])
  expect(svg).not.toContain('<animate')
  expect(await label($, 'desktop')).toBe('2.5%')
  // Finishing the first step, then an estimate for the second: the fill crosses the first
  // section's end, and that section blinks, once, as it passes.
  await respond($, 1)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await say($, 'Into step two. [D60%]', 'a2')
  svg = (await source($))!
  const blinks = [...svg.matchAll(/values="0;1;0;1;0" dur="0.6s" begin="([\d.-]+)s"/g)].map(m => Number(m[1]))
  expect(blinks.length).toBe(1)
  expect(blinks[0]! > 0 && blinks[0]! < fillSeconds(0.025, 0.4)).toBe(true)
  expect(moveOf(svg)).toEqual([0.025, 0.4])
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
  on('tool.call', () => ({ result: {} }))
  const call = async () => ((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: readonly string[] }).context ?? []
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D10%]', 'a1')
  expect(await call()).toEqual([])
  expect(await call()).toEqual([])
  const third = await call()
  expect(third.length).toBe(1)
  expect(third[0]).toContain('[D40%]')
  // Once per lapse: the fourth says nothing.
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
