export type Phase = 'idle' | 'working' | 'done' | 'stopped'

export type Progress = {
  /** The highest estimate the model has given this ask, 0-100; null before the first tag. */
  percent: number | null
  phase: Phase
  /** An ask answered with no estimate at all: its bar fills, without the finale. */
  quiet?: boolean
}

export type Steps = {
  /** The task list's steps, and how many of them are done; no list is 0 steps. */
  total: number
  done: number
  /** The workers the step in progress sent out; none is 0, and no list leaves it out. */
  workers?: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { progress: Progress; steps: Steps; shown: string | null; inView: boolean; tick: number }
  }
}
