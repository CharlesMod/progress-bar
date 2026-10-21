export type Phase = 'idle' | 'working' | 'done' | 'stopped'

export type Progress = {
  /** The model's latest estimate, 0-100; null before the first tag of the ask. */
  percent: number | null
  phase: Phase
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { progress: Progress }
  }
}
