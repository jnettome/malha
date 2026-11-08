import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { DomainsView } from './domains/DomainsView.tsx'
import { FleetView } from './fleet/FleetView.tsx'
import { MapView } from './map/MapView.tsx'
import { ProductsView } from './products/ProductsView.tsx'
import { SecurityView } from './security/SecurityView.tsx'
import { TopologyView } from './topology/TopologyView.tsx'
import { Header, Stats } from './ui/Header.tsx'
import { Consent } from './ui/Consent.tsx'
import { Inspector } from './ui/Inspector.tsx'
import { UiProvider, useUi } from './ui/state.tsx'
import { meta } from './model/model.ts'

document.title = `${meta.name} · Malha`

const VIEWS = { topology: TopologyView, map: MapView, fleet: FleetView, products: ProductsView, domains: DomainsView, security: SecurityView }

function Shell() {
  const ui = useUi()
  const View = VIEWS[ui.view]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement) return
      if (ui.flow) ui.stopFlow()
      else ui.select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui])

  return (
    <div className="app">
      <Header />
      <Stats />
      <main className="stage">
        <AnimatePresence mode="wait">
          <motion.div
            key={ui.view}
            className="stage__view"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <View />
          </motion.div>
        </AnimatePresence>
        <Inspector />
      </main>
      <Consent />
    </div>
  )
}

export function App() {
  return (
    <UiProvider>
      <Shell />
    </UiProvider>
  )
}
