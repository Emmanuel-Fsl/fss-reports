'use client'

import { useParams }            from 'next/navigation'
import { REPORTS }              from '@/lib/reports/reports.config'
import ReportView               from '@/components/reports/ReportView'
import BillingReportView        from '@/components/reports/BillingReportView'
import WeeklyTrendView          from '@/components/reports/WeeklyTrendView'
import AgentPerformanceView     from '@/components/reports/AgentPerformanceView'
import ConcessionTrackerView    from '@/components/reports/ConcessionTrackerView'
import ActivityReportView       from '@/components/reports/ActivityReportView'
import RecoveryMethodsView      from '@/components/reports/RecoveryMethodsView'

// Reports that have their own dedicated view component
const CUSTOM_IDS = new Set(['billing_report', 'weekly_trend_report', 'agent_performance', 'concession_tracker', 'activity_report', 'recovery_methods'])

export default function ReportPage() {
  const { reportId } = useParams<{ reportId: string }>()

  return (
    <>
      <div className={reportId === 'billing_report'      ? 'flex flex-col' : 'hidden'}>
        <BillingReportView />
      </div>

      <div className={reportId === 'weekly_trend_report' ? 'flex flex-col' : 'hidden'}>
        <WeeklyTrendView />
      </div>

      <div className={reportId === 'agent_performance' ? 'flex flex-col' : 'hidden'}>
        <AgentPerformanceView />
      </div>

      <div className={reportId === 'concession_tracker' ? 'flex flex-col' : 'hidden'}>
        <ConcessionTrackerView />
      </div>

      <div className={reportId === 'activity_report' ? 'flex flex-col' : 'hidden'}>
        <ActivityReportView />
      </div>

      <div className={reportId === 'recovery_methods' ? 'flex flex-col' : 'hidden'}>
        <RecoveryMethodsView />
      </div>

      {/* Recovery Methods — temporarily disabled, hidden until ready */}

      {/* Generic ReportView for all other reports */}
      {REPORTS.filter(r => !CUSTOM_IDS.has(r.id)).map(report => (
        <div key={report.id} className={reportId === report.id ? 'flex flex-col' : 'hidden'}>
          <ReportView report={report} />
        </div>
      ))}

      {!REPORTS.find(r => r.id === reportId) && (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          Report not found: <code className="ml-2 font-mono">{reportId}</code>
        </div>
      )}
    </>
  )
}
