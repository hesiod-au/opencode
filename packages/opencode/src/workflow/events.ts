import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace WorkflowEvent {
  export const Started = BusEvent.define(
    "workflow.started",
    z.object({
      workflowId: z.string(),
      parentSessionId: z.string().optional(),
      runId: z.string().optional(),
    }),
  )

  export const Stopped = BusEvent.define(
    "workflow.stopped",
    z.object({
      workflowId: z.string(),
      reason: z.enum(["completed", "error", "manual"]),
      reportSessionId: z.string().optional(),
      runId: z.string().optional(),
    }),
  )

  export const PhaseChanged = BusEvent.define(
    "workflow.phase_changed",
    z.object({
      workflowId: z.string(),
      phase: z.string(),
      detail: z.string().optional(),
      runId: z.string().optional(),
    }),
  )

  export const Progress = BusEvent.define(
    "workflow.progress",
    z.object({
      workflowId: z.string(),
      message: z.string(),
      runId: z.string().optional(),
      progress: z
        .object({
          current: z.number(),
          total: z.number(),
          label: z.string().optional(),
        })
        .optional(),
    }),
  )

  export const StepStarted = BusEvent.define(
    "workflow.step_started",
    z.object({
      workflowId: z.string(),
      stepId: z.string(),
      stepIndex: z.number(),
    }),
  )

  export const StepCompleted = BusEvent.define(
    "workflow.step_completed",
    z.object({
      workflowId: z.string(),
      stepId: z.string(),
      stepIndex: z.number(),
    }),
  )

  export const StatusChanged = BusEvent.define(
    "workflow.status_changed",
    z.object({
      workflowId: z.string(),
      runId: z.string(),
      status: z.object({
        running: z.boolean(),
        phase: z.string().optional(),
        phaseDetail: z.string().optional(),
        parentSessionId: z.string().optional(),
        startedAt: z.number().optional(),
        completedAt: z.number().optional(),
        progress: z
          .object({
            current: z.number(),
            total: z.number(),
            label: z.string().optional(),
          })
          .optional(),
      }),
    }),
  )
}
