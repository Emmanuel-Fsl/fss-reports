'use client'

import { useState }                        from 'react'
import Image                               from 'next/image'
import Link                                from 'next/link'
import { useParams, useRouter }             from 'next/navigation'
import { signOut }                         from 'firebase/auth'
import { auth }                            from '@/lib/firebase/client'
import { REPORTS, getReportsByCategory }   from '@/lib/reports/reports.config'
import clsx                                from 'clsx'

export default function Sidebar() {
  const { reportId } = useParams<{ reportId?: string }>()
  const router       = useRouter()
  const [search, setSearch] = useState('')

  const grouped = getReportsByCategory()

  const filtered = Object.entries(grouped).reduce((acc, [cat, reports]) => {
    const matching = reports.filter(r =>
      r.label.toLowerCase().includes(search.toLowerCase())
    )
    acc[cat] = matching
    return acc
  }, {} as Record<string, typeof REPORTS>)

  async function handleSignOut() {
    await signOut(auth)
    router.replace('/login')
  }

  return (
    <aside className="flex h-screen w-[260px] flex-shrink-0 flex-col border-r border-gray-200 bg-white">
      {/* Logo */}
      <div className="border-b border-gray-200 px-5 py-5">
        <div className="flex items-center gap-2">
          <Image
            src="/fss-logo.svg"
            alt="FSS"
            width={87}
            height={87}
            className="h-[87px] w-[87px] rounded-md"
            priority
          />
          <p className="text-[13px] font-bold text-gray-900">FSS Reports</p>
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-gray-200 px-4 py-3">
        <input
          type="text"
          placeholder="Search reports..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-900 outline-none placeholder:text-gray-400 focus:border-[#2E7D32]"
        />
      </div>

      {/* Report list */}
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {Object.entries(filtered).map(([category, reports]) => (
          <div key={category}>
            {/* Category header */}
            <div className="flex items-center justify-between px-4 pb-1 pt-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                {category}
              </span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-400">
                {reports.length}
              </span>
            </div>

            {/* Report items */}
            {reports.map(report => (
              <Link
                key={report.id}
                href={`/reports/${report.id}`}
                className={clsx(
                  'mb-px flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors',
                  reportId === report.id
                    ? 'bg-[#E8F5E9] text-[#1B5E20]'
                    : 'text-gray-700 hover:bg-gray-100'
                )}
              >
                <span
                  className={clsx(
                    'mt-px h-1.5 w-1.5 flex-shrink-0 rounded-full',
                    reportId === report.id ? 'bg-[#2E7D32]' : 'bg-gray-300'
                  )}
                />
                <span className="flex-1 text-[12.5px] font-semibold leading-snug">
                  {report.label}
                </span>
                <span
                  className={clsx(
                    'rounded px-1 py-px text-[10px] font-bold',
                    reportId === report.id
                      ? 'bg-[#2E7D32]/10 text-[#2E7D32]'
                      : 'bg-gray-100 text-gray-400'
                  )}
                >
                  {report.tag}
                </span>
              </Link>
            ))}
          </div>
        ))}

        {Object.values(filtered).every(reports => reports.length === 0) && (
          <p className="mt-8 text-center text-xs text-gray-400">No reports match</p>
        )}
      </nav>

      {/* Sign out */}
      <div className="border-t border-gray-200 px-4 py-3">
        <button
          onClick={handleSignOut}
          className="w-full rounded-md px-3 py-2 text-left text-xs font-semibold text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
