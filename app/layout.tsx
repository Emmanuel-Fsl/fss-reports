import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'

const nunitoSans = localFont({
  src: [
    { path: './fonts/nunito-sans-latin-300-normal.woff2', weight: '300', style: 'normal' },
    { path: './fonts/nunito-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/nunito-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/nunito-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-nunito',
})

const firaCode = localFont({
  src: [
    { path: './fonts/fira-code-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/fira-code-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-fira',
})

export const metadata: Metadata = {
  title: 'FSS Reports',
  description: 'FSS Reports - Reporting Platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${nunitoSans.variable} ${firaCode.variable}`}>
      <body>{children}</body>
    </html>
  )
}
