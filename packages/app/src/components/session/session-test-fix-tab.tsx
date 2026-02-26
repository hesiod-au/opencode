import { createSignal, createEffect, createMemo, onCleanup, Show, For } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"

interface GroupStatus {
  type: string
  fileCount: number
  passing: number
  failing: number
  erroring: number
  invalid: number
  suitePassedAfterFixes: boolean
}

interface InvalidTest {
  file: string
  reason?: string
}

interface TestFixStatus {
  running: boolean
  phase?: string
  phaseDetail?: string
  startedAt?: number
  completedAt?: number
  parentSessionId?: string
  stats?: {
    inputTokens: number
    outputTokens: number
    cost: number
    modifiedFiles: string[]
  }
  extra?: {
    config?: Record<string, unknown>
    groups?: GroupStatus[]
    invalidTests?: InvalidTest[]
    reportSessionId?: string
  }
}

function formatElapsed(startedAt: number) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatCost(cost: number) {
  return `$${cost.toFixed(4)}`
}

function formatTokens(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export function SessionTestFixTab() {
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams()

  const [status, setStatus] = createSignal<TestFixStatus | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [elapsed, setElapsed] = createSignal("")

  const dirParam = `directory=${encodeURIComponent(sdk.directory)}`

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${sdk.url}/workflow/test-fix/status?${dirParam}`)
      if (r.ok) setStatus(await r.json())
    } catch {
      // ignore
    }
  }

  createEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    const s = status()
    if (!s?.running || !s.startedAt) {
      setElapsed("")
      return
    }
    setElapsed(formatElapsed(s.startedAt))
    const timer = setInterval(() => setElapsed(formatElapsed(s.startedAt!)), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const handleStart = async () => {
    setStarting(true)
    try {
      const res = await fetch(`${sdk.url}/workflow/test-fix/start?${dirParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error("Failed to start test fix workflow")
      showToast({ title: "Test fix started", variant: "success" })
      await fetchStatus()
    } catch (err: any) {
      showToast({ title: "Failed to start test fix", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(`${sdk.url}/workflow/test-fix/stop?${dirParam}`, { method: "POST" })
      if (!res.ok) throw new Error("Failed to stop test fix workflow")
      showToast({ title: "Test fix stopped", variant: "success" })
      await fetchStatus()
    } catch (err: any) {
      showToast({ title: "Failed to stop test fix", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  const navigateToSession = (sessionId: string) => {
    navigate(`/${params.dir}/session/${sessionId}`)
  }

  const groups = createMemo(() => status()?.extra?.groups ?? [])
  const invalidTests = createMemo(() => status()?.extra?.invalidTests ?? [])
  const hasConfig = createMemo(() => !!status()?.extra?.config)
  const isCompleted = createMemo(() => !status()?.running && status()?.completedAt)
  const reportSessionId = createMemo(() => status()?.extra?.reportSessionId as string | undefined)

  const totalFiles = createMemo(() => groups().reduce((sum, g) => sum + g.fileCount, 0))
  const totalPassing = createMemo(() => groups().reduce((sum, g) => sum + g.passing, 0))
  const allGroupsPassed = createMemo(() => groups().length > 0 && groups().every((g) => g.suitePassedAfterFixes))

  return (
    <div class="h-full overflow-y-auto no-scrollbar">
      <div class="px-6 pt-4 flex flex-col gap-4 pb-10">
        {/* Header */}
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Icon name="circle-check" size="small" class="text-text-weak" />
            <span class="text-14-medium text-text-strong">Test Fix</span>
            <Show
              when={status()?.running}
              fallback={
                <Show when={isCompleted()}>
                  <span
                    class={`px-2 py-0.5 rounded-full text-11-medium flex items-center gap-1 ${
                      allGroupsPassed()
                        ? "bg-syntax-success/20 text-syntax-success"
                        : "bg-syntax-warning/20 text-syntax-warning"
                    }`}
                  >
                    {allGroupsPassed() ? "All Passing" : "Completed"}
                  </span>
                </Show>
              }
            >
              <span class="px-2 py-0.5 rounded-full bg-syntax-info/20 text-syntax-info text-11-medium flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-syntax-info animate-pulse" />
                Running
              </span>
            </Show>
          </div>
          <Show when={status()?.running}>
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
          </Show>
        </div>

        {/* Orchestrator session link */}
        <Show when={status()?.parentSessionId}>
          <button
            class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-base bg-surface-base hover:bg-surface-raised-base-hover text-left text-12-regular text-text-base"
            onClick={() => navigateToSession(status()!.parentSessionId!)}
          >
            <Icon name="circle-check" size="small" class="text-text-weak shrink-0" />
            <span class="flex-1 truncate">Test Fix Session</span>
            <Icon name="arrow-right" size="small" class="text-text-weak shrink-0" />
          </button>
        </Show>

        {/* Running status */}
        <Show when={status()?.running}>
          <div class="flex flex-col gap-2 p-3 rounded-md border border-syntax-info/30 bg-syntax-info/5">
            <div class="flex items-center gap-2 text-12-regular text-text-base">
              <Icon name="settings-gear" size="small" class="animate-spin text-syntax-info" />
              <span class="text-syntax-info font-medium">{status()?.phase ?? "running"}</span>
              <Show when={status()?.phaseDetail}>
                <span class="text-text-weak">- {status()?.phaseDetail}</span>
              </Show>
            </div>
            <div class="flex items-center gap-4 text-11-regular text-text-weak">
              <Show when={elapsed()}>
                <span>{elapsed()} elapsed</span>
              </Show>
              <Show when={totalFiles() > 0}>
                <span>
                  {totalPassing()}/{totalFiles()} passing
                </span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Group progress cards */}
        <Show when={groups().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak">Test Groups</div>
            <For each={groups()}>
              {(group) => (
                <div class="flex flex-col gap-1.5 rounded-md border border-border-base bg-surface-base p-3">
                  <div class="flex items-center justify-between">
                    <span class="text-12-medium text-text-strong capitalize">{group.type}</span>
                    <span
                      class={`px-2 py-0.5 rounded-full text-11-medium ${
                        group.suitePassedAfterFixes
                          ? "bg-syntax-success/20 text-syntax-success"
                          : group.fileCount === 0
                            ? "bg-surface-inset text-text-weak"
                            : "bg-syntax-warning/20 text-syntax-warning"
                      }`}
                    >
                      {group.suitePassedAfterFixes
                        ? "Passing"
                        : group.fileCount === 0
                          ? "No failures"
                          : `${group.passing}/${group.fileCount}`}
                    </span>
                  </div>
                  <Show when={group.fileCount > 0}>
                    <div class="flex items-center gap-3 text-11-regular text-text-weak">
                      <Show when={group.passing > 0}>
                        <span class="text-syntax-success">{group.passing} fixed</span>
                      </Show>
                      <Show when={group.failing > 0}>
                        <span class="text-syntax-error">{group.failing} failing</span>
                      </Show>
                      <Show when={group.erroring > 0}>
                        <span class="text-syntax-warning">{group.erroring} erroring</span>
                      </Show>
                      <Show when={group.invalid > 0}>
                        <span class="text-text-weak">{group.invalid} invalid</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Invalid tests */}
        <Show when={invalidTests().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-syntax-warning">Invalid Tests</div>
            <div class="flex flex-col gap-1 rounded-md border border-syntax-warning/30 bg-syntax-warning/5 p-3">
              <For each={invalidTests()}>
                {(test) => (
                  <div class="flex flex-col gap-0.5 py-1">
                    <code class="text-11-regular font-mono text-text-base">{test.file}</code>
                    <Show when={test.reason}>
                      <span class="text-11-regular text-text-weak">{test.reason}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Completed stats */}
        <Show when={isCompleted() && status()?.stats}>
          <div class="flex flex-col gap-2 p-3 rounded-md border border-border-base bg-surface-base">
            <div class="text-12-medium text-text-weak">Statistics</div>
            <div class="flex items-center gap-4 text-11-regular text-text-weak flex-wrap">
              <span>Cost: {formatCost(status()!.stats!.cost)}</span>
              <span>Tokens: {formatTokens(status()!.stats!.inputTokens + status()!.stats!.outputTokens)}</span>
              <Show when={status()!.stats!.modifiedFiles.length > 0}>
                <span>Files modified: {status()!.stats!.modifiedFiles.length}</span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Report session link */}
        <Show when={reportSessionId()}>
          <button
            class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-base bg-surface-base hover:bg-surface-raised-base-hover text-left text-12-regular text-text-base"
            onClick={() => navigateToSession(reportSessionId()!)}
          >
            <Icon name="bullet-list" size="small" class="text-text-weak shrink-0" />
            <span class="flex-1 truncate">View Full Report</span>
            <Icon name="arrow-right" size="small" class="text-text-weak shrink-0" />
          </button>
        </Show>

        {/* Start / Re-run controls */}
        <Show when={!status()?.running}>
          <Show
            when={hasConfig()}
            fallback={
              <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
                <div class="text-12-regular text-text-weak">
                  No test-config.json found. Run the Test Config workflow first to analyze your project and generate a
                  test configuration.
                </div>
                <div class="flex justify-end">
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium opacity-50 cursor-not-allowed"
                    disabled
                  >
                    <Icon name="circle-check" size="small" />
                    Start
                  </button>
                </div>
              </div>
            }
          >
            <div class="flex justify-end">
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium"
                onClick={handleStart}
                disabled={starting()}
              >
                <Show when={starting()} fallback={<Icon name="circle-check" size="small" />}>
                  <Icon name="settings-gear" size="small" class="animate-spin" />
                </Show>
                {isCompleted() ? "Re-run" : "Start"}
              </button>
            </div>
          </Show>
        </Show>

        {/* Empty state */}
        <Show when={!status()?.running && !isCompleted() && !hasConfig() && groups().length === 0}>
          <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Icon name="circle-check" size="large" class="text-text-weaker" />
            <div class="text-14-medium text-text-weak">No test fix results</div>
            <div class="text-12-regular text-text-weaker max-w-56">
              Run the Test Config workflow first, then start Test Fix to find and fix failing tests
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
