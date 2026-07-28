import type { ReportRow, ColumnDef } from '@/types'

// ─── CSV ──────────────────────────────────────────────────────────────────────
export function toCSV(rows: ReportRow[], columns: ColumnDef[]): string {
  const header = columns.map(c => `"${c.label}"`).join(',')
  const body = rows.map(row =>
    columns.map(c => {
      const val = row[c.key] ?? ''
      return `"${String(val).replace(/"/g, '""')}"`
    }).join(',')
  ).join('\n')
  return header + '\n' + body
}

export function downloadCSV(rows: ReportRow[], columns: ColumnDef[], filename: string) {
  const csv  = toCSV(rows, columns)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  triggerDownload(blob, `${filename}.csv`)
}

// ─── Excel (via xlsx) ─────────────────────────────────────────────────────────
export async function downloadExcel(
  rows: ReportRow[],
  columns: ColumnDef[],
  filename: string,
  reportLabel: string,
) {
  const XLSX = await import('xlsx')

  const sheetData = [
    columns.map(c => c.label),
    ...rows.map(row => columns.map(c => row[c.key] ?? '')),
  ]

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(sheetData)

  // Column widths
  ws['!cols'] = columns.map(() => ({ wch: 20 }))

  XLSX.utils.book_append_sheet(wb, ws, reportLabel.slice(0, 31))
  XLSX.writeFile(wb, `${filename}.xlsx`)
}

// ─── PDF (via jspdf + jspdf-autotable) ───────────────────────────────────────
export async function downloadPDF(
  rows: ReportRow[],
  columns: ColumnDef[],
  filename: string,
  reportLabel: string,
  filters: Record<string, string>,
) {
  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  // Header
  doc.setFontSize(14)
  doc.setTextColor(46, 125, 50)
  doc.text('FSS — ' + reportLabel, 14, 16)

  doc.setFontSize(8)
  doc.setTextColor(107, 114, 128)
  const filterStr = Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ·   ')
  if (filterStr) doc.text(filterStr, 14, 22)
  doc.text(`Generated: ${new Date().toLocaleString('en-NG')}`, 14, 27)

  autoTable(doc, {
    startY: 32,
    head: [columns.map(c => c.label)],
    body: rows.map(row => columns.map(c => String(row[c.key] ?? '—'))),
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 3,
    },
    headStyles: {
      fillColor: [46, 125, 50],
      textColor: 255,
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [232, 245, 233],
    },
    margin: { left: 14, right: 14 },
  })

  doc.save(`${filename}.pdf`)
}

// ─── Billing Excel (multi-sheet) ─────────────────────────────────────────────
export interface BillingSheet {
  name: string
  rows: ReportRow[]
  cols: ColumnDef[]
}

export async function downloadBillingExcel(
  sheets: BillingSheet[],
  filename: string,
) {
  const XLSX = await import('xlsx')
  const wb   = XLSX.utils.book_new()

  for (const sheet of sheets) {
    const sheetData = [
      sheet.cols.map(c => c.label),
      ...sheet.rows.map(row => sheet.cols.map(c => row[c.key] ?? '')),
    ]
    const ws        = XLSX.utils.aoa_to_sheet(sheetData)
    ws['!cols']     = sheet.cols.map(c => ({ wch: colWidth(c.key) }))
    // Sheet names are max 31 chars
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
  }

  XLSX.writeFile(wb, `${filename}.xlsx`)
}

function colWidth(key: string): number {
  if (key === 'Email') return 28
  if (key === 'institution') return 24
  if (['amount_recovered', 'revenue_pre_wht', 'revenue_post_wht', 'wht_5pct',
       'Assigned Amount', 'Amount Recovered', 'Current Loan Balance'].includes(key)) return 22
  if (['First Name', 'Last Name', 'Middle Name', 'Full Name'].includes(key)) return 20
  if (key === 'commission') return 12
  if (key === 'bucket') return 10
  return 18
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

