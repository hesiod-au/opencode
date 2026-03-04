import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { WorkflowEvent } from "./events"
import { WorkflowStore } from "./store"
import type { Workflow } from "./workflow"

export namespace WorkflowState {
  const log = Log.create({ service: "workflow-state" })

  interface RunEntry {
    runId: string
    workflowId: string
    startedAt: number
    completedAt?: number
    status: Workflow.Status
  }

  const state = Instance.state(
    () => ({
      runs: new Map<string, RunEntry>(),
      activeByType: new Map<string, string>(),
    }),
    async (data) => {
      log.info("cleaning up workflow state", { runCount: data.runs.size })
      data.runs.clear()
      data.activeByType.clear()
    },
  )

  export function startRun(workflowId: string, parentSessionId?: string): string {
    const runId = Identifier.ascending("workflow")
    const startedAt = Date.now()
    const entry: RunEntry = {
      runId,
      workflowId,
      startedAt,
      status: {
        running: true,
        startedAt,
        parentSessionId,
      },
    }

    state().runs.set(runId, entry)
    state().activeByType.set(workflowId, runId)

    WorkflowStore.createRun({
      runId,
      workflowId,
      parentSessionId,
      startedAt,
      running: true,
      status: entry.status,
    }).catch((err) => {
      log.error("failed to persist workflow run", { error: err, runId, workflowId })
    })

    log.info("workflow run started", { workflowId, runId })
    return runId
  }

  export function updateStatus(runId: string, partial: Partial<Workflow.Status>): void {
    const entry = state().runs.get(runId)
    if (!entry) {
      log.warn("updateStatus called for unknown runId", { runId })
      return
    }

    entry.status = { ...entry.status, ...partial }

    WorkflowStore.updateRun(runId, {
      status: entry.status,
      running: entry.status.running,
      startedAt: entry.status.startedAt,
      completedAt: entry.status.completedAt,
      parentSessionId: entry.status.parentSessionId,
    }).catch((err) => {
      log.error("failed to persist workflow status", { error: err, runId })
    })

    Bus.publish(WorkflowEvent.StatusChanged, {
      workflowId: entry.workflowId,
      runId,
      status: {
        running: entry.status.running,
        phase: entry.status.phase,
        phaseDetail: entry.status.phaseDetail,
        parentSessionId: entry.status.parentSessionId,
        startedAt: entry.status.startedAt,
        completedAt: entry.status.completedAt,
        progress: entry.status.progress,
      },
    })
  }

  export function endRun(runId: string, reason: Workflow.StopReason): void {
    const entry = state().runs.get(runId)
    if (!entry) {
      log.warn("endRun called for unknown runId", { runId })
      return
    }

    entry.completedAt = Date.now()
    entry.status.running = false
    entry.status.completedAt = entry.completedAt

    WorkflowStore.endRun(runId).catch((err) => {
      log.error("failed to persist workflow run end", { error: err, runId })
    })

    const current = state().activeByType.get(entry.workflowId)
    if (current === runId) {
      state().activeByType.delete(entry.workflowId)
    }

    log.info("workflow run ended", { workflowId: entry.workflowId, runId, reason })
  }

  export function getRunStatus(runId: string): Workflow.Status | undefined {
    return state().runs.get(runId)?.status
  }

  export function getActiveRun(workflowId: string): RunEntry | undefined {
    const runId = state().activeByType.get(workflowId)
    if (!runId) return undefined
    return state().runs.get(runId)
  }

  export function listRuns(): RunEntry[] {
    return Array.from(state().runs.values())
  }

  export function listActive(): RunEntry[] {
    return Array.from(state().activeByType.values())
      .map((runId) => state().runs.get(runId))
      .filter((entry): entry is RunEntry => entry !== undefined)
  }
}
