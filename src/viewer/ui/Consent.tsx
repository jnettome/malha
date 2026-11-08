import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { Answer, PermissionKind } from '../../core/live.ts'
import { answer, useLive } from '../live.ts'
import { Corners } from './parts.tsx'

const VERB: Record<PermissionKind, string> = {
  exec: 'run a program',
  fetch: 'make a web request',
  files: 'read a file',
  env: 'read an environment variable',
}

/**
 * A live plugin wants to do something not yet approved. Like Claude Code's prompts: yes for now,
 * yes and don't ask again for this pattern, or no. Keys 1, 2, 3; Esc is no. Focus starts on the
 * dialog, not a button, so a stray Enter approves nothing.
 */
export function Consent() {
  const ask = useLive()?.asks[0]
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const reply = async (value: Answer) => {
    if (!ask || busy) return
    setBusy(true)
    setError(await answer(ask.id, value))
    setBusy(false)
  }

  useEffect(() => {
    if (!ask) return
    setError(undefined)
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      const value = ({ '1': 'once', '2': 'always', '3': 'deny', Escape: 'deny' } as Record<string, Answer>)[e.key]
      if (!value) return
      e.preventDefault()
      e.stopPropagation()
      void reply(value)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // reply reads the current ask; re-bind per question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.id])

  return (
    <AnimatePresence>
      {ask && (
        <motion.div className="consent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <motion.div
            ref={box}
            className="consent__box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="consent-title"
            aria-describedby="consent-detail"
            tabIndex={-1}
            initial={{ y: 12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <Corners />
            <span className="eyebrow eyebrow--accent">Plugin request</span>
            <h2 id="consent-title">
              <span className="consent__plugin">{ask.question.plugin}</span> wants to {VERB[ask.question.kind]}
            </h2>
            <code id="consent-detail" className="consent__detail">
              {ask.question.detail}
            </code>
            <p className="consent__rule">
              Declared in its manifest as <code>{ask.question.rule}</code>
            </p>
            <div className="consent__actions">
              <button className="consent__btn consent__btn--yes" disabled={busy} onClick={() => void reply('once')}>
                <kbd>1</kbd> Yes, while malha dev runs
              </button>
              <button className="consent__btn" disabled={busy} onClick={() => void reply('always')}>
                <kbd>2</kbd> Yes, and don't ask again for this pattern
              </button>
              <button className="consent__btn consent__btn--no" disabled={busy} onClick={() => void reply('deny')}>
                <kbd>3</kbd> No
              </button>
            </div>
            {error && <p className="consent__error">{error}</p>}
            <p className="consent__meta">
              {ask.question.plugin} {ask.question.version} · code {ask.question.hash} · reads only its own folder · network blocked by {ask.question.network}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
