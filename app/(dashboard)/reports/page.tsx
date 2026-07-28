'use client'

import TrendMiniChart from '@/components/dashboard/TrendMiniChart'

export default function ReportsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 px-8 py-8">
      <div>
        <h2 className="text-[15px] font-bold text-gray-800">Dashboard</h2>
        <p className="mt-0.5 text-xs text-gray-400">Select a report from the sidebar, or review recent data below</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <TrendMiniChart />
      </div>
    </div>
  )
}
