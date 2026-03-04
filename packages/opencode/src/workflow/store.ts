import z from "zod"
import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"
import type { Workflow } from "./workflow"

export namespace WorkflowStore {
  export const WorkflowRunSource = z.enum(["tool", "cli", "api", "gui", "unknown"])
  export type WorkflowRunSource = z.output<typeof WorkflowRunSource>

  export const WorkflowStatsSnapshot = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cost: z.number(),
    modifiedFiles: z.array(z.string()),
  })

  export const WorkflowStatusSnapshot = z.object({
    running: z.boolean().optional(),
    phase: z.string().optional(),
    phaseDetail: z.string().optional(),
    parentSessionId: Identifier.schema("session").optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    runId: Identifier.schema("workflow").optional(),
    progress: z
      .object({
        current: z.number(),
        total: z.number(),
        label: z.string().optional(),
      })
      .optional(),
    stats: WorkflowStatsSnapshot.optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })

  export const WorkflowRun = z.object({
    runId: Identifier.schema("workflow"),
    workflowId: z.string(),
    projectID: z.string(),
    directory: z.string(),
    source: WorkflowRunSource,
    parentSessionId: Identifier.schema("session").optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    running: z.boolean(),
    status: WorkflowStatusSnapshot.optional(),
    stats: WorkflowStatsSnapshot.optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  export type WorkflowRun = z.output<typeof WorkflowRun>

  export const WorkflowSessionLink = z.object({
    sessionId: Identifier.schema("session"),
    runId: Identifier.schema("workflow"),
    workflowId: z.string(),
    role: z.enum(["orchestrator", "child", "fix", "group", "report", "task", "other"]),
    parentSessionId: Identifier.schema("session").optional(),
    createdAt: z.number(),
  })
  export type WorkflowSessionLink = z.output<typeof WorkflowSessionLink>

  type ListRunsInput = {
    workflowId?: string
    directory?: string
    running?: boolean
    limit?: number
  }

  type UpdateRunInput = {
    workflowId?: string
    source?: WorkflowRunSource
    parentSessionId?: string
    startedAt?: number
    completedAt?: number
    running?: boolean
    status?: Partial<Workflow.Status>
    stats?: Workflow.Status["stats"]
    extra?: Record<string, unknown>
  }

  type LinkInput = {
    sessionId: string
    runId: string
    workflowId: string
    role: WorkflowSessionLink["role"]
    parentSessionId?: string
    createdAt?: number
  }

  const keep = <T>(value: T | undefined): value is T => value !== undefined

  export async function createRun(input: {
    runId: string
    workflowId: string
    source?: WorkflowRunSource
    parentSessionId?: string
    startedAt?: number
    completedAt?: number
    running?: boolean
    status?: Partial<Workflow.Status>
    stats?: Workflow.Status["stats"]
    extra?: Record<string, unknown>
  }) {
    const now = input.startedAt ?? Date.now()
    const running = input.running ?? input.status?.running ?? true
    const status = {
      ...(input.status ?? {}),
      running,
      parentSessionId: input.parentSessionId ?? input.status?.parentSessionId,
      startedAt: input.startedAt ?? input.status?.startedAt ?? now,
      completedAt: input.completedAt ?? input.status?.completedAt,
    }
    const run: WorkflowRun = {
      runId: input.runId,
      workflowId: input.workflowId,
      projectID: Instance.project.id,
      directory: Instance.directory,
      source: input.source ?? "unknown",
      parentSessionId: input.parentSessionId,
      startedAt: now,
      completedAt: input.completedAt,
      running,
      status,
      stats: input.stats,
      extra: input.extra,
    }
    await Storage.write(["workflow_run", Instance.project.id, input.runId], run)
    return run
  }

  export async function updateRun(runId: string, input: UpdateRunInput) {
    return Storage.update<WorkflowRun>(["workflow_run", Instance.project.id, runId], (draft) => {
      const patch = (update: Partial<Workflow.Status>) => {
        draft.status = {
          ...(draft.status ?? {}),
          ...update,
        }
      }
      if (input.workflowId) draft.workflowId = input.workflowId
      if (input.source) draft.source = input.source
      if ("parentSessionId" in input) {
        draft.parentSessionId = input.parentSessionId
        patch({ parentSessionId: input.parentSessionId })
      }
      if (input.startedAt !== undefined) {
        draft.startedAt = input.startedAt
        patch({ startedAt: input.startedAt })
      }
      if ("completedAt" in input) {
        draft.completedAt = input.completedAt
        patch({ completedAt: input.completedAt })
      }
      if (input.running !== undefined) {
        draft.running = input.running
        patch({ running: input.running })
      }
      if (input.status) patch(input.status)
      if ("stats" in input) draft.stats = input.stats
      if ("extra" in input) draft.extra = input.extra
    })
  }

  export async function endRun(runId: string) {
    const now = Date.now()
    return Storage.update<WorkflowRun>(["workflow_run", Instance.project.id, runId], (draft) => {
      draft.running = false
      draft.completedAt = now
      draft.status = {
        ...(draft.status ?? {}),
        running: false,
        completedAt: now,
      }
    })
  }

  export async function linkSession(input: LinkInput) {
    const link: WorkflowSessionLink = {
      sessionId: input.sessionId,
      runId: input.runId,
      workflowId: input.workflowId,
      role: input.role,
      parentSessionId: input.parentSessionId,
      createdAt: input.createdAt ?? Date.now(),
    }
    await Storage.write(["workflow_session", Instance.project.id, input.runId, input.sessionId], link)
    return link
  }

  export async function unlinkSession(sessionId: string) {
    const keys = await Storage.list(["workflow_session", Instance.project.id])
    const items = await Promise.all(
      keys.map((key) =>
        Storage.read<WorkflowSessionLink>(key)
          .then((link) => ({ key, link }))
          .catch(() => undefined),
      ),
    )
    const list = items.filter(keep).filter((item) => item.link.sessionId === sessionId)
    await Promise.all(list.map((item) => Storage.remove(item.key)))
  }

  export async function getRun(runId: string) {
    return Storage.read<WorkflowRun>(["workflow_run", Instance.project.id, runId])
  }

  export async function listRuns(input?: ListRunsInput) {
    const dir = input?.directory ?? Instance.directory
    const keys = await Storage.list(["workflow_run", Instance.project.id])
    const items = await Promise.all(keys.map((key) => Storage.read<WorkflowRun>(key).catch(() => undefined)))
    const list = items.filter(keep).filter((run) => {
      if (input?.workflowId && run.workflowId !== input.workflowId) return false
      if (dir && run.directory !== dir) return false
      if (input?.running !== undefined && run.running !== input.running) return false
      return true
    })
    list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    if (input?.limit) return list.slice(0, input.limit)
    return list
  }

  export async function listSessionsByRun(runId: string, input?: { limit?: number }) {
    const keys = await Storage.list(["workflow_session", Instance.project.id])
    const items = await Promise.all(keys.map((key) => Storage.read<WorkflowSessionLink>(key).catch(() => undefined)))
    const list = items.filter(keep).filter((link) => link.runId === runId)
    list.sort((a, b) => a.createdAt - b.createdAt)
    if (input?.limit) return list.slice(0, input.limit)
    return list
  }

  export async function getRunBySession(sessionId: string) {
    const keys = await Storage.list(["workflow_session", Instance.project.id])
    const items = await Promise.all(keys.map((key) => Storage.read<WorkflowSessionLink>(key).catch(() => undefined)))
    const link = items
      .filter(keep)
      .filter((item) => item.sessionId === sessionId)
      .reduce<WorkflowSessionLink | undefined>(
        (latest, item) => (latest && latest.createdAt > item.createdAt ? latest : item),
        undefined,
      )
    if (!link) {
      throw new Storage.NotFoundError({ message: `Workflow session link not found: ${sessionId}` })
    }
    return Storage.read<WorkflowRun>(["workflow_run", Instance.project.id, link.runId])
  }
}
