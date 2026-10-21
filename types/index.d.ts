export type Phase = 'idle' | 'working' | 'done' | 'stopped'

export type Progress = {
  /** The highest estimate the model has given this ask, 0-100; null before the first tag. */
  percent: number | null
  phase: Phase
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { progress: Progress; steps: number; tick: number }
  }
}
