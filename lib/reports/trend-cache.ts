import type { ReportRow } from '@/types'

export interface TrendSnapshot {
  rows:        ReportRow[]
  year:        string
  monthFrom:   number
  monthTo:     number
  institution: string
  execMs:      number | null
  fxRate:      number
}

// Shared module-level cache — one instance per browser session.
// Both WeeklyTrendView and TrendMiniChart import from here.
export let trendCache: TrendSnapshot | null = null
export function setTrendCache(snap: TrendSnapshot | null) { trendCache = snap }
