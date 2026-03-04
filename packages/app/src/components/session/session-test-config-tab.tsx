import { createSignal, createEffect, createMemo, onCleanup, Show, For } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"

interface TestMethodConfig {
  command?: string
  test_file_command?: string | null
  required?: boolean
  runner?: string
  settings?: Record<string, unknown>
  mocks?: Record<string, unknown>
}

interface TestMethodValidation {
  status?: string
  note?: string
}

interface GeneratedTestConfig {
  version?: number
  language?: string
  framework?: string
  project_type?: string
  docker?: {
    enabled?: boolean
    image?: string
  }
  commands?: {
    test?: string
    lint?: string | null
    typecheck?: string | null
  }
  paths?: {
    tests?: string[]
  }
  test_methods?: {
    unit?: TestMethodConfig
    endpoint?: TestMethodConfig
    e2e?: TestMethodConfig
  }
  validation?: {
    unit?: TestMethodValidation
    endpoint?: TestMethodValidation
    e2e?: TestMethodValidation
  }
  warnings?: string[]
}

interface TestConfigStatus {
  running: boolean
  phase?: string
  phaseDetail?: string
  startedAt?: number
  extra?: {
    progressLog?: Array<{ message: string; timestamp: number }>
    orchestratorSessionId?: string
    configExists?: boolean
    config?: GeneratedTestConfig
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

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function configValue(map: Record<string, unknown> | undefined, key: string) {
  return stringValue(map?.[key])
}

export function SessionTestConfigTab() {
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams()

  const [status, setStatus] = createSignal<TestConfigStatus | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [elapsed, setElapsed] = createSignal("")

  const dirParam = `directory=${encodeURIComponent(sdk.directory)}`

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${sdk.url}/workflow/test-config/status?${dirParam}`)
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
      const startRes = await fetch(`${sdk.url}/workflow/test-config/start?${dirParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!startRes.ok) throw new Error("Failed to start test config workflow")
      const startData = (await startRes.json()) as { ok: boolean; sessionId?: string }
      showToast({ title: "Test config started", variant: "success" })
      await fetchStatus()
      if (startData.sessionId) navigateToSession(startData.sessionId)
    } catch (err: any) {
      showToast({ title: "Failed to start test config", description: err.message, variant: "error" })
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    try {
      const res = await fetch(`${sdk.url}/workflow/test-config/stop?${dirParam}`, { method: "POST" })
      if (!res.ok) throw new Error("Failed to stop test config workflow")
      showToast({ title: "Test config stopped", variant: "success" })
      await fetchStatus()
    } catch (err: any) {
      showToast({ title: "Failed to stop test config", description: err.message, variant: "error" })
    } finally {
      setStopping(false)
    }
  }

  const navigateToSession = (sessionId: string) => {
    navigate(`/${params.dir}/session/${sessionId}`)
  }

  const progressLog = () => status()?.extra?.progressLog ?? []
  const orchestratorSessionId = () => status()?.extra?.orchestratorSessionId
  const config = () => status()?.extra?.config

  const warnings = createMemo(() => {
    const list = config()?.warnings
    if (!Array.isArray(list)) return []
    return list.flatMap((item) => {
      const warning = stringValue(item)
      return warning ? [warning] : []
    })
  })

  const e2eNeedsAttention = createMemo(() => {
    const method = config()?.test_methods?.e2e
    if (!method?.required) return false
    return config()?.validation?.e2e?.status !== "pass"
  })

  return (
    <div class="h-full overflow-y-auto no-scrollbar">
      <div class="px-6 pt-4 flex flex-col gap-4 pb-10">
        {/* Header */}
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Icon name="settings-gear" size="small" class="text-text-weak" />
            <span class="text-14-medium text-text-strong">Test Config</span>
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
            <Icon name="settings-gear" size="small" class="text-text-weak shrink-0" />
            <span class="flex-1 truncate">Test Config Session</span>
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
              <Show when={elapsed()}>
                <span>{elapsed()} elapsed</span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Config display — shown when not running and config exists */}
        <Show when={!status()?.running && config()}>
          <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
            <div class="text-12-medium text-text-weak">Generated Config</div>
            <div class="flex flex-col gap-2">
              <Show when={config()?.language}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Language</span>
                  <span class="text-text-base font-medium">{config()!.language as string}</span>
                </div>
              </Show>
              <Show when={config()?.framework}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Framework</span>
                  <span class="text-text-base font-medium">{config()!.framework}</span>
                </div>
              </Show>
              <Show when={config()?.project_type}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Type</span>
                  <span class="text-text-base font-medium">{config()!.project_type}</span>
                </div>
              </Show>
              <Show when={config()?.docker?.enabled !== undefined}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Docker</span>
                  <span class="text-text-base font-medium">
                    {config()!.docker?.enabled ? (config()!.docker?.image ?? "enabled") : "disabled"}
                  </span>
                </div>
              </Show>
              <Show when={config()?.commands?.test}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Test</span>
                  <code class="text-text-base text-11-regular font-mono bg-surface-inset px-1.5 py-0.5 rounded">
                    {config()!.commands!.test}
                  </code>
                </div>
              </Show>
              <Show when={config()?.commands?.lint}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Lint</span>
                  <code class="text-text-base text-11-regular font-mono bg-surface-inset px-1.5 py-0.5 rounded">
                    {config()!.commands!.lint}
                  </code>
                </div>
              </Show>
              <Show when={config()?.commands?.typecheck}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Typecheck</span>
                  <code class="text-text-base text-11-regular font-mono bg-surface-inset px-1.5 py-0.5 rounded">
                    {config()!.commands!.typecheck}
                  </code>
                </div>
              </Show>
              <Show when={config()?.paths?.tests}>
                <div class="flex items-center gap-2 text-12-regular">
                  <span class="text-text-weak w-20">Tests</span>
                  <span class="text-text-base font-mono text-11-regular">{config()!.paths!.tests!.join(", ")}</span>
                </div>
              </Show>
              <Show when={config()?.test_methods}>
                <div class="flex flex-col gap-2 pt-1">
                  <div class="text-12-medium text-text-weak">Test Methods</div>
                  <Show when={config()?.test_methods?.unit}>
                    <div class="flex flex-col gap-1 rounded border border-border-base bg-surface-inset p-2">
                      <div class="flex items-center justify-between text-11-medium text-text-weak">
                        <span>Unit</span>
                        <span>{config()?.test_methods?.unit?.required ? "Required" : "Optional"}</span>
                      </div>
                      <Show when={config()?.test_methods?.unit?.command}>
                        <code class="text-text-base text-11-regular font-mono">
                          {config()?.test_methods?.unit?.command}
                        </code>
                      </Show>
                      <Show when={config()?.validation?.unit?.status}>
                        <span class="text-11-regular text-text-weak">
                          Validation: {config()?.validation?.unit?.status}
                          <Show when={config()?.validation?.unit?.note}>
                            {" — "}
                            {config()?.validation?.unit?.note}
                          </Show>
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <Show when={config()?.test_methods?.endpoint}>
                    <div class="flex flex-col gap-1 rounded border border-border-base bg-surface-inset p-2">
                      <div class="flex items-center justify-between text-11-medium text-text-weak">
                        <span>Endpoint</span>
                        <span>{config()?.test_methods?.endpoint?.required ? "Required" : "Optional"}</span>
                      </div>
                      <Show when={config()?.test_methods?.endpoint?.command}>
                        <code class="text-text-base text-11-regular font-mono">
                          {config()?.test_methods?.endpoint?.command}
                        </code>
                      </Show>
                      <Show when={config()?.validation?.endpoint?.status}>
                        <span class="text-11-regular text-text-weak">
                          Validation: {config()?.validation?.endpoint?.status}
                          <Show when={config()?.validation?.endpoint?.note}>
                            {" — "}
                            {config()?.validation?.endpoint?.note}
                          </Show>
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <Show when={config()?.test_methods?.e2e}>
                    <div class="flex flex-col gap-1 rounded border border-border-base bg-surface-inset p-2">
                      <div class="flex items-center justify-between text-11-medium text-text-weak">
                        <span>E2E</span>
                        <span>{config()?.test_methods?.e2e?.required ? "Required" : "Optional"}</span>
                      </div>
                      <Show when={config()?.test_methods?.e2e?.command}>
                        <code class="text-text-base text-11-regular font-mono">
                          {config()?.test_methods?.e2e?.command}
                        </code>
                      </Show>
                      <Show when={config()?.test_methods?.e2e?.runner}>
                        <span class="text-11-regular text-text-weak">
                          Runner: {config()?.test_methods?.e2e?.runner}
                        </span>
                      </Show>
                      <Show when={configValue(config()?.test_methods?.e2e?.settings, "base_url")}>
                        <span class="text-11-regular text-text-weak">
                          Base URL: {configValue(config()?.test_methods?.e2e?.settings, "base_url")}
                        </span>
                      </Show>
                      <Show when={configValue(config()?.test_methods?.e2e?.settings, "start_command")}>
                        <span class="text-11-regular text-text-weak">
                          Start: {configValue(config()?.test_methods?.e2e?.settings, "start_command")}
                        </span>
                      </Show>
                      <Show when={configValue(config()?.test_methods?.e2e?.settings, "wait_for")}>
                        <span class="text-11-regular text-text-weak">
                          Wait For: {configValue(config()?.test_methods?.e2e?.settings, "wait_for")}
                        </span>
                      </Show>
                      <Show when={configValue(config()?.test_methods?.e2e?.mocks, "strategy")}>
                        <span class="text-11-regular text-text-weak">
                          Mocks: {configValue(config()?.test_methods?.e2e?.mocks, "strategy")}
                        </span>
                      </Show>
                      <Show when={config()?.validation?.e2e?.status}>
                        <span class="text-11-regular text-text-weak">
                          Validation: {config()?.validation?.e2e?.status}
                          <Show when={config()?.validation?.e2e?.note}>
                            {" — "}
                            {config()?.validation?.e2e?.note}
                          </Show>
                        </span>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={warnings().length > 0 || e2eNeedsAttention()}>
                <div class="flex flex-col gap-1 rounded border border-border-base bg-surface-inset p-2">
                  <div class="text-12-medium text-text-base">Validation Attention</div>
                  <Show when={e2eNeedsAttention()}>
                    <div class="text-11-regular text-text-weak">E2E is required but has not passed validation yet.</div>
                  </Show>
                  <For each={warnings()}>
                    {(warning) => <div class="text-11-regular text-text-weak">{warning}</div>}
                  </For>
                </div>
              </Show>
            </div>
            <div class="flex justify-end pt-1">
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-primary text-text-on-primary hover:bg-surface-primary-hover disabled:opacity-50 text-12-medium"
                onClick={handleStart}
                disabled={starting()}
              >
                <Show when={starting()} fallback={<Icon name="arrow-right" size="small" />}>
                  <Icon name="settings-gear" size="small" class="animate-spin" />
                </Show>
                Re-run
              </button>
            </div>
          </div>
        </Show>

        {/* Start controls - shown when not running and no config */}
        <Show when={!status()?.running && !config()}>
          <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-base">
            <div class="text-12-regular text-text-weak">
              Analyze your project to discover tests and generate a test-config.json file.
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
        <Show when={!status()?.running && progressLog().length === 0 && !orchestratorSessionId() && !config()}>
          <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Icon name="settings-gear" size="large" class="text-text-weaker" />
            <div class="text-14-medium text-text-weak">No test config</div>
            <div class="text-12-regular text-text-weaker max-w-56">
              Start the workflow to analyze your project and generate a test configuration
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
