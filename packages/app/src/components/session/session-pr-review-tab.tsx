import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"

interface PRReviewStatus {
  running: boolean
  phase?: string
  phaseDetail?: string
  startedAt?: number
  extra?: {
    prNumber?: number
    cycleCount?: number
    lastCommitSha?: string
    progressLog?: Array<{ message: string; timestamp: number }>
    sessionIds?: string[]
    orchestratorSessionId?: string
  }
}

function formatTime(timestamp: number) {
  const d = new Date(timestamp)
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function formatElapsed(startedAt: number) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function SessionPRReviewTab() {
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams()

  const [status, setStatus] = createSignal<PRReviewStatus | null>(null)
  const [pollIntervalStr, setPollIntervalStr] = createSignal("2")
  const [maxCyclesStr, setMaxCyclesStr] = createSignal("20")
  const [testCommand, setTestCommand] = createSignal("")
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [elapsed, setElapsed] = createSignal("")

  const pollInterval = () => Math.max(1, parseInt(pollIntervalStr(), 10) || 2)
  const maxCycles = () => Math.max(1, parseInt(maxCyclesStr(), 10) || 20)

  const dirParam = `directory=${encodeURIComponent(sdk.directory)}`

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${sdk.url}/workflow/pr-review/status?${dirParam}`)
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
      const configRes = await fetch(`${sdk.url}/config?${dirParam}`, {
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
      const startRes = await fetch(`${sdk.url}/workflow/pr-review/start?${dirParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!startRes.ok) throw new Error("Failed to start PR review workflow")
      const startData = (await startRes.json()) as { ok: boolean; sessionId?: string }
      showToast({ title: "PR review started", variant: "success" })
      await fetchStatus()
      if (startData.sessionId) navigateToSession(startData.sessionId)
    } catch (err: any) {
      showToast({ title: "Failed to start PR review", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(`${sdk.url}/workflow/pr-review/stop?${dirParam}`, { method: "POST" })
      if (!res.ok) throw new Error("Failed to stop PR review workflow")
      showToast({ title: "PR review stopped", variant: "success" })
      await fetchStatus()
    } catch (err: any) {
      showToast({ title: "Failed to stop PR review", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  const navigateToSession = (sessionId: string) => {
    navigate(`/${params.dir}/session/${sessionId}`)
  }

  const progressLog = () => status()?.extra?.progressLog ?? []
  const sessionIds = () => status()?.extra?.sessionIds ?? []
  const orchestratorSessionId = () => status()?.extra?.orchestratorSessionId

  return (
    <div class="h-full overflow-y-auto no-scrollbar">
      <div class="px-6 pt-4 flex flex-col gap-4 pb-10">
        {/* Header */}
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Icon name="branch" size="small" class="text-text-weak" />
            <span class="text-14-medium text-text-strong">PR Review</span>
            <Show
              when={status()?.running}
              fallback={
                <span class="px-2 py-0.5 rounded-full bg-surface-base text-text-weak text-11-medium border border-border-base">
                  Stopped
                </span>
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
        <Show when={orchestratorSessionId()}>
          <button
            class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-base bg-surface-base hover:bg-surface-raised-base-hover text-left text-12-regular text-text-base"
            onClick={() => navigateToSession(orchestratorSessionId()!)}
          >
            <Icon name="branch" size="small" class="text-text-weak shrink-0" />
            <span class="flex-1 truncate">PR Review Session</span>
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
                <span class="text-text-weak">— {status()?.phaseDetail}</span>
              </Show>
            </div>
            <div class="flex items-center gap-4 text-11-regular text-text-weak">
              <Show when={status()?.extra?.prNumber}>
                <span>PR #{status()?.extra?.prNumber}</span>
              </Show>
              <Show when={status()?.extra?.cycleCount}>
                <span>Cycle {status()?.extra?.cycleCount}</span>
              </Show>
              <Show when={elapsed()}>
                <span>{elapsed()} elapsed</span>
              </Show>
              <Show when={status()?.extra?.lastCommitSha}>
                <span class="font-mono">{status()?.extra?.lastCommitSha?.slice(0, 7)}</span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Start controls - shown when not running */}
        <Show when={!status()?.running}>
          <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
            <div class="text-12-medium text-text-weak">Start PR Review</div>
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

        {/* Fix sessions */}
        <Show when={sessionIds().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak">Fix Sessions</div>
            <div class="flex flex-col gap-1">
              <For each={sessionIds()}>
                {(sessionId, i) => (
                  <button
                    class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-base bg-surface-base hover:bg-surface-raised-base-hover text-left text-12-regular text-text-base"
                    onClick={() => navigateToSession(sessionId)}
                  >
                    <Icon name="branch" size="small" class="text-text-weak shrink-0" />
                    <span class="flex-1 truncate">Fix Session {i() + 1}</span>
                    <Icon name="arrow-right" size="small" class="text-text-weak shrink-0" />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Activity log */}
        <Show when={progressLog().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak">Activity</div>
            <div class="flex flex-col gap-1 rounded-md border border-border-base bg-surface-inset p-2 max-h-80 overflow-y-auto no-scrollbar">
              <For each={progressLog()}>
                {(entry) => (
                  <div class="flex items-start gap-2 py-1 px-2 rounded text-12-regular">
                    <span class="font-mono text-11-regular text-text-weaker shrink-0 mt-0.5">
                      {formatTime(entry.timestamp)}
                    </span>
                    <span class="text-text-base">{entry.message}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Empty state */}
        <Show
          when={
            !status()?.running && progressLog().length === 0 && sessionIds().length === 0 && !orchestratorSessionId()
          }
        >
          <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Icon name="branch" size="large" class="text-text-weaker" />
            <div class="text-14-medium text-text-weak">No active PR review</div>
            <div class="text-12-regular text-text-weaker max-w-56">
              Start the workflow to automatically address PR review comments
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
