import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { flows } from '../model/model.ts'
import type { LinkKind } from '../../core/types.ts'
import { HIDDEN_BY_DEFAULT } from './kinds.ts'

export type View = 'topology' | 'map' | 'fleet' | 'products' | 'domains' | 'traffic' | 'security'
export type Selection = { type: 'node' | 'app'; id: string }
export interface FlowState {
  id: string
  step: number
  playing: boolean
}

export const STEP_MS = 2800
export const LAST_STEP_HOLD = 1.6

const VIEWS: View[] = ['topology', 'map', 'fleet', 'products', 'domains', 'traffic', 'security']
const viewFromHash = (): View => {
  const v = location.hash.slice(1) as View
  return VIEWS.includes(v) ? v : 'topology'
}

function useUiState() {
  const [view, setViewState] = useState<View>(viewFromHash)
  const setView = useCallback((v: View) => {
    setViewState(v)
    history.replaceState(null, '', `#${v}`)
  }, [])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [flow, setFlow] = useState<FlowState | null>(null)
  const [hidden, setHidden] = useState<Set<LinkKind>>(() => new Set(HIDDEN_BY_DEFAULT))
  const [showRetired, setShowRetired] = useState(false)
  // Asks the canvas to pan to these ids; `at` makes a repeat request for the same ids count.
  const [focusRequest, setFocusRequest] = useState<{ ids: string[]; at: number } | null>(null)

  const select = useCallback((next: Selection | null) => setSelection(next), [])
  const requestFocus = useCallback((ids: string[]) => setFocusRequest({ ids, at: Date.now() }), [])

  const toggleKind = useCallback(
    (kind: LinkKind) =>
      setHidden((prev) => {
        const next = new Set(prev)
        if (!next.delete(kind)) next.add(kind)
        return next
      }),
    [],
  )

  const playFlow = useCallback((id: string) => {
    setSelection(null)
    setFlow({ id, step: 0, playing: true })
  }, [])
  const stopFlow = useCallback(() => setFlow(null), [])
  const setStep = useCallback((step: number) => setFlow((f) => (f ? { ...f, step, playing: false } : f)), [])
  const togglePlay = useCallback(() => setFlow((f) => (f ? { ...f, playing: !f.playing } : f)), [])

  // Auto-advance; loops back to the first step after the last.
  useEffect(() => {
    if (!flow?.playing) return
    const steps = flows.find((f) => f.id === flow.id)?.steps.length ?? 0
    const timer = window.setTimeout(
      () => setFlow((f) => (f ? { ...f, step: (f.step + 1) % steps } : f)),
      flow.step === steps - 1 ? STEP_MS * LAST_STEP_HOLD : STEP_MS,
    )
    return () => window.clearTimeout(timer)
  }, [flow])

  return useMemo(
    () => ({
      view,
      setView,
      selection,
      select,
      flow,
      playFlow,
      stopFlow,
      setStep,
      togglePlay,
      hidden,
      toggleKind,
      showRetired,
      setShowRetired,
      focusRequest,
      requestFocus,
    }),
    [view, setView, selection, select, flow, playFlow, stopFlow, setStep, togglePlay, hidden, toggleKind, showRetired, focusRequest, requestFocus],
  )
}

export type Ui = ReturnType<typeof useUiState>

const UiContext = createContext<Ui | null>(null)

export function UiProvider({ children }: { children: ReactNode }) {
  return <UiContext.Provider value={useUiState()}>{children}</UiContext.Provider>
}

export function useUi() {
  const ui = useContext(UiContext)
  if (!ui) throw new Error('useUi outside UiProvider')
  return ui
}

export function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setReduced(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return reduced
}
