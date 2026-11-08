import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@xyflow/react/dist/base.css'
import './styles.css'
import { startLive } from './live.ts'
import { DataError, followChanges, loadTopology } from './source.ts'

const root = createRoot(document.getElementById('root')!)
followChanges()
startLive()

try {
  await loadTopology()
  // The app's modules derive their indexes from the topology when they load, so import them after it.
  const { App } = await import('./App.tsx')
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (e) {
  const details = e instanceof DataError ? e.details : [String(e)]
  root.render(
    <div className="fatal">
      <span className="eyebrow eyebrow--accent">Malha</span>
      <h1>{e instanceof DataError ? e.message : 'Could not load the topology'}</h1>
      <ul>
        {details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <p>Fix the file and save; this page reloads by itself.</p>
    </div>,
  )
}
