import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { blinkTimes, lastPercent, settle, stripTags } from './register'

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } } as const
const BAND_PROPS = {
  hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {},
}
const BAND = { component: 'AbovePrompt', props: BAND_PROPS } as const
const SURVEY = { component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } } as const
const SURFACES = ['terminal', 'desktop'] as const

/** Stands in for the engine beneath the plugin: its turns, the hint line under the prompt and the band above it. */
// The engine's clock, in ms; a test moves it by hand.
let clock = 1_000_000

function engine(on: On) {
  on('clock.now', () => ({ value: clock }))
  // The next drawing's timer: the tests move the clock and redraw by hand instead.
  on('clock.sleep', () => new Promise(() => {}))
  // The still redraw's timer: the tests move the clock and redraw by hand instead.
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
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

test('an interrupted ask keeps its last estimate, marked stopped', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'long job', turnId: 't1' })
  await say($, 'Halfway. [D50%]', 'a1')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(await label($, 'terminal')).toBe('50% · stopped')
})


async function source($: Engine) {
  const band = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
  const svg = (await band.find({ type: 'Svg' }))?.props.source as string | undefined
  await band.unmount()
  return svg
}

test('an estimate moves the bar forward or not at all', () => {
  expect(settle(null, 30)).toBe(30)
  expect(settle(40, 30)).toBe(40)
  expect(settle(40, 55)).toBe(55)
})

test('only the model moves the bar: tool calls and the task list leave it alone', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'job', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }] })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await label($, 'desktop')).toBeUndefined()
  await say($, 'Started. [D20%]', 'a1')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' })
  expect(await label($, 'desktop')).toBe('20%')
})

test('a message sent mid-ask keeps the bar where it was', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D30%]', 'a1')
  await $.turn.start({ text: 'also this', turnId: 't2' })
  expect(await label($, 'desktop')).toBe('30%')
})

// Where the drawn fill starts out, 0 to 1: its width times the scale it is drawn at.
const fillOf = (svg: string) => {
  const rect = svg.match(/<rect [^>]*fill="url\(#ramp\)"[^>]*>/)?.[0]
  if (rect === undefined) return 0
  const width = Number(rect.match(/\* ([\d.]+)\)\)/)![1])
  return width * Number(rect.match(/scale\(([\d.]+) 1\)/)![1])
}

// The fill a drawing starts at, 0 to 1: its width times the scale it is drawn at.
const startFill = (svg: string) => {
  const rect = svg.match(/<rect [^>]*fill="url\(#ramp\)"[^>]*>/)?.[0]
  if (rect === undefined) return 0
  return Number(rect.match(/\* ([\d.]+)\)\)/)![1]) * Number(rect.match(/scale\(([\d.]+) 1\)/)![1])
}

test('each fresh drawing starts as far into the ease as the time gone by, and never behind', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'job', turnId: 't1' })
  await say($, 'Started. [D20%]', 'a1')
  let svg = (await source($))!
  expect(svg).toContain('begin="-0.090s"')
  clock += 200
  svg = (await source($))!
  expect(svg).toContain('begin="-0.290s"')
  const mid = startFill(svg)
  // A new estimate partway through carries on from where the fill shows, never back.
  await say($, 'More. [D60%]', 'a2')
  let seen = startFill((await source($))!)
  expect(seen >= mid - 0.0005).toBe(true)
  for (let i = 0; i < 7; i++) {
    clock += 100
    const next = startFill((await source($))!)
    expect(next >= seen - 0.0005).toBe(true)
    seen = next
  }
  // At rest the bar is drawn still: nothing left to replay.
  svg = (await source($))!
  expect(svg).not.toContain('<animate')
  expect(Math.abs(startFill(svg) - 0.6) < 0.001).toBe(true)
  // The model's [D100%] gets the finale, then settles to a still gold glow.
  await say($, 'Done. [D100%]', 'a3')
  await source($)
  clock += 1000
  expect((await source($))!).toContain('href="#star"')
  clock += 4000
  svg = (await source($))!
  expect(svg).not.toContain('<animate')
  expect(svg).toContain('opacity="0.45"')
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
  clock += 2000
  await source($)
  // A four-step list: four sections, and the fill doesn't move.
  const items = ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
  let svg = (await source($))!
  expect(svg.match(/<clipPath id="sec">(.*?)<\/clipPath>/)![1].match(/<rect /g)!.length).toBe(4)
  expect(svg).not.toContain('<animate')
  expect(await label($, 'desktop')).toBe('10%')
  // Advancing the list doesn't move it either.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await label($, 'desktop')).toBe('10%')
  // The model's estimate crosses the first section's end: that section blinks, once, partway into the ease.
  await say($, 'Step one done. [D40%]', 'a2')
  svg = (await source($))!
  const blinks = [...svg.matchAll(/values="0;1;0;1;0" dur="0.6s" begin="([\d.-]+)s"/g)].map(m => Number(m[1]))
  expect(blinks.length).toBe(1)
  expect(blinks[0]! > 0 && blinks[0]! < 0.55).toBe(true)
  // A new ask starts with one section again.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.start({ text: 'next', turnId: 't2' })
  await say($, 'Go. [D5%]', 'b1')
  expect((await source($))!).not.toContain('id="sec"')
})

test('sections finished in one sweep blink one after another', () => {
  // From 35% to 80% of four sections: the second and third finish, the third waits for the second.
  const [second, third] = blinkTimes(0.35, 0.8, 4, false)
  expect(second!.i).toBe(1)
  expect(third!.i).toBe(2)
  expect(third!.at - second!.at >= 0.6 - 0.001).toBe(true)
  // A slow-enough sweep needs no waiting; a finished ask leaves the last section to the finale.
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
