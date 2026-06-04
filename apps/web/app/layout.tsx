import type { Metadata } from 'next'
import { Providers } from './components/providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Tempo Store',
  description: 'Buy now, pay maybe with pathUSD on Tempo.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
