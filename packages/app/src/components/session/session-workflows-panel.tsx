import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"

interface WorkflowInfo {
  id: string
  name: string
  running: boolean
  hasConfirm: boolean
  activationMode: "start" | "enable" | "both"
}

interface WorkflowStatus {
  running: boolean
  phase?: string
  phaseDetail?: string
}

interface TaskFolder {
  name: string
  hasTaskList: boolean
  taskCount?: number
}

function uniqueTaskName(branch: string, existing: string[]) {
  const base = branch
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  if (!existing.includes(base)) return base
  let i = 1
  while (existing.includes(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export function TaskModeCard(props: {
  status: WorkflowStatus | undefined
  sdkUrl: string
  directory: string
  onStatusChange?: () => void
}) {
  const [taskName, setTaskName] = createSignal("")
  const [tddMode, setTddMode] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)

  // Fetch branch + folders on mount to compute a unique default name
  createEffect(async () => {
    try {
      const [branchRes, foldersRes] = await Promise.all([
        fetch(`${props.sdkUrl}/project/branch?directory=${encodeURIComponent(props.directory)}`),
        fetch(`${props.sdkUrl}/taskmode/folders?directory=${encodeURIComponent(props.directory)}`),
      ])
      const branch = branchRes.ok ? ((await branchRes.json()) as { branch: string | null }).branch : null
      const existingNames: string[] = []
      if (foldersRes.ok) {
        const data = (await foldersRes.json()) as { folders: TaskFolder[] }
        data.folders.forEach((f) => existingNames.push(f.name))
      }
      const base = branch ?? "default"
      setTaskName(uniqueTaskName(base, existingNames))
    } catch {
      setTaskName("default")
    }
  })

  const handleStart = async () => {
    setStarting(true)
    try {
      const res = await fetch(`${props.sdkUrl}/taskmode/enable?directory=${encodeURIComponent(props.directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderName: taskName(), tddMode: tddMode(), startOrchestrator: false }),
      })
      if (!res.ok) throw new Error("Failed to start task mode")
      showToast({ title: "Task mode enabled", description: `Folder: ${taskName()}`, variant: "success" })
      props.onStatusChange?.()
    } catch (err: any) {
      showToast({ title: "Failed to start task mode", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(`${props.sdkUrl}/taskmode/disable?directory=${encodeURIComponent(props.directory)}`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Failed to stop task mode")
      showToast({ title: "Task mode disabled", variant: "success" })
      props.onStatusChange?.()
    } catch (err: any) {
      showToast({ title: "Failed to stop task mode", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Icon name="checklist" size="small" class="text-text-weak" />
          <span class="text-13-medium text-text-strong">Task Mode</span>
          <Show when={props.status?.running}>
            <span class="px-2 py-0.5 rounded-full bg-syntax-success/20 text-syntax-success text-11-medium">
              {props.status?.phase ?? "running"}
            </span>
          </Show>
        </div>
      </div>

      <Show
        when={!props.status?.running}
        fallback={
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Icon name="settings-gear" size="small" class="animate-spin text-syntax-info" />
              <span>{props.status?.phase ?? "running"}</span>
              <Show when={props.status?.phaseDetail}>
                <span class="text-text-weaker">— {props.status?.phaseDetail}</span>
              </Show>
            </div>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 text-12-medium border border-border-base"
              onClick={handleStop}
              disabled={stopping()}
            >
              <Show when={stopping()} fallback={<Icon name="stop" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Stop
            </button>
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="flex-1 px-3 py-1.5 rounded-md border border-border-base bg-surface-inset text-text-base text-12-regular placeholder:text-text-weak focus:outline-none focus:border-border-strong"
              placeholder="task-folder-name"
              value={taskName()}
              onInput={(e) => setTaskName(e.currentTarget.value.replace(/[^a-zA-Z0-9-_]/g, ""))}
            />
          </div>
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tddMode()}
                onChange={(e) => setTddMode(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-border-base"
              />
              <span class="text-12-regular text-text-base">TDD Mode</span>
            </label>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium"
              onClick={handleStart}
              disabled={starting() || !taskName()}
            >
              <Show when={starting()} fallback={<Icon name="arrow-right" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Enable
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

function TestConfigCard(props: {
  status: WorkflowStatus | undefined
  sdkUrl: string
  directory: string
  onStatusChange?: () => void
  onSessionCreated?: (sessionId: string) => void
}) {
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)

  const handleStart = async () => {
    setStarting(true)
    try {
      const dirParam = `directory=${encodeURIComponent(props.directory)}`
      const startRes = await fetch(`${props.sdkUrl}/workflow/test-config/start?${dirParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!startRes.ok) throw new Error("Failed to start test config workflow")
      const startData = (await startRes.json()) as { ok: boolean; sessionId?: string }
      showToast({ title: "Test config workflow started", variant: "success" })
      props.onStatusChange?.()
      if (startData.sessionId) props.onSessionCreated?.(startData.sessionId)
    } catch (err: any) {
      showToast({ title: "Failed to start test config", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(
        `${props.sdkUrl}/workflow/test-config/stop?directory=${encodeURIComponent(props.directory)}`,
        { method: "POST" },
      )
      if (!res.ok) throw new Error("Failed to stop test config workflow")
      showToast({ title: "Test config workflow stopped", variant: "success" })
      props.onStatusChange?.()
    } catch (err: any) {
      showToast({ title: "Failed to stop test config", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Icon name="settings-gear" size="small" class="text-text-weak" />
          <span class="text-13-medium text-text-strong">Test Config</span>
          <Show when={props.status?.running}>
            <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium">
              {props.status?.phase ?? "running"}
            </span>
          </Show>
        </div>
      </div>

      <Show
        when={!props.status?.running}
        fallback={
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Icon name="settings-gear" size="small" class="animate-spin text-syntax-info" />
              <span>{props.status?.phase ?? "running"}</span>
              <Show when={props.status?.phaseDetail}>
                <span class="text-text-weaker">— {props.status?.phaseDetail}</span>
              </Show>
            </div>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 text-12-medium border border-border-base"
              onClick={handleStop}
              disabled={stopping()}
            >
              <Show when={stopping()} fallback={<Icon name="stop" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Stop
            </button>
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">Analyze project and generate test-config.json</div>
          <div class="flex justify-end">
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium"
              onClick={handleStart}
              disabled={starting()}
            >
              <Show when={starting()} fallback={<Icon name="arrow-right" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Start
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

function PRReviewCard(props: {
  status: WorkflowStatus | undefined
  sdkUrl: string
  directory: string
  onStatusChange?: () => void
  onSessionCreated?: (sessionId: string) => void
}) {
  const [pollIntervalStr, setPollIntervalStr] = createSignal("2")
  const [maxCyclesStr, setMaxCyclesStr] = createSignal("20")
  const [testCommand, setTestCommand] = createSignal("")
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)

  const pollInterval = () => Math.max(1, parseInt(pollIntervalStr(), 10) || 2)
  const maxCycles = () => Math.max(1, parseInt(maxCyclesStr(), 10) || 20)

  const handleStart = async () => {
    setStarting(true)
    try {
      const dirParam = `directory=${encodeURIComponent(props.directory)}`
      const configRes = await fetch(`${props.sdkUrl}/config?${dirParam}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prReview: {
            pollIntervalMinutes: pollInterval(),
            maxCycles: maxCycles(),
            ...(testCommand() ? { testCommand: testCommand() } : {}),
          },
        }),
      })
      if (!configRes.ok) throw new Error("Failed to update PR review config")

      const startRes = await fetch(`${props.sdkUrl}/workflow/pr-review/start?${dirParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!startRes.ok) throw new Error("Failed to start PR review workflow")
      const startData = (await startRes.json()) as { ok: boolean; sessionId?: string }
      showToast({ title: "PR review workflow started", variant: "success" })
      props.onStatusChange?.()
      if (startData.sessionId) props.onSessionCreated?.(startData.sessionId)
    } catch (err: any) {
      showToast({ title: "Failed to start PR review", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(`${props.sdkUrl}/workflow/pr-review/stop?directory=${encodeURIComponent(props.directory)}`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Failed to stop PR review workflow")
      showToast({ title: "PR review workflow stopped", variant: "success" })
      props.onStatusChange?.()
    } catch (err: any) {
      showToast({ title: "Failed to stop PR review", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Icon name="branch" size="small" class="text-text-weak" />
          <span class="text-13-medium text-text-strong">PR Review</span>
          <Show when={props.status?.running}>
            <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium">
              {props.status?.phase ?? "running"}
            </span>
          </Show>
        </div>
      </div>

      <Show
        when={!props.status?.running}
        fallback={
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Icon name="settings-gear" size="small" class="animate-spin text-syntax-info" />
              <span>{props.status?.phase ?? "running"}</span>
              <Show when={props.status?.phaseDetail}>
                <span class="text-text-weaker">— {props.status?.phaseDetail}</span>
              </Show>
            </div>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 text-12-medium border border-border-base"
              onClick={handleStop}
              disabled={stopping()}
            >
              <Show when={stopping()} fallback={<Icon name="stop" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Stop
            </button>
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1">
              <label class="text-11-medium text-text-weak">Poll interval (min)</label>
              <input
                type="number"
                min="1"
                max="60"
                class="px-2 py-1.5 rounded-md border border-border-base bg-surface-inset text-text-base text-12-regular focus:outline-none focus:border-border-strong"
                value={pollIntervalStr()}
                onInput={(e) => setPollIntervalStr(e.currentTarget.value)}
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-11-medium text-text-weak">Max cycles</label>
              <input
                type="number"
                min="1"
                max="100"
                class="px-2 py-1.5 rounded-md border border-border-base bg-surface-inset text-text-base text-12-regular focus:outline-none focus:border-border-strong"
                value={maxCyclesStr()}
                onInput={(e) => setMaxCyclesStr(e.currentTarget.value)}
              />
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-11-medium text-text-weak">Test command (optional)</label>
            <input
              type="text"
              placeholder="auto-detect"
              class="px-2 py-1.5 rounded-md border border-border-base bg-surface-inset text-text-base text-12-regular placeholder:text-text-weak focus:outline-none focus:border-border-strong"
              value={testCommand()}
              onInput={(e) => setTestCommand(e.currentTarget.value)}
            />
          </div>
          <div class="flex justify-end">
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium"
              onClick={handleStart}
              disabled={starting()}
            >
              <Show when={starting()} fallback={<Icon name="arrow-right" size="small" />}>
                <Icon name="settings-gear" size="small" class="animate-spin" />
              </Show>
              Start
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

export function WorkflowPanel(props: { onStatusChange?: () => void }) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams<{ dir: string }>()
  const [workflows, setWorkflows] = createSignal<WorkflowInfo[]>([])
  const [statuses, setStatuses] = createSignal<Record<string, WorkflowStatus>>({})

  const navigateToSession = (sessionId: string) => {
    navigate(`/${params.dir}/session/${sessionId}`)
  }

  const fetchAll = async () => {
    try {
      const res = await fetch(`${sdk.url}/workflow/list`)
      if (!res.ok) return
      const list: WorkflowInfo[] = await res.json()
      setWorkflows(list)

      const statusEntries = await Promise.all(
        list.map(async (wf) => {
          try {
            const r = await fetch(`${sdk.url}/workflow/${wf.id}/status`)
            const s: WorkflowStatus = r.ok ? await r.json() : { running: false }
            return [wf.id, s] as const
          } catch {
            return [wf.id, { running: false }] as const
          }
        }),
      )
      setStatuses(Object.fromEntries(statusEntries))
    } catch {
      // ignore
    }
  }

  createEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 5000)
    onCleanup(() => clearInterval(interval))
  })

  const handleStatusChange = () => {
    fetchAll()
    props.onStatusChange?.()
  }

  return (
    <div class="flex flex-col gap-3 mb-4">
      <div class="text-12-medium text-text-weak uppercase tracking-wide">Workflows</div>
      <For each={workflows()}>
        {(wf) => (
          <>
            <Show when={wf.activationMode === "enable" || wf.activationMode === "both"}>
              <Show when={wf.id === "task"}>
                <TaskModeCard
                  status={statuses()[wf.id]}
                  sdkUrl={sdk.url}
                  directory={sdk.directory}
                  onStatusChange={handleStatusChange}
                />
              </Show>
            </Show>
            <Show when={wf.activationMode === "start" || wf.activationMode === "both"}>
              <Show when={wf.id === "pr-review"}>
                <PRReviewCard
                  status={statuses()[wf.id]}
                  sdkUrl={sdk.url}
                  directory={sdk.directory}
                  onStatusChange={handleStatusChange}
                  onSessionCreated={navigateToSession}
                />
              </Show>
              <Show when={wf.id === "test-config"}>
                <TestConfigCard
                  status={statuses()[wf.id]}
                  sdkUrl={sdk.url}
                  directory={sdk.directory}
                  onStatusChange={handleStatusChange}
                  onSessionCreated={navigateToSession}
                />
              </Show>
            </Show>
          </>
        )}
      </For>
    </div>
  )
}
