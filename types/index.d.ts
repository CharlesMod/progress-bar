export type Phase = 'idle' | 'working' | 'done' | 'stopped'

export type Progress = {
  /** The highest estimate the model has given this ask, 0-100; null before the first tag. */
  percent: number | null
  phase: Phase
}

export type Steps = {
  /** The task list's steps, and how many of them are done; no list is 0 steps. */
  total: number
  done: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { progress: Progress; steps: Steps }
  }
}
