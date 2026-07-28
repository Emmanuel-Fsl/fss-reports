import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-nunito)', 'Nunito Sans', 'sans-serif'],
        mono: ['var(--font-fira)',   'Fira Code',   'monospace'],
      },
      colors: {
        green: {
          DEFAULT: '#2E7D32',
          light:   '#E8F5E9',
          mid:     '#4CAF50',
          dark:    '#1B5E20',
        },
      },
    },
  },
  plugins: [],
}

export default config
