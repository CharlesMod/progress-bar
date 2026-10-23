// The simulator's recorder: drives the real plugin through scripted asks and prints every drawing
// the desktop band would show, one `SIM {json}` line on stderr each. sim/build.py runs it as a test
// in a scratch copy of the plugin (the runner prints nothing else a test says) and replays it.
import { mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

/** The engine beneath the plugin, as the tests stand it in. */
function engine(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>empty band</Text>
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))
}

/** A scripted ask: each `step` does something and records what the band then draws. */
function scenario(name: string, about: string, store: Record<string, unknown> | null, script: (s: Script) => Promise<void>) {
  test(`sim: ${name}`, async ($, on) => {
    engine(on)
    if (store !== null) mock.store(on, store)
    await $.prompt.compose(COMPOSE)
    let index = 0
    let turn = 0
    const s: Script = {
      ask: async text => {
        turn += 1
        await $.turn.start({ text, turnId: `t${turn}` })
        await s.snap(`ask: "${text}"`)
      },
      say: async text => {
        index += 1
        for await (const _ of $.turn.step({ turnId: `t${turn}`, index, model: 'claude-opus-5-5', messageCount: 0 }));
        await $.session.append({
          message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
          door: 'response',
          origin: { kind: 'model', model: 'claude-opus-5-5' },
          uuid: `u${turn}-${index}`,
        })
        await s.snap(`says: ${text}`)
      },
      call: async (n = 1) => {
        for (let i = 0; i < n; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
        await s.snap(n === 1 ? 'tool call' : `${n} tool calls`)
      },
      plan: async (items, what) => {
        await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items })
        await s.snap(what)
      },
      advance: async what => {
        await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
        await s.snap(what)
      },
      answer: async text => {
        await $.turn.complete({ reason: 'answer', answer: text, durationMs: 1, isAborted: false, turnId: `t${turn}` })
        await s.snap(`answers`)
      },
      snap: async event => {
        const ui = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', ...BAND })
        const svgs = (await ui.findAll({ type: 'Svg' })).filter(el => el.props.alt !== '')
        // The band's tree lists the drawing beneath first and the one on top last.
        const layers = svgs.map(el => String(el.props.source))
        const label = svgs.length > 0 ? String(svgs.at(-1)!.props.alt).replace(/^.*: /, '') : null
        await ui.unmount()
        console.error('SIM ' + JSON.stringify({ scenario: name, about, event, label, layers }))
      },
    }
    await script(s)
  })
}

type Script = {
  ask: (text: string) => Promise<void>
  say: (text: string) => Promise<void>
  call: (n?: number) => Promise<void>
  plan: (items: { content: string; status: string }[], what: string) => Promise<void>
  advance: (what: string) => Promise<void>
  answer: (text: string) => Promise<void>
  snap: (event: string) => Promise<void>
}

const steps = (names: string[]) => names.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))

scenario('tags, no list', 'The model tags 20%, then 70%, then finishes: two large moves and the finale.', null, async s => {
  await s.ask('do the thing')
  await s.say('Starting. [D20%]')
  await s.call()
  await s.say('Most of the way. [D70%]')
  await s.call()
  await s.say('Done. [D100%]')
  await s.answer('Done.')
})

scenario('small moves', 'Estimates creeping up 2% at a time: moves under 3% of the bar keep the drawing.', null, async s => {
  await s.ask('creep')
  for (const p of [10, 12, 14, 16, 30]) {
    await s.say(`Working. [D${p}%]`)
    await s.call()
  }
  await s.answer('ok')
})

scenario('task list', 'Three steps: a tag inside a step, check-offs that blink and slide the sections, the finale.', null, async s => {
  await s.ask('three steps')
  await s.plan(steps(['read', 'change', 'test']), 'plan: 3 steps')
  await s.say('Reading. [D50%]')
  await s.call()
  await s.advance('check off step 1')
  await s.say('Changing. [D40%]')
  await s.call()
  await s.advance('check off step 2')
  await s.say('Testing. [D60%]')
  await s.advance('check off step 3')
  await s.say('All done. [D100%]')
  await s.answer('All done.')
})

scenario('learned fill, no tags', 'History says asks take 10 calls; the model never tags: calls fill it, the answer fills it.', { 'history.2': { steps: [], asks: [10, 10, 10, 10], said: [] } }, async s => {
  await s.ask('untagged work')
  for (let i = 0; i < 6; i++) await s.call()
  await s.answer('ok')
})

scenario('learned fill, list', 'History says steps take 4 calls: each step fills from calls, under any tag.', { 'history.2': { steps: [4, 4, 4], asks: [], said: [] } }, async s => {
  await s.ask('two steps')
  await s.plan(steps(['one', 'two']), 'plan: 2 steps')
  await s.call()
  await s.call()
  await s.advance('check off step 1')
  await s.call()
  await s.say('Nearly. [D90%]')
  await s.advance('check off step 2')
  await s.answer('done')
})

scenario('quick answer', 'No tool calls, no tags: the bar fills quietly on the answer, without the finale.', null, async s => {
  await s.ask('what time is it')
  await s.answer('noon')
})
