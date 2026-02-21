import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace WorkflowEvent {
  export const Started = BusEvent.define(
    "workflow.started",
    z.object({
      workflowId: z.string(),
      parentSessionId: z.string().optional(),
    }),
  )

  export const Stopped = BusEvent.define(
    "workflow.stopped",
    z.object({
      workflowId: z.string(),
      reason: z.enum(["completed", "error", "manual"]),
      reportSessionId: z.string().optional(),
    }),
  )

  export const PhaseChanged = BusEvent.define(
    "workflow.phase_changed",
    z.object({
      workflowId: z.string(),
      phase: z.string(),
      detail: z.string().optional(),
    }),
  )

  export const Progress = BusEvent.define(
    "workflow.progress",
    z.object({
      workflowId: z.string(),
      message: z.string(),
    }),
  )
}
