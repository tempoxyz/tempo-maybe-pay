import { Suspense } from 'react'
import { Shop } from './components/shop'

export default function Page() {
  return (
    <Suspense fallback={<main className="shell">Loading Tempo Store...</main>}>
      <Shop />
    </Suspense>
  )
}
