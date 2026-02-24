import { createSignal, createEffect, onCleanup, Show, For, createMemo } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { TaskModeCard } from "./session-workflows-panel"

interface TaskModeStatus {
  enabled: boolean
  tddMode: boolean
  exists: boolean
  path: string
  folderName: string
  orchestratorRunning: boolean
  activeTasks: number
  phase?: string
  phaseDetail?: string
  stopReason?: string
  taskList?: {
    title?: string
    description?: string
    tasks: Array<{
      id: string
      title: string
      status: "todo" | "in-progress" | "done" | "error" | "paused"
      assignee?: string
      dependencies?: string[]
      file?: string
    }>
  }
  counts?: {
    total: number
    pending: number
    inProgress: number
    completed: number
    error: number
    paused: number
  }
}

interface TaskFileData {
  id: string
  title: string
  description: string
  status?: string
  dependencies?: string[]
  files?: string[]
  tests?: string[]
  comments?: string
  sessionId?: string
  startedAt?: string
  completedAt?: string
}

interface CompletionStats {
  startedAt?: number
  completedAt?: number
  durationMs?: number
  inputTokens: number
  outputTokens: number
  cost: number
  modifiedFiles: string[]
}

export function SessionTasksTab() {
  const sdk = useSDK()

  const [status, setStatus] = createSignal<TaskModeStatus | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [taskDetails, setTaskDetails] = createSignal<Record<string, TaskFileData>>({})
  const [expandedTasks, setExpandedTasks] = createSignal<Set<string>>(new Set())
  const [completionStats, setCompletionStats] = createSignal<CompletionStats | null>(null)
  const [diff, setDiff] = createSignal<string>("")
  const [showDiff, setShowDiff] = createSignal(false)
  const [archiving, setArchiving] = createSignal(false)
  const [creatingPR, setCreatingPR] = createSignal(false)
  const [editingTaskId, setEditingTaskId] = createSignal<string | null>(null)
  const [editingTitle, setEditingTitle] = createSignal("")
  const [retryingErrors, setRetryingErrors] = createSignal(false)

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/status?directory=${encodeURIComponent(sdk.directory)}`)
      if (!response.ok) {
        throw new Error(`Failed to fetch task mode status: ${response.statusText}`)
      }
      const data = await response.json()
      setStatus(data)
      setError(null)
    } catch (err: any) {
      setError(err.message || "Failed to load task mode status")
    } finally {
      setLoading(false)
    }
  }

  const fetchTaskDetails = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/tasks/details?directory=${encodeURIComponent(sdk.directory)}`)
      if (response.ok) {
        const data = await response.json()
        setTaskDetails(data.tasks || {})
      }
    } catch {
      // Ignore errors
    }
  }

  const fetchCompletionStats = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/stats?directory=${encodeURIComponent(sdk.directory)}`)
      if (response.ok) {
        const data = await response.json()
        if (data.exists && data.stats) {
          setCompletionStats(data.stats)
        }
      }
    } catch {
      // Ignore errors
    }
  }

  const fetchDiff = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/diff?directory=${encodeURIComponent(sdk.directory)}`)
      if (response.ok) {
        const data = await response.json()
        setDiff(data.diff || "")
      }
    } catch {
      // Ignore errors
    }
  }

  const toggleTaskExpanded = (taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  // Initial fetch and polling
  createEffect(() => {
    fetchStatus()
    fetchTaskDetails()
    fetchCompletionStats()

    const interval = setInterval(() => {
      fetchStatus()
      fetchTaskDetails()
      fetchCompletionStats()
    }, 2000) // Poll every 2 seconds

    onCleanup(() => {
      clearInterval(interval)
    })
  })

  // Check if all tasks are completed
  const isAllDone = createMemo(() => {
    const counts = status()?.counts
    if (!counts || counts.total === 0) return false
    return counts.completed + counts.error === counts.total
  })

  const handleDisable = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/disable?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
      })
      if (!response.ok) {
        throw new Error("Failed to disable task mode")
      }
      await fetchStatus()
      showToast({ title: "Task mode disabled", variant: "success" })
    } catch (err: any) {
      showToast({ title: "Failed to disable task mode", description: err.message, variant: "error" })
    }
  }

  const handleArchive = async () => {
    setArchiving(true)
    try {
      const response = await fetch(`${sdk.url}/taskmode/archive?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
      })
      if (!response.ok) {
        throw new Error("Failed to archive task folder")
      }
      const data = await response.json()
      await fetchStatus()
      setCompletionStats(null)
      setDiff("")
      showToast({
        title: "Task folder archived",
        description: `Moved to ${data.archivePath}`,
        variant: "success",
      })
    } catch (err: any) {
      showToast({ title: "Failed to archive", description: err.message, variant: "error" })
    } finally {
      setArchiving(false)
    }
  }

  const handleCreatePR = async () => {
    setCreatingPR(true)
    try {
      const title = status()?.taskList?.title || "Task mode changes"
      const stats = completionStats()
      const body = [
        `## Summary`,
        ``,
        status()?.taskList?.description || "Changes made by task mode orchestrator.",
        ``,
        `## Stats`,
        `- Duration: ${formatDuration(stats?.durationMs)}`,
        `- Tokens: ${((stats?.inputTokens ?? 0) + (stats?.outputTokens ?? 0)).toLocaleString()}`,
        `- Files modified: ${stats?.modifiedFiles?.length ?? 0}`,
        ``,
        `## Modified Files`,
        ...(stats?.modifiedFiles?.map((f) => `- \`${f}\``) ?? []),
      ].join("\n")

      const response = await fetch(`${sdk.url}/taskmode/create-pr?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      })

      const data = await response.json()
      if (!data.success) {
        throw new Error(data.error || "Failed to create PR")
      }

      showToast({
        title: "Pull request created",
        description: data.prUrl,
        variant: "success",
      })
    } catch (err: any) {
      showToast({ title: "Failed to create PR", description: err.message, variant: "error" })
    } finally {
      setCreatingPR(false)
    }
  }

  const updateTask = async (taskId: string, updates: { title?: string; status?: string }) => {
    try {
      const response = await fetch(
        `${sdk.url}/taskmode/task/${taskId}?directory=${encodeURIComponent(sdk.directory)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      )
      if (!response.ok) throw new Error("Failed to update task")
      await fetchStatus()
      await fetchTaskDetails()
    } catch (err: any) {
      showToast({ title: "Failed to update task", description: err.message, variant: "error" })
    }
  }

  const startEditingTitle = (taskId: string, currentTitle: string) => {
    setEditingTaskId(taskId)
    setEditingTitle(currentTitle)
  }

  const saveTitle = async (taskId: string) => {
    const newTitle = editingTitle().trim()
    setEditingTaskId(null)
    if (!newTitle) return
    await updateTask(taskId, { title: newTitle })
  }

  const cancelEditing = () => {
    setEditingTaskId(null)
    setEditingTitle("")
  }

  const hasErroredTasks = createMemo(() => !status()?.orchestratorRunning && (status()?.counts?.error ?? 0) > 0)

  const erroredTaskIds = createMemo(() => {
    if (!hasErroredTasks()) return []
    return status()?.taskList?.tasks.filter((t) => t.status === "error").map((t) => t.id) ?? []
  })

  const handleRetryErrored = async () => {
    setRetryingErrors(true)
    try {
      for (const id of erroredTaskIds()) {
        await updateTask(id, { status: "todo" })
      }
      const response = await fetch(`${sdk.url}/taskmode/start?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!response.ok) throw new Error("Failed to start orchestrator")
      await fetchStatus()
      showToast({ title: "Retrying errored tasks", variant: "success" })
    } catch (err: any) {
      showToast({ title: "Failed to retry", description: err.message, variant: "error" })
    } finally {
      setRetryingErrors(false)
    }
  }

  const handleMarkAllDone = async () => {
    try {
      for (const id of erroredTaskIds()) {
        await updateTask(id, { status: "done" })
      }
      showToast({ title: "All errored tasks marked done", variant: "success" })
    } catch (err: any) {
      showToast({ title: "Failed to mark tasks done", description: err.message, variant: "error" })
    }
  }

  const handleRestartOrchestrator = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/start?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!response.ok) throw new Error("Failed to start orchestrator")
      await fetchStatus()
      showToast({ title: "Orchestrator restarted", variant: "success" })
    } catch (err: any) {
      showToast({ title: "Failed to restart", description: err.message, variant: "error" })
    }
  }

  const canEdit = () => !status()?.orchestratorRunning

  const formatDuration = (ms?: number) => {
    if (!ms) return "N/A"
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    }
    return `${seconds}s`
  }

  const statusIcon = (taskStatus: string) => {
    switch (taskStatus) {
      case "done":
        return <Icon name="check" size="small" class="text-syntax-success" />
      case "in-progress":
        return <Icon name="settings-gear" size="small" class="text-syntax-info animate-spin" />
      case "error":
        return <Icon name="circle-x" size="small" class="text-syntax-error" />
      case "paused":
        return <Icon name="stop" size="small" class="text-syntax-warning" />
      default:
        return <Icon name="dash" size="small" class="text-text-weak" />
    }
  }

  const progressPercent = createMemo(() => {
    const counts = status()?.counts
    if (!counts || counts.total === 0) return 0
    return Math.round((counts.completed / counts.total) * 100)
  })

  return (
    <div class="@container h-full overflow-y-auto no-scrollbar pb-10">
      <div class="px-6 pt-4 flex flex-col gap-6">
        {/* Task Mode start controls — shown when not enabled */}
        <Show when={!loading() && !status()?.enabled}>
          <TaskModeCard
            status={undefined}
            sdkUrl={sdk.url}
            directory={sdk.directory}
            onStatusChange={fetchStatus}
          />
        </Show>

        {/* Loading State */}
        <Show when={loading()}>
          <div class="flex items-center justify-center py-8 text-text-weak">
            <Icon name="settings-gear" size="small" class="animate-spin" />
            <span class="ml-2">Loading task mode status...</span>
          </div>
        </Show>

        {/* Error State */}
        <Show when={error()}>
          <div class="flex flex-col items-center justify-center py-8 gap-2">
            <Icon name="circle-x" size="large" class="text-syntax-error" />
            <div class="text-text-weak">{error()}</div>
            <button class="text-text-link hover:underline" onClick={fetchStatus}>
              Retry
            </button>
          </div>
        </Show>

        {/* Task Mode Enabled */}
        <Show when={!loading() && !error() && status()?.enabled}>
          {/* Header with controls */}
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <h2 class="text-14-medium text-text-strong">Task Mode</h2>
              <Show
                when={status()?.orchestratorRunning}
                fallback={
                  <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium">
                    Enabled
                  </span>
                }
              >
                {(() => {
                  const phase = status()?.phase
                  switch (phase) {
                    case "planning":
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium flex items-center gap-1">
                          <Icon name="settings-gear" size="small" class="animate-spin" />
                          Planning...
                        </span>
                      )
                    case "test-writing":
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium flex items-center gap-1">
                          <Icon name="settings-gear" size="small" class="animate-spin" />
                          Writing Tests...
                        </span>
                      )
                    case "waiting-confirmation":
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-warning/20 text-syntax-warning text-11-medium">
                          Awaiting Confirmation
                        </span>
                      )
                    case "e2e-testing":
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium flex items-center gap-1">
                          <Icon name="settings-gear" size="small" class="animate-spin" />
                          E2E Testing...
                        </span>
                      )
                    case "completing":
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-success/20 text-syntax-success text-11-medium flex items-center gap-1">
                          <Icon name="settings-gear" size="small" class="animate-spin" />
                          Completing...
                        </span>
                      )
                    case "executing":
                    default:
                      return (
                        <span class="px-2 py-0.5 rounded-full bg-syntax-success/20 text-syntax-success text-11-medium">
                          Running{status()?.activeTasks ? ` (${status()!.activeTasks})` : ""}
                        </span>
                      )
                  }
                })()}
              </Show>
              <Show when={status()?.tddMode}>
                <span class="px-2 py-0.5 rounded-full bg-syntax-warning/20 text-syntax-warning text-11-medium">
                  TDD
                </span>
              </Show>
            </div>
            <button
              class="px-3 py-1 rounded-md bg-surface-base text-text-base hover:bg-surface-raised-base-hover text-12-medium"
              onClick={handleDisable}
            >
              Disable
            </button>
          </div>

          {/* No task list yet */}
          <Show when={!status()?.exists}>
            <div class="flex flex-col items-center justify-center py-8 gap-4 border border-border-base rounded-md bg-surface-base">
              <Icon name="folder" size="large" class="text-text-weak" />
              <div class="text-text-weak text-center">
                No task list yet.
                <br />
                Send a message to start the planning agent.
              </div>
            </div>
          </Show>

          {/* Task list exists */}
          <Show when={status()?.exists && status()?.taskList}>
            {/* Progress bar */}
            <Show when={status()?.counts}>
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between text-12-regular">
                  <span class="text-text-weak">Progress</span>
                  <span class="text-text-strong">{progressPercent()}%</span>
                </div>
                <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden">
                  <div
                    class="h-full bg-syntax-success transition-all duration-300"
                    style={{ width: `${progressPercent()}%` }}
                  />
                </div>
                <div class="flex items-center gap-4 text-11-regular text-text-weak">
                  <span>{status()?.counts?.completed ?? 0} completed</span>
                  <span>{status()?.counts?.inProgress ?? 0} in progress</span>
                  <span>{status()?.counts?.pending ?? 0} pending</span>
                  <Show when={(status()?.counts?.error ?? 0) > 0}>
                    <span class="text-syntax-error">{status()?.counts?.error} errors</span>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Task list title and description */}
            <Show when={status()?.taskList?.title || status()?.taskList?.description}>
              <div class="flex flex-col gap-2">
                <Show when={status()?.taskList?.title}>
                  <h3 class="text-14-medium text-text-strong">{status()?.taskList?.title}</h3>
                </Show>
                <Show when={status()?.taskList?.description}>
                  <p class="text-12-regular text-text-weak">{status()?.taskList?.description}</p>
                </Show>
              </div>
            </Show>

            {/* Task list with expandable details */}
            <div class="flex flex-col gap-1">
              <div class="text-12-regular text-text-weak mb-2">Tasks</div>
              <div class="flex flex-col gap-2">
                <For each={status()?.taskList?.tasks}>
                  {(task) => {
                    const details = () => taskDetails()[task.id]
                    const isExpanded = () => expandedTasks().has(task.id)

                    return (
                      <div class="border border-border-base rounded-md overflow-hidden">
                        {/* Task header row - clickable to expand */}
                        <button
                          class="w-full px-3 py-2 flex items-center gap-3 bg-surface-base hover:bg-surface-raised-base-hover transition-colors text-left"
                          onClick={() => toggleTaskExpanded(task.id)}
                        >
                          <Icon
                            name="chevron-right"
                            size="small"
                            class={`text-text-weak transition-transform ${isExpanded() ? "rotate-90" : ""}`}
                          />
                          <span class="font-mono text-text-strong text-12-medium w-10">{task.id}</span>
                          <Show
                            when={canEdit() && editingTaskId() === task.id}
                            fallback={
                              <span
                                class={`flex-1 text-text-base text-12-regular truncate ${canEdit() ? "cursor-text hover:text-text-strong" : ""}`}
                                onClick={(e) => {
                                  if (!canEdit()) return
                                  e.stopPropagation()
                                  startEditingTitle(task.id, task.title)
                                }}
                              >
                                {task.title}
                              </span>
                            }
                          >
                            <input
                              class="flex-1 text-text-base text-12-regular bg-surface-inset border border-border-strong rounded px-1 py-0.5 focus:outline-none"
                              value={editingTitle()}
                              onInput={(e) => setEditingTitle(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveTitle(task.id)
                                if (e.key === "Escape") cancelEditing()
                              }}
                              onBlur={() => saveTitle(task.id)}
                              onClick={(e) => e.stopPropagation()}
                              ref={(el) => setTimeout(() => el.focus(), 0)}
                            />
                          </Show>
                          <div class="flex items-center gap-1.5">
                            {statusIcon(task.status)}
                            <span class="text-text-weak text-11-regular">{task.status}</span>
                          </div>
                          <Show when={task.dependencies && task.dependencies.length > 0}>
                            <span class="text-text-weaker text-11-regular">deps: {task.dependencies?.join(", ")}</span>
                          </Show>
                        </button>

                        {/* Expanded task details */}
                        <Show when={isExpanded()}>
                          <div class="px-4 py-3 border-t border-border-base bg-surface-inset">
                            <Show
                              when={details()}
                              fallback={<div class="text-text-weak text-12-regular">Loading...</div>}
                            >
                              <div class="flex flex-col gap-3">
                                {/* Description */}
                                <Show when={details()?.description}>
                                  <div class="flex flex-col gap-1">
                                    <div class="text-11-medium text-text-weak">Description</div>
                                    <div class="text-12-regular text-text-base whitespace-pre-wrap">
                                      {details()?.description}
                                    </div>
                                  </div>
                                </Show>

                                {/* Session link */}
                                <Show when={details()?.sessionId}>
                                  <div class="flex items-center gap-2">
                                    <span class="text-11-medium text-text-weak">Session:</span>
                                    <a
                                      href={`/session/${details()?.sessionId}`}
                                      class="text-12-regular text-text-link hover:underline font-mono"
                                    >
                                      {details()?.sessionId?.slice(0, 12)}...
                                    </a>
                                  </div>
                                </Show>

                                {/* Timing info */}
                                <Show when={details()?.startedAt || details()?.completedAt}>
                                  <div class="flex items-center gap-4 text-11-regular text-text-weak">
                                    <Show when={details()?.startedAt}>
                                      <span>Started: {new Date(details()!.startedAt!).toLocaleString()}</span>
                                    </Show>
                                    <Show when={details()?.completedAt}>
                                      <span>Completed: {new Date(details()!.completedAt!).toLocaleString()}</span>
                                    </Show>
                                  </div>
                                </Show>

                                {/* Assigned Tests (TDD mode) */}
                                <Show when={details()?.tests && details()!.tests!.length > 0}>
                                  <div class="flex flex-col gap-1">
                                    <div class="text-11-medium text-text-weak">Assigned Tests (TDD)</div>
                                    <div class="flex flex-wrap gap-1">
                                      <For each={details()?.tests}>
                                        {(test) => (
                                          <span class="px-2 py-0.5 rounded-md bg-syntax-info/10 text-syntax-info text-11-regular font-mono">
                                            {test}
                                          </span>
                                        )}
                                      </For>
                                    </div>
                                  </div>
                                </Show>

                                {/* Comments */}
                                <Show when={details()?.comments}>
                                  <div class="flex flex-col gap-1">
                                    <div class="text-11-medium text-text-weak">Completion Comments</div>
                                    <div class="text-12-regular text-text-base whitespace-pre-wrap bg-surface-base p-2 rounded border border-border-base">
                                      {details()?.comments}
                                    </div>
                                  </div>
                                </Show>

                                {/* Status reset buttons (only when orchestrator is stopped) */}
                                <Show when={canEdit() && (task.status === "error" || task.status === "done")}>
                                  <div class="flex items-center gap-2 pt-2 border-t border-border-base">
                                    <button
                                      class="px-3 py-1 rounded-md bg-surface-base text-text-base hover:bg-surface-raised-base-hover text-11-medium border border-border-base"
                                      onClick={() => updateTask(task.id, { status: "todo" })}
                                    >
                                      Reset to Todo
                                    </button>
                                    <Show when={task.status === "error"}>
                                      <button
                                        class="px-3 py-1 rounded-md bg-syntax-success/10 text-syntax-success hover:bg-syntax-success/20 text-11-medium border border-syntax-success/30"
                                        onClick={() => updateTask(task.id, { status: "done" })}
                                      >
                                        Mark Done
                                      </button>
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>

            {/* Active tasks indicator */}
            <Show when={status()?.activeTasks && status()!.activeTasks > 0}>
              <div class="flex items-center gap-2 px-3 py-2 rounded-md bg-syntax-info/10 border border-syntax-info/20">
                <Icon name="settings-gear" size="small" class="text-syntax-info animate-spin" />
                <span class="text-12-regular text-text-base">
                  {status()?.activeTasks} task{status()!.activeTasks > 1 ? "s" : ""} currently running
                </span>
              </div>
            </Show>

            {/* Error Recovery Banner */}
            <Show when={hasErroredTasks()}>
              <div class="flex flex-col gap-3 p-4 rounded-md border border-syntax-error/30 bg-syntax-error/5">
                <div class="flex items-center gap-2">
                  <Icon name="circle-x" size="small" class="text-syntax-error" />
                  <span class="text-14-medium text-text-strong">
                    Task mode stopped with {status()?.counts?.error} errored task
                    {(status()?.counts?.error ?? 0) > 1 ? "s" : ""}
                  </span>
                </div>
                <Show when={status()?.stopReason}>
                  <span class="text-12-regular text-text-weak">Reason: {status()?.stopReason}</span>
                </Show>
                <div class="flex items-center gap-2 pt-2 border-t border-syntax-error/20">
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-syntax-error/10 text-syntax-error hover:bg-syntax-error/20 text-12-medium border border-syntax-error/30 disabled:opacity-50"
                    onClick={handleRetryErrored}
                    disabled={retryingErrors()}
                  >
                    <Show when={retryingErrors()} fallback={<Icon name="play" size="small" />}>
                      <Icon name="settings-gear" size="small" class="animate-spin" />
                    </Show>
                    Retry Errored Tasks
                  </button>
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-syntax-success/10 text-syntax-success hover:bg-syntax-success/20 text-12-medium border border-syntax-success/30"
                    onClick={handleMarkAllDone}
                  >
                    <Icon name="check" size="small" />
                    Mark All Done
                  </button>
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-base text-text-base hover:bg-surface-raised-base-hover text-12-medium border border-border-base"
                    onClick={handleRestartOrchestrator}
                  >
                    <Icon name="play" size="small" />
                    Restart Orchestrator
                  </button>
                </div>
              </div>
            </Show>

            {/* Completion Stats and Actions */}
            <Show when={isAllDone() && completionStats()}>
              <div class="flex flex-col gap-4 p-4 rounded-md border border-syntax-success/30 bg-syntax-success/5">
                <div class="flex items-center gap-2">
                  <Icon name="check" size="small" class="text-syntax-success" />
                  <span class="text-14-medium text-text-strong">All Tasks Completed</span>
                </div>

                {/* Stats Grid */}
                <div class="grid grid-cols-2 @lg:grid-cols-5 gap-4">
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Duration</span>
                    <span class="text-14-medium text-text-strong">{formatDuration(completionStats()?.durationMs)}</span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Total Tokens</span>
                    <span class="text-14-medium text-text-strong">
                      {(
                        (completionStats()?.inputTokens ?? 0) + (completionStats()?.outputTokens ?? 0)
                      ).toLocaleString()}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Input / Output</span>
                    <span class="text-12-regular text-text-base">
                      {(completionStats()?.inputTokens ?? 0).toLocaleString()} /{" "}
                      {(completionStats()?.outputTokens ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Cost</span>
                    <span class="text-14-medium text-text-strong">
                      {(completionStats()?.cost ?? 0) > 0 ? `$${(completionStats()?.cost ?? 0).toFixed(4)}` : "N/A"}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Files Modified</span>
                    <span class="text-14-medium text-text-strong">{completionStats()?.modifiedFiles?.length ?? 0}</span>
                  </div>
                </div>

                {/* Modified Files List */}
                <Show when={completionStats()?.modifiedFiles && completionStats()!.modifiedFiles.length > 0}>
                  <div class="flex flex-col gap-2">
                    <button
                      class="flex items-center gap-1 text-11-medium text-text-link hover:underline w-fit"
                      onClick={async () => {
                        if (!showDiff()) {
                          await fetchDiff()
                        }
                        setShowDiff(!showDiff())
                      }}
                    >
                      <Icon name={showDiff() ? "chevron-down" : "chevron-right"} size="small" />
                      {showDiff() ? "Hide" : "Show"} Diff ({completionStats()?.modifiedFiles?.length} files)
                    </button>
                    <Show when={showDiff()}>
                      <div class="max-h-64 overflow-auto rounded border border-border-base bg-surface-base">
                        <pre class="p-3 text-11-regular font-mono whitespace-pre overflow-x-auto">
                          {diff() || "No changes detected"}
                        </pre>
                      </div>
                    </Show>
                  </div>
                </Show>

                {/* Action Buttons */}
                <div class="flex items-center gap-3 pt-3 border-t border-syntax-success/20">
                  <button
                    class="flex items-center gap-2 px-4 py-2 rounded-md bg-syntax-success/20 text-syntax-success border-2 border-syntax-success hover:bg-syntax-success/30 disabled:opacity-50 disabled:cursor-not-allowed text-13-medium font-medium"
                    onClick={handleCreatePR}
                    disabled={creatingPR() || (completionStats()?.modifiedFiles?.length ?? 0) === 0}
                  >
                    <Show when={creatingPR()}>
                      <Icon name="settings-gear" size="small" class="animate-spin" />
                    </Show>
                    <Show when={!creatingPR()}>
                      <Icon name="branch" size="small" />
                    </Show>
                    Create PR
                  </button>
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 text-12-medium border border-border-base"
                    onClick={handleArchive}
                    disabled={archiving()}
                  >
                    <Show when={archiving()}>
                      <Icon name="settings-gear" size="small" class="animate-spin" />
                    </Show>
                    <Show when={!archiving()}>
                      <Icon name="archive" size="small" />
                    </Show>
                    Archive & Clear
                  </button>
                </div>
              </div>
            </Show>
          </Show>

          {/* Path info */}
          <div class="flex items-center justify-between text-11-regular text-text-weaker">
            <div class="flex items-center gap-2">
              <Icon name="folder" size="small" />
              <span>Folder: {status()?.folderName}</span>
            </div>
            <span class="text-text-weaker truncate max-w-[200px]" title={status()?.path}>
              {status()?.path}
            </span>
          </div>
        </Show>
      </div>
    </div>
  )
}
