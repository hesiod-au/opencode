import { createSignal, createEffect, onCleanup, Show, For, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"

interface TaskModeStatus {
  enabled: boolean
  tddMode: boolean
  exists: boolean
  path: string
  folderName: string
  orchestratorRunning: boolean
  activeTasks: number
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

interface TaskFolder {
  name: string
  hasTaskList: boolean
  taskCount?: number
}

interface FoldersResponse {
  folders: TaskFolder[]
  currentFolder: string
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
  const params = useParams()
  const sdk = useSDK()

  const [status, setStatus] = createSignal<TaskModeStatus | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [folders, setFolders] = createSignal<TaskFolder[]>([])
  const [selectedFolder, setSelectedFolder] = createSignal("default")
  const [customFolder, setCustomFolder] = createSignal("")
  const [showFolderInput, setShowFolderInput] = createSignal(false)
  const [taskDetails, setTaskDetails] = createSignal<Record<string, TaskFileData>>({})
  const [expandedTasks, setExpandedTasks] = createSignal<Set<string>>(new Set())
  const [completionStats, setCompletionStats] = createSignal<CompletionStats | null>(null)
  const [diff, setDiff] = createSignal<string>("")
  const [showDiff, setShowDiff] = createSignal(false)
  const [archiving, setArchiving] = createSignal(false)
  const [creatingPR, setCreatingPR] = createSignal(false)
  const [tddMode, setTddMode] = createSignal(false)

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

  const fetchFolders = async () => {
    try {
      const response = await fetch(`${sdk.url}/taskmode/folders?directory=${encodeURIComponent(sdk.directory)}`)
      if (response.ok) {
        const data: FoldersResponse = await response.json()
        setFolders(data.folders)
        setSelectedFolder(data.currentFolder)
      }
    } catch {
      // Ignore errors, just use default
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
    fetchFolders()
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

  // Sync local tddMode with server status
  createEffect(() => {
    const serverTddMode = status()?.tddMode
    if (serverTddMode !== undefined) {
      setTddMode(serverTddMode)
    }
  })

  // Check if all tasks are completed
  const isAllDone = createMemo(() => {
    const counts = status()?.counts
    if (!counts || counts.total === 0) return false
    return counts.completed + counts.error === counts.total
  })

  const handleEnable = async (folderName?: string) => {
    try {
      const folder = folderName || (showFolderInput() ? customFolder() : selectedFolder())
      const response = await fetch(`${sdk.url}/taskmode/enable?directory=${encodeURIComponent(sdk.directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startOrchestrator: false, // Don't auto-start, will start on first message
          folderName: folder,
          tddMode: tddMode(),
        }),
      })
      if (!response.ok) {
        throw new Error("Failed to enable task mode")
      }
      await fetchStatus()
      await fetchFolders()
      setShowFolderInput(false)
      setCustomFolder("")
      showToast({ title: "Task mode enabled", description: `Using folder: ${folder}`, variant: "success" })
    } catch (err: any) {
      showToast({ title: "Failed to enable task mode", description: err.message, variant: "error" })
    }
  }

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

        {/* Task Mode Not Enabled */}
        <Show when={!loading() && !error() && !status()?.enabled}>
          <div class="flex flex-col items-center justify-center py-8 gap-6">
            <div class="flex flex-col items-center gap-2">
              <Icon name="checklist" size="large" class="text-text-weak" />
              <div class="text-text-weak text-center">
                Task mode is not enabled.
                <br />
                Enable it to orchestrate multiple tasks in parallel.
              </div>
            </div>

            {/* Folder Selection */}
            <div class="flex flex-col gap-3 w-full max-w-sm">
              <div class="text-12-medium text-text-base">Task Folder</div>

              {/* Existing folders */}
              <Show when={folders().length > 0}>
                <div class="flex flex-col gap-1">
                  <For each={folders()}>
                    {(folder) => (
                      <button
                        class={`flex items-center justify-between px-3 py-2 rounded-md border text-left text-12-regular transition-colors ${
                          selectedFolder() === folder.name && !showFolderInput()
                            ? "border-border-strong bg-surface-base text-text-strong"
                            : "border-border-base hover:border-border-strong text-text-base"
                        }`}
                        onClick={() => {
                          setSelectedFolder(folder.name)
                          setShowFolderInput(false)
                        }}
                      >
                        <div class="flex items-center gap-2">
                          <Icon name="folder" size="small" class="text-text-weak" />
                          <span>{folder.name}</span>
                        </div>
                        <Show when={folder.hasTaskList}>
                          <span class="text-11-regular text-text-weak">
                            {folder.taskCount !== undefined ? `${folder.taskCount} tasks` : "has tasks"}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              {/* Create new folder option */}
              <button
                class={`flex items-center gap-2 px-3 py-2 rounded-md border text-left text-12-regular transition-colors ${
                  showFolderInput()
                    ? "border-border-strong bg-surface-base text-text-strong"
                    : "border-border-base border-dashed hover:border-border-strong text-text-weak"
                }`}
                onClick={() => setShowFolderInput(true)}
              >
                <Icon name="plus" size="small" />
                <span>Create new folder</span>
              </button>

              {/* Custom folder input */}
              <Show when={showFolderInput()}>
                <div class="flex flex-col gap-2">
                  <input
                    type="text"
                    placeholder="folder-name"
                    value={customFolder()}
                    onInput={(e) => setCustomFolder(e.currentTarget.value.replace(/[^a-zA-Z0-9-_]/g, ""))}
                    class="px-3 py-2 rounded-md border border-border-base bg-surface-inset text-text-base text-12-regular placeholder:text-text-weak focus:outline-none focus:border-border-strong"
                  />
                  <div class="text-11-regular text-text-weaker">
                    Path: .opencode/tasks/{customFolder() || "folder-name"}/task_list.md
                  </div>
                </div>
              </Show>
            </div>

            <button
              class="px-4 py-2 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => handleEnable()}
              disabled={showFolderInput() && !customFolder()}
            >
              Enable Task Mode
            </button>
          </div>
        </Show>

        {/* Task Mode Enabled */}
        <Show when={!loading() && !error() && status()?.enabled}>
          {/* Header with controls */}
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <h2 class="text-14-medium text-text-strong">Task Mode</h2>
              <Show when={status()?.orchestratorRunning}>
                <span class="px-2 py-0.5 rounded-full bg-syntax-success/20 text-syntax-success text-11-medium">
                  Running
                </span>
              </Show>
              <Show when={!status()?.orchestratorRunning}>
                <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium">
                  Enabled
                </span>
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

              {/* TDD Mode option - only shown before work starts */}
              <div class="flex flex-col gap-2 pt-3 border-t border-border-base w-full max-w-xs px-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tddMode()}
                    onChange={async (e) => {
                      const newValue = e.currentTarget.checked
                      setTddMode(newValue)
                      // Update config immediately
                      await fetch(`${sdk.url}/taskmode/enable?directory=${encodeURIComponent(sdk.directory)}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          startOrchestrator: false,
                          tddMode: newValue,
                        }),
                      })
                      await fetchStatus()
                    }}
                    class="w-4 h-4 rounded border-border-base bg-surface-inset focus:ring-2 focus:ring-syntax-info"
                  />
                  <span class="text-12-regular text-text-base">Enable TDD Mode</span>
                </label>
                <div class="text-11-regular text-text-weaker text-center">
                  Write tests after planning, run tests before completing tasks
                </div>
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
                          <span class="flex-1 text-text-base text-12-regular truncate">{task.title}</span>
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
                            <Show when={details()} fallback={<div class="text-text-weak text-12-regular">Loading...</div>}>
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
                      {((completionStats()?.inputTokens ?? 0) + (completionStats()?.outputTokens ?? 0)).toLocaleString()}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-11-medium text-text-weak">Input / Output</span>
                    <span class="text-12-regular text-text-base">
                      {(completionStats()?.inputTokens ?? 0).toLocaleString()} / {(completionStats()?.outputTokens ?? 0).toLocaleString()}
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
                        <pre class="p-3 text-11-regular font-mono whitespace-pre overflow-x-auto">{diff() || "No changes detected"}</pre>
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
