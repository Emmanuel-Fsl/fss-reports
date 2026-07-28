'use client'

import Image from 'next/image'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithEmailAndPassword, signInWithPopup, signOut } from 'firebase/auth'
import { auth, googleProvider } from '@/lib/firebase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await signInWithEmailAndPassword(auth, email, password)
      router.replace('/reports')
    } catch {
      setError('Invalid email or password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError('')
    setGoogleLoading(true)
    try {
      const cred = await signInWithPopup(auth, googleProvider)
      const userEmail = cred.user.email ?? ''
      if (!userEmail.endsWith('@fsldigital.com')) {
        await signOut(auth)
        setError('Only @fsldigital.com accounts are allowed.')
        return
      }
      router.replace('/reports')
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setError('Google sign-in failed. Please try again.')
      }
    } finally {
      setGoogleLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#f0faf0] to-[#e8f5e9] px-6">
      <div className="w-full max-w-[420px] rounded-2xl border border-[#e0efe0] bg-white px-10 py-12 shadow-[0_8px_40px_rgba(46,125,50,0.10)]">
        <div className="mb-2 flex items-center gap-4">
          <Image src="/fss-logo.svg" alt="FSS" width={82} height={82} priority />
          <p className="text-base font-bold text-[#1B5E20]">FSS Reports</p>
        </div>

        <div className="mb-5 h-px bg-[#e8f0e8]" />

        <h1 className="mb-1 text-[22px] font-bold tracking-[-0.3px] text-[#1B5E20]">Welcome back</h1>
        <p className="mb-5 text-[13px] text-[#5A8A5A]">Sign in to access reports</p>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={googleLoading || loading}
          className="mb-1 flex w-full items-center justify-center gap-2.5 rounded-lg border border-[#D4DCD4] bg-white px-3 py-[11px] text-[13px] font-semibold text-[#1C211C] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {googleLoading ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#D4DCD4] border-t-[#2E7D32]" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
          )}
          {googleLoading ? 'Signing in...' : 'Continue with Google'}
        </button>

        <div className="my-5 flex items-center gap-2.5">
          <div className="h-px flex-1 bg-[#e8f0e8]" />
          <span className="text-[11px] text-[#A8B4A8]">or sign in with email</span>
          <div className="h-px flex-1 bg-[#e8f0e8]" />
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.7px] text-[#2A4A2A]">Email address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="rounded-lg border border-[#C8DCC8] bg-[#F7FBF7] px-3.5 py-2.5 text-[13px] text-[#111411] outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10"
              placeholder="you@fsldigital.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.7px] text-[#2A4A2A]">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="rounded-lg border border-[#C8DCC8] bg-[#F7FBF7] px-3.5 py-2.5 text-[13px] text-[#111411] outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10"
              placeholder="enter password"
            />
          </div>

          <button
            type="submit"
            disabled={loading || googleLoading}
            className="mt-1 rounded-lg bg-[#2E7D32] px-4 py-3 text-[13px] font-bold text-white transition hover:bg-[#1B5E20] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
