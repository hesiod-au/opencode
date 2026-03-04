import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace TestFixEvent {
  export const OrchestratorStarted = BusEvent.define(
    "testfix.orchestrator.started",
    z.object({
      orchestratorSessionId: z.string(),
    }),
  )

  export const OrchestratorStopped = BusEvent.define(
    "testfix.orchestrator.stopped",
    z.object({
      reason: z.enum(["completed", "error", "manual"]),
      reportSessionId: z.string().optional(),
    }),
  )

  export const GroupStarted = BusEvent.define(
    "testfix.group.started",
    z.object({
      type: z.string(),
      sessionId: z.string(),
    }),
  )

  export const GroupCompleted = BusEvent.define(
    "testfix.group.completed",
    z.object({
      type: z.string(),
      sessionId: z.string(),
      fileCount: z.number(),
      passingCount: z.number(),
      failingCount: z.number(),
      erroringCount: z.number(),
      invalidCount: z.number(),
    }),
  )

  export const FixAgentStarted = BusEvent.define(
    "testfix.fixagent.started",
    z.object({
      type: z.string(),
      file: z.string(),
      sessionId: z.string(),
    }),
  )

  export const FixAgentCompleted = BusEvent.define(
    "testfix.fixagent.completed",
    z.object({
      type: z.string(),
      file: z.string(),
      sessionId: z.string(),
      status: z.enum(["passing", "failing", "erroring", "invalid"]),
      retries: z.number(),
    }),
  )

  export const RegressionRunStarted = BusEvent.define(
    "testfix.regression.started",
    z.object({
      type: z.string(),
      cycle: z.number(),
    }),
  )

  export const PhaseChanged = BusEvent.define(
    "testfix.phase_changed",
    z.object({
      phase: z.string(),
      detail: z.string().optional(),
    }),
  )
}
