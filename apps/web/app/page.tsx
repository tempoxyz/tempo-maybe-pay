import { Suspense } from 'react'
import { Shop } from './components/shop'

export default function Page() {
  return (
    <Suspense fallback={<main className="shell">Loading Tempo Maybe Pay...</main>}>
      <Shop />
    </Suspense>
  )
}

