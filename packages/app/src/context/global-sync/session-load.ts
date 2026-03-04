import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { RootLoadArgs, State } from "./types"
import { trimSessions } from "./session-trim"
import type { WorkflowRun, WorkflowSessionLink } from "@opencode-ai/sdk/v2/client"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch {
    input.onFallback()
    const result = await input.list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}

export async function loadWorkflowSessions(input: {
  directory: string
  sdk: ReturnType<typeof createOpencodeClient>
  store: Store<State>
  setStore: SetStoreFunction<State>
  runs?: WorkflowRun[]
}) {
  const runs =
    input.runs ??
    (await input.sdk.workflow.run
      .list({ directory: input.directory })
      .then((x) => x.data ?? [])
      .catch((err) => {
        console.error("Failed to load workflow runs", err)
        return []
      }))
  if (runs.length === 0) return []
  const links = await Promise.allSettled(
    runs.map((run) =>
      input.sdk.workflow.run.sessions({ runId: run.runId, directory: input.directory }).then((x) => x.data ?? []),
    ),
  ).then((results) => results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])))
  if (links.length === 0) return []
  const existing = new Set(input.store.session.map((session) => session.id).filter(Boolean))
  const ids = Array.from(new Set(links.map((link) => link.sessionId).filter(Boolean))).filter((id) => !existing.has(id))
  if (ids.length === 0) return links
  const sessions = await Promise.allSettled(
    ids.map((sessionID) => input.sdk.session.get({ sessionID, directory: input.directory }).then((x) => x.data)),
  ).then((results) =>
    results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : [])),
  )
  if (sessions.length === 0) return links
  const next = trimSessions([...input.store.session, ...sessions], {
    limit: input.store.limit,
    permission: input.store.permission,
  })
  input.setStore("session", reconcile(next, { key: "id" }))
  return links
}

export async function recoverActiveWorkflowRuns(input: {
  directory: string
  sdk: ReturnType<typeof createOpencodeClient>
  store: Store<State>
  setStore: SetStoreFunction<State>
}) {
  const runs = await input.sdk.workflow.run
    .list({ directory: input.directory, running: true })
    .then((x) => x.data ?? [])
    .catch((err) => {
      console.error("Failed to load active workflow runs", err)
      return []
    })
  if (runs.length === 0) return
  const links = await loadWorkflowSessions({
    directory: input.directory,
    sdk: input.sdk,
    store: input.store,
    setStore: input.setStore,
    runs,
  })
  const map = new Map<string, WorkflowSessionLink>()
  for (const link of links) {
    if (!link?.sessionId) continue
    map.set(link.sessionId, link)
  }
  batch(() => {
    for (const run of runs) {
      if (!run?.runId) continue
      input.setStore("workflow_run", run.runId, reconcile(run))
      const status = run.status ?? { running: run.running }
      if (status.runId === undefined) status.runId = run.runId
      if (status.startedAt === undefined) status.startedAt = run.startedAt
      if (status.completedAt === undefined && run.completedAt) status.completedAt = run.completedAt
      if (status.parentSessionId === undefined && run.parentSessionId) status.parentSessionId = run.parentSessionId
      const stale = run.running && (!run.status || run.status.running !== true)
      if (stale) {
        status.running = true
        status.extra = { ...(status.extra ?? {}), stale: true }
      }
      input.setStore("workflow_status", run.workflowId, reconcile(status))
    }
    for (const link of map.values()) {
      input.setStore("workflow_session", link.sessionId, reconcile(link))
    }
  })
}
