// ─── Column definition ────────────────────────────────────────────────────────
export type ColumnType = 'text' | 'date' | 'mono' | 'currency' | 'badge' | 'num' | 'status'

export interface ColumnDef {
  key: string
  label: string
  type: ColumnType
}

// ─── Filter types ─────────────────────────────────────────────────────────────
export type FilterKey = 'institution' | 'dateFrom' | 'dateTo' | 'status' | 'agent' | 'year' | 'monthFrom' | 'monthTo'

export interface ReportFilters {
  institution?: string
  dateFrom?: string
  dateTo?: string
  status?: string
  agent?: string
  year?: string
  monthFrom?: string
  monthTo?: string
  /** Per-institution date overrides. Only used when institution is empty (All). */
  institutionDates?: Record<string, { dateFrom: string; dateTo: string }>
  /** Institutions to exclude from the report. */
  excludedInstitutions?: string[]
  /** GROOMING MFI portfolio segment filter. */
  groomingMfiSegment?: 'all' | '90+' | '360+'
}

// ─── Report config (one per report in reports.config.ts) ─────────────────────
export interface ReportConfig {
  id: string
  label: string
  category: string
  tag: string
  desc: string
  bqKey: string                    // maps to a function in lib/bq/queries.ts
  filters: FilterKey[]
  coreColumns: ColumnDef[]
  extraColumns: ColumnDef[]
  // Institution-aware query builder (optional — overrides default bqKey lookup)
  buildQuery?: (filters: ReportFilters) => string
}

// ─── API payloads ─────────────────────────────────────────────────────────────
export interface RunReportPayload {
  bqKey: string
  filters: ReportFilters
  columns: string[]               // keys of visible columns
}

export interface ExportPayload extends RunReportPayload {
  format: 'csv' | 'excel' | 'pdf'
  reportLabel: string
}

// ─── Row data returned from BQ ────────────────────────────────────────────────
export type ReportRow = Record<string, string | number | null>

export interface RunReportResponse {
  rows: ReportRow[]
  rowCount: number
  executionMs: number
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface FSSTUser {
  uid: string
  email: string
  displayName: string
  role: 'admin' | 'agent' | 'viewer'
}
