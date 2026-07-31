import { buildAgentPerformanceQuery } from './lib/reports/agent-performance.queries'
const sql = buildAgentPerformanceQuery({ dateFrom: '2026-07-01', dateTo: '2026-07-20' })
console.log(sql.split('\n').filter(l => l.includes('ptp_rate') || l.includes('ptp_rank') || l.includes('ptp_dimension') || l.includes('ptp_volume')).join('\n') || '(no matches — fully removed)')
