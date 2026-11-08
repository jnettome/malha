import { useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { usePrefersReducedMotion, useUi } from '../ui/state.tsx'
import { FlowEdge } from './FlowEdge.tsx'
import { buildGraph, layoutFor } from './graph.ts'
import { InfraCard, RegionFrame, ZoneFrame } from './nodes.tsx'
import { Rail } from './Rail.tsx'

const nodeTypes = { infra: InfraCard, zone: ZoneFrame, region: RegionFrame }
const edgeTypes = { flow: FlowEdge }

function Canvas() {
  const ui = useUi()
  const reduced = usePrefersReducedMotion()
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const { fitView } = useReactFlow()

  const { visible, layout } = useMemo(() => layoutFor(ui.showRetired), [ui.showRetired])
  const flowId = ui.flow?.id
  const flowStep = ui.flow?.step ?? 0
  const { rfNodes, rfEdges, involved } = useMemo(
    () =>
      buildGraph({
        layout,
        visible,
        hidden: ui.hidden,
        selection: ui.selection,
        flow: flowId ? { id: flowId, step: flowStep } : null,
        hoveredEdge,
        motion: !reduced,
      }),
    [layout, visible, ui.hidden, ui.selection, flowId, flowStep, hoveredEdge, reduced],
  )

  // Frame the whole flow when it starts, not on every step.
  const [framed, setFramed] = useState<string | undefined>()
  useEffect(() => {
    if (flowId === framed) return
    setFramed(flowId)
    if (flowId && involved.length) fitView({ nodes: involved.map((id) => ({ id })), duration: 700, padding: 0.18 })
  }, [flowId, framed, involved, fitView])

  useEffect(() => {
    if (!ui.focusRequest) return
    fitView({ nodes: ui.focusRequest.ids.map((id) => ({ id })), duration: 700, padding: 0.35, maxZoom: 1.1 })
  }, [ui.focusRequest, fitView])

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.06 }}
      minZoom={0.15}
      maxZoom={2.2}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      onlyRenderVisibleElements={false}
      onNodeClick={(_, n) => {
        if (n.type !== 'infra') return
        ui.stopFlow()
        ui.select(ui.selection?.id === n.id ? null : { type: 'node', id: n.id })
      }}
      onPaneClick={() => ui.select(null)}
      onEdgeMouseEnter={(_, e) => setHoveredEdge(e.id)}
      onEdgeMouseLeave={() => setHoveredEdge(null)}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid-dot)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  )
}

export function TopologyView() {
  // On narrow screens the rail is a drawer over the canvas.
  const [railOpen, setRailOpen] = useState(false)
  return (
    <div className={`topology${railOpen ? ' rail-open' : ''}`}>
      <Rail />
      <button className="rail-toggle btn" onClick={() => setRailOpen((o) => !o)} aria-expanded={railOpen}>
        {railOpen ? 'Close' : 'Flows & layers'}
      </button>
      {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}
      <div className="topology__canvas">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </div>
    </div>
  )
}
