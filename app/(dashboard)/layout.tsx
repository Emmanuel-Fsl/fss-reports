'use client'

import { useEffect, useState }       from 'react'
import { useRouter }                  from 'next/navigation'
import { onAuthStateChanged }         from 'firebase/auth'
import { auth }                       from '@/lib/firebase/client'
import Sidebar                        from '@/components/layout/Sidebar'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  // If Firebase already has a current user (cached from previous auth), skip the
  // loading state entirely — avoids the 300–1500ms spinner on every navigation.
  const [checking, setChecking] = useState(() => !auth.currentUser)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (!user) router.replace('/login')
      setChecking(false)
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#FAFAFA]">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
