import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { LinkKind } from '../../core/types.ts'
import { FAMILIES, KINDS } from '../ui/kinds.ts'
import { Packets } from '../ui/Packets.tsx'
import { KindSwatch } from '../ui/parts.tsx'

export type EdgeEmphasis = 'normal' | 'dim' | 'lit' | 'active'

export type FlowEdgeData = {
  kind: LinkKind
  label?: string
  ports?: number[]
  emphasis: EdgeEmphasis
  /** Packets travel target → source (a flow step that runs against the link's direction). */
  reversed?: boolean
  /** Drawn only for a flow step that has no declared link. */
  hop?: boolean
  hovered?: boolean
  motion: boolean
}

export type FlowEdgeType = Edge<FlowEdgeData, 'flow'>

const PACKETS: Record<EdgeEmphasis, number> = { normal: 2, lit: 3, active: 5, dim: 0 }

export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdgeType>) {
  if (!data) return null
  const bracket = sourcePosition === targetPosition
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: bracket ? 30 : 22,
  })

  const k = KINDS[data.kind]
  const family = FAMILIES[k.family]
  const { emphasis } = data
  const length = Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY) + (bracket ? 60 : 0)
  const speed = k.speed * (emphasis === 'active' ? 2.4 : 1)
  const duration = Math.max(1.2, length / speed)
  const count = data.motion ? PACKETS[emphasis] : 0
  const showLabel = data.hovered || emphasis === 'active'

  return (
    <>
      {emphasis === 'active' && <path d={path} className="edge-glow" stroke={family.line} />}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        className={`edge edge--${emphasis}${data.hop ? ' edge--hop' : ''}`}
        style={{ stroke: data.hop ? 'var(--accent)' : family.line, strokeDasharray: data.hop ? '3 5' : k.dash }}
      />
      <Packets path={path} duration={duration} count={count} color={family.packet} reversed={data.reversed} large={emphasis === 'active'} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label edge-label--${emphasis}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: family.line }}
          >
            <span className="edge-label__kind">
              <KindSwatch kind={data.kind} width={18} />
              {k.label}
            </span>
            {data.label}
            {data.ports?.length ? <span className="edge-label__ports">:{data.ports.join(', :')}</span> : null}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
