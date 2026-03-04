import { Bus } from "../bus"
import { WorkflowEvent } from "../workflow/events"
import { WorkflowState } from "../workflow/state"
import { TestFixEvent } from "./events"
import { TestFixOrchestrator } from "./test-fix"
import type { Workflow } from "../workflow/workflow"

export namespace TestFixWorkflow {
  export const definition: Workflow.Definition<TestFixOrchestrator.Phase> = {
    id: "test-fix",
    name: "Test Fix",
    activationMode: "start",
    recursive: false,

    async start(options) {
      const runId = WorkflowState.startRun("test-fix")

      await TestFixOrchestrator.start({ ...options, runId })

      if (TestFixOrchestrator.isRunning()) {
        Bus.publish(WorkflowEvent.Started, {
          workflowId: "test-fix",
          parentSessionId: options.parentSessionId,
          runId,
        })
      }
    },

    async stop(reason) {
      const activeRun = WorkflowState.getActiveRun("test-fix")

      await TestFixOrchestrator.stop(reason)

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "test-fix",
        reason,
        runId: activeRun?.runId,
      })

      if (activeRun) {
        WorkflowState.endRun(activeRun.runId, reason)
      }
    },

    getStatus() {
      const raw = TestFixOrchestrator.getStatus()
      const activeRun = WorkflowState.getActiveRun("test-fix")

      return {
        running: raw.running,
        phase: raw.phase,
        phaseDetail: raw.phaseDetail,
        parentSessionId: raw.parentSessionId,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        runId: activeRun?.runId,
        stats: raw.stats,
        extra: raw.extra,
      }
    },

    isRunning() {
      return TestFixOrchestrator.isRunning()
    },
  }

  export function initBridge() {
    Bus.subscribe(TestFixEvent.PhaseChanged, (event) => {
      const activeRun = WorkflowState.getActiveRun("test-fix")
      Bus.publish(WorkflowEvent.PhaseChanged, {
        workflowId: "test-fix",
        phase: event.properties.phase,
        detail: event.properties.detail,
        runId: activeRun?.runId,
      })
    })

    Bus.subscribe(TestFixEvent.OrchestratorStopped, (event) => {
      const activeRun = WorkflowState.getActiveRun("test-fix")
      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "test-fix",
        reason: event.properties.reason,
        reportSessionId: event.properties.reportSessionId,
        runId: activeRun?.runId,
      })
    })
  }
}
