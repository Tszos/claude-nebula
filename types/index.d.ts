export type CachePhase = 'unknown' | 'busy' | 'warm' | 'expiring' | 'cold'

/** Everything the scene draws from. Each field is quantized, so a write means a visible change. */
export type Sky = {
  /** context window fill, whole percent; null before the first response */
  ctxPercent: number | null
  /** input tokens of the last response; null before the first response */
  ctxTokens: number | null
  /** five-hour window (or a gateway spend limit), whole percent; null with no reading */
  shortLimit: number | null
  /** label for `shortLimit`: `5H` or `SPEND` */
  shortLabel: string
  /** seven-day window, whole percent; null with no reading */
  weekLimit: number | null
  cache: CachePhase
  /** minutes of warm cache left: 5-minute steps while warm, 1-minute steps while expiring */
  cacheLeftMin: number | null
}

declare module 'claude-code' {
  interface PluginState {
    nebula: { sky: Sky }
  }
}
