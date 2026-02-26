import { Bus } from "../bus"
import { WorkflowEvent } from "../workflow/events"
import { WorkflowState } from "../workflow/state"
import { TaskModeEvent } from "./events"
import { Orchestrator } from "./orchestrator"
import z from "zod"
import type { Workflow } from "../workflow/workflow"

export namespace TaskWorkflow {
  export const definition: Workflow.Definition<Orchestrator.OrchestratorPhase> = {
    id: "task",
    name: "Task Mode",
    activationMode: "enable",
    recursive: false,
    toolInvocable: {
      description: "Run the task mode workflow for coordinated review or planning work.",
      parameters: z.object({
        userPrompt: z.string().optional().describe("Instructions for the task-mode workflow session."),
      }),
    },

    async start(options) {
      const runId = WorkflowState.startRun("task")

      await Orchestrator.start({ ...options, runId })

      if (Orchestrator.isRunning()) {
        Bus.publish(WorkflowEvent.Started, {
          workflowId: "task",
          parentSessionId: options.parentSessionId,
          runId,
        })
      }
    },

    async stop(reason) {
      const activeRun = WorkflowState.getActiveRun("task")

      await Orchestrator.stop(reason)

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "task",
        reason,
        runId: activeRun?.runId,
      })

      if (activeRun) {
        WorkflowState.endRun(activeRun.runId, reason)
      }
    },

    getStatus() {
      const raw = Orchestrator.getStatus()
      const activeRun = WorkflowState.getActiveRun("task")

      return {
        running: raw.running,
        phase: raw.phase,
        phaseDetail: raw.phaseDetail,
        parentSessionId: raw.parentSessionId,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        runId: activeRun?.runId,
        progress: activeRun?.status.progress,
        stats: raw.stats,
      }
    },

    isRunning() {
      return Orchestrator.isRunning()
    },

    async confirmPlan() {
      await Orchestrator.confirmPlan()
    },
  }

  // Bridge: publish generic workflow events alongside task-mode events
  export function initBridge() {
    Bus.subscribe(TaskModeEvent.OrchestratorPhaseChanged, (event) => {
      const activeRun = WorkflowState.getActiveRun("task")
      Bus.publish(WorkflowEvent.PhaseChanged, {
        workflowId: "task",
        phase: event.properties.phase,
        detail: event.properties.detail,
        runId: activeRun?.runId,
      })
    })

    Bus.subscribe(TaskModeEvent.OrchestratorStopped, (event) => {
      const activeRun = WorkflowState.getActiveRun("task")
      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "task",
        reason: event.properties.reason,
        reportSessionId: event.properties.reportSessionId,
        runId: activeRun?.runId,
      })
    })
  }
}
