interface PacketsProps {
  /** SVG path the packets travel along. */
  path: string
  /** Seconds for one packet to cross the path. */
  duration: number
  count: number
  color: string
  /** Travel end → start instead. */
  reversed?: boolean
  large?: boolean
}

/** Glowing dots moving along a path: a soft halo and a bright core per packet. */
export function Packets({ path, duration, count, color, reversed = false, large = false }: PacketsProps) {
  const keyPoints = reversed ? '1;0' : '0;1'
  return Array.from({ length: count }, (_, i) => {
    const begin = `${(-i * duration) / count}s`
    const motion = (
      <animateMotion dur={`${duration}s`} begin={begin} repeatCount="indefinite" path={path} keyPoints={keyPoints} keyTimes="0;1" calcMode="linear" />
    )
    return (
      <g key={`${i}-${large}`} className="packet">
        <circle r={large ? 7 : 5} fill={color} opacity="0.16">
          {motion}
        </circle>
        <circle r={large ? 2.6 : 1.9} fill={color}>
          {motion}
        </circle>
      </g>
    )
  })
}
