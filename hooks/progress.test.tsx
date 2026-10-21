import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { lastPercent } from './register'

const MODE = { component: 'SessionMode', props: { modes: [] } } as const
const SURFACES = ['terminal', 'desktop'] as const

/** Stands in for the engine beneath the plugin: its turns and its footer labels. */
function engine(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
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

async function label($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface, ...MODE })
  const text = (await ui.find({ type: 'Text', text: /%/ }))?.text
  await ui.unmount()
  return text
}

test('reads the last tag, with or without the D, clamped', () => {
  expect(lastPercent(['Starting [D5%]', 'more [D20.9%] then'])).toBe(20.9)
  expect(lastPercent(['went back [ 12.5 %]'])).toBe(12.5)
  expect(lastPercent(['overshoot [D140%]'])).toBe(100)
  expect(lastPercent(['no tag here', '[x%]'])).toBe(null)
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

test('an interrupted ask keeps its last estimate, marked stopped', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'long job', turnId: 't1' })
  await say($, 'Halfway. [D50%]', 'a1')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(await label($, 'terminal')).toBe('50% · stopped')
})
