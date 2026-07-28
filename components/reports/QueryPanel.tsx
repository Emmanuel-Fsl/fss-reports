'use client'

import { useState, useMemo } from 'react'
import { FiChevronDown, FiChevronUp } from 'react-icons/fi'
import type { ReportConfig, ReportFilters } from '@/types'

interface Props {
  report: ReportConfig
  filters: ReportFilters
}

function highlight(sql: string): string {
  return sql
    .replace(/\b(SELECT|FROM|WHERE|AND|GROUP BY|LEFT JOIN|ON|AS|ORDER BY|LIMIT|OFFSET|BY)\b/g,
      '<span style="color:#C792EA">$1</span>')
    .replace(/\b(SPLIT|ARRAY_AGG|SUM|MAX|ANY_VALUE|SAFE_OFFSET|SAFE_DIVIDE|ROUND|COUNT|AVG|COUNTIF|CASE|WHEN|THEN|ELSE|END)\b/g,
      '<span style="color:#82AAFF">$1</span>')
    .replace(/'([^']*)'/g,
      "<span style=\"color:#C3E88D\">'$1'</span>")
    .replace(/(--[^\n]*)/g,
      '<span style="color:#546E7A">$1</span>')
}

export default function QueryPanel({ report, filters }: Props) {
  const [expanded, setExpanded] = useState(false)

  const sql = useMemo(() => {
    if (!report.buildQuery) return ''
    return report.buildQuery(filters)
  }, [report, filters])

  return (
    <div
      style={{
        background: '#0F1117',
        borderBottom: '1px solid #1E2130',
        flexShrink: 0,
        overflow: 'hidden',
        maxHeight: expanded ? '220px' : '42px',
        transition: 'max-height 0.22s ease',
        position: 'relative',
        padding: '11px 28px',
      }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          position: 'absolute',
          right: '16px',
          top: '10px',
          fontSize: '11px',
          color: '#4B5563',
          background: '#1E2130',
          border: '1px solid #2D3148',
          borderRadius: '4px',
          padding: '3px 8px',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          zIndex: 10,
        }}
      >
        <span className="inline-flex items-center gap-1">
          {expanded ? (
            <>
              collapse <FiChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              expand <FiChevronDown className="h-3 w-3" />
            </>
          )}
        </span>
      </button>

      <p style={{ fontSize: '10px', color: '#3D4466', fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' }}>
        -- BigQuery - {report.bqKey}
      </p>

      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11.5px',
          lineHeight: '1.7',
          color: '#8B9CF0',
          overflowY: 'auto',
          maxHeight: '160px',
          whiteSpace: 'pre',
          margin: 0,
        }}
        dangerouslySetInnerHTML={{ __html: highlight(sql) }}
      />
    </div>
  )
}
