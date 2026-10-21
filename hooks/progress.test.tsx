import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { lastPercent, stripTags } from './register'

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
  const text = (await ui.find({ type: 'Text', text: /%/ }))?.text
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

test('follows the estimate up and down, then fills on the final answer', async ($, on) => {
  engine(on)
  expect(await label($, 'terminal')).toBeUndefined()
  for (const surface of SURFACES) {
    // A new ask clears the last one's bar until its first estimate.
    await $.turn.start({ text: 'refactor everything', turnId: `t-${surface}` })
    expect(await label($, surface)).toBeUndefined()

    await say($, 'Mapped the code. [D42.5%]', `a-${surface}`)
    expect(await label($, surface)).toBe('42.5%')

    await say($, 'Found more callers than expected. [D30%]', `b-${surface}`)
    expect(await label($, surface)).toBe('30%')

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

test('an interrupted ask keeps its last estimate, marked stopped', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'long job', turnId: 't1' })
  await say($, 'Halfway. [D50%]', 'a1')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(await label($, 'terminal')).toBe('50% · stopped')
})
