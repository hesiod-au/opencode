import { ComponentProps, For } from "solid-js"

const outerIndices = new Set([1, 2, 4, 7, 8, 11, 13, 14])
const cornerIndices = new Set([0, 3, 12, 15])
const squares = Array.from({ length: 16 }, (_, i) => ({
  id: i,
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  delay: Math.random() * 2,
  duration: 1.5 + Math.random() * 1.5,
  outer: outerIndices.has(i),
  corner: cornerIndices.has(i),
}))

export function WaitingSpinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <svg
      class={props.class}
      classList={props.classList}
      style={props.style}
      viewBox="0 0 15 15"
      data-component="waiting-spinner"
      fill="rgb(234, 88, 12)"
    >
      <For each={squares}>
        {(square) => (
          <rect
            x={square.x}
            y={square.y}
            width="3"
            height="3"
            rx="1"
            style={{
              opacity: square.corner ? 0 : undefined,
              animation: square.corner
                ? undefined
                : `${square.outer ? "pulse-waiting-dim" : "pulse-waiting"} ${square.duration}s ease-in-out infinite`,
              "animation-delay": square.corner ? undefined : `${square.delay}s`,
              fill: "currentColor",
            }}
          />
        )}
      </For>
    </svg>
  )
}
