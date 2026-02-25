import { Bus } from "../bus"
import { WorkflowEvent } from "../workflow/events"
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
      await Orchestrator.start(options)

      if (Orchestrator.isRunning()) {
        Bus.publish(WorkflowEvent.Started, {
          workflowId: "task",
          parentSessionId: options.parentSessionId,
        })
      }
    },

    async stop(reason) {
      await Orchestrator.stop(reason)

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "task",
        reason,
      })
    },

    getStatus() {
      const raw = Orchestrator.getStatus()
      return {
        running: raw.running,
        phase: raw.phase,
        phaseDetail: raw.phaseDetail,
        parentSessionId: raw.parentSessionId,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
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
      Bus.publish(WorkflowEvent.PhaseChanged, {
        workflowId: "task",
        phase: event.properties.phase,
        detail: event.properties.detail,
      })
    })

    Bus.subscribe(TaskModeEvent.OrchestratorStopped, (event) => {
      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "task",
        reason: event.properties.reason,
        reportSessionId: event.properties.reportSessionId,
      })
    })
  }
}
