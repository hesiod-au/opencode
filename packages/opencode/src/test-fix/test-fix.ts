import { Log } from "../util/log"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { WorkflowOrchestrator } from "../workflow/orchestrator"
import { WorkflowState } from "../workflow/state"
import { TestFixEvent } from "./events"
import { TestFixReport } from "./report"
import { GroupRunner } from "./group-runner"
import { FixAgent } from "./fix-agent"
import type { TestFix } from "./types"
import type { Workflow } from "../workflow/workflow"

export namespace TestFixOrchestrator {
  const log = Log.create({ service: "test-fix" })

  export type Phase = "reading-config" | "running-groups" | "aggregating" | "reporting" | "completed"

  interface OrchestratorState {
    running: boolean
    phase?: Phase
    phaseDetail?: string
    parentSessionId?: string
    runId?: string
    startedAt?: number
    completedAt?: number
    abort?: AbortController
    groupResults: TestFix.GroupResult[]
    config?: TestFix.TestConfig
    reportSessionId?: string
    stats: TestFix.Stats
  }

  const instanceState = Instance.state(
    () => {
      const current: OrchestratorState = {
        running: false,
        groupResults: [],
        stats: { inputTokens: 0, outputTokens: 0, cost: 0, duration: 0, modifiedFiles: [] },
      }
      return { current }
    },
    async (data) => {
      log.info("cleaning up test-fix state")
      data.current.abort?.abort()
      data.current.running = false
    },
  )

  function setPhase(phase: Phase, detail?: string): void {
    const state = instanceState().current
    state.phase = phase
    state.phaseDetail = detail
    Bus.publish(TestFixEvent.PhaseChanged, { phase, detail })
  }

  async function readConfig(): Promise<TestFix.TestConfig | undefined> {
    const configPath = `${Instance.directory}/test-config.json`
    const exists = await Bun.file(configPath)
      .exists()
      .catch(() => false)
    if (!exists) return undefined
    try {
      const text = await Bun.file(configPath).text()
      return JSON.parse(text) as TestFix.TestConfig
    } catch {
      return undefined
    }
  }

  export async function start(options: Workflow.StartOptions & { runId?: string }): Promise<void> {
    const state = instanceState().current
    if (state.running) {
      log.warn("test-fix already running")
      return
    }

    state.running = true
    state.runId = options.runId
    state.startedAt = Date.now()
    state.completedAt = undefined
    state.groupResults = []
    state.reportSessionId = undefined
    state.stats = { inputTokens: 0, outputTokens: 0, cost: 0, duration: 0, modifiedFiles: [] }

    const abort = new AbortController()
    state.abort = abort

    const parentSessionId = await WorkflowOrchestrator.initializeOrchestrator(
      "test-fix",
      "Test Fix",
      options.runId,
      options.parentSessionId,
    )
    state.parentSessionId = parentSessionId

    WorkflowOrchestrator.setBusy(parentSessionId)

    Bus.publish(TestFixEvent.OrchestratorStarted, { orchestratorSessionId: parentSessionId })

    try {
      // Phase 1: Read config
      setPhase("reading-config", "Reading test-config.json")
      await WorkflowOrchestrator.logProgress(parentSessionId, "Reading test-config.json...")

      const config = await readConfig()
      if (!config) {
        throw new Error("No test-config.json found. Run the test-config workflow first.")
      }
      state.config = config

      if (!config.test_methods) {
        throw new Error("test-config.json has no test_methods defined")
      }

      // Determine which test types to process
      const types: TestFix.TestType[] = ["unit", "endpoint", "e2e"]
      const activeGroups = types.flatMap((type) => {
        const method = config.test_methods?.[type]
        if (!method?.command) return []
        return [{ type, method }]
      })

      if (activeGroups.length === 0) {
        throw new Error("No test methods with commands found in test-config.json")
      }

      await WorkflowOrchestrator.logProgress(
        parentSessionId,
        `Found ${activeGroups.length} test group(s): ${activeGroups.map((g) => g.type).join(", ")}`,
      )

      // Phase 2: Run groups in parallel
      setPhase("running-groups", `Running ${activeGroups.length} test group(s)`)

      const cfg = await Config.get()
      const maxConcurrent = cfg.testFix?.maxConcurrentAgents ?? 10
      const concurrency = { current: 0, max: maxConcurrent }

      const groupPromises = activeGroups.map((group) =>
        GroupRunner.run({
          type: group.type,
          method: group.method,
          parentSessionId,
          runId: state.runId,
          concurrency,
          abort: abort.signal,
        }),
      )

      const results = await Promise.all(groupPromises)
      state.groupResults = results

      if (abort.signal.aborted) {
        throw new Error("Test fix was stopped")
      }

      // Phase 3: Aggregate
      setPhase("aggregating", "Aggregating results")

      // Collect stats from all sessions
      const allSessionIds: string[] = []
      for (const group of results) {
        if (group.sessionId) allSessionIds.push(group.sessionId)
        for (const file of group.files) {
          if (file.sessionId) allSessionIds.push(file.sessionId)
        }
      }

      let totalInput = 0
      let totalOutput = 0
      let totalCost = 0

      for (const sid of allSessionIds) {
        const sessionStats = await FixAgent.computeSessionStats(sid).catch(() => ({
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        }))
        totalInput += sessionStats.inputTokens
        totalOutput += sessionStats.outputTokens
        totalCost += sessionStats.cost
      }

      const invalidTests = results.flatMap((g) => g.files.filter((f) => f.status === "invalid"))
      const allPassing = results.every((g) => g.suitePassedAfterFixes)

      state.completedAt = Date.now()
      state.stats = {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: totalCost,
        duration: state.completedAt - (state.startedAt ?? state.completedAt),
        modifiedFiles: [],
      }

      // Phase 4: Report
      setPhase("reporting", "Generating report")

      const report: TestFix.Report = {
        groups: results,
        stats: state.stats,
        invalidTests,
        allPassing,
      }

      const reportSessionId = await TestFixReport.create(parentSessionId, report, state.runId)
      state.reportSessionId = reportSessionId

      // Phase 5: Done
      setPhase("completed", allPassing ? "All tests passing" : "Completed with failures")
      state.running = false

      WorkflowOrchestrator.setIdle(parentSessionId)

      Bus.publish(TestFixEvent.OrchestratorStopped, {
        reason: "completed",
        reportSessionId,
      })

      log.info("test-fix completed", { allPassing, groups: results.length })
    } catch (err: any) {
      log.error("test-fix error", { error: err })
      state.running = false
      state.completedAt = Date.now()
      state.stats.duration = state.completedAt - (state.startedAt ?? state.completedAt)
      setPhase("completed", `Error: ${err.message}`)

      WorkflowOrchestrator.setIdle(parentSessionId)

      await WorkflowOrchestrator.logProgress(parentSessionId, `Error: ${err.message}`).catch(() => {})

      Bus.publish(TestFixEvent.OrchestratorStopped, {
        reason: "error",
      })
    }
  }

  export async function stop(reason: Workflow.StopReason): Promise<void> {
    const state = instanceState().current
    if (!state.running) return

    log.info("stopping test-fix", { reason })
    state.abort?.abort()
    state.running = false
    state.completedAt = Date.now()
    state.stats.duration = state.completedAt - (state.startedAt ?? state.completedAt)

    if (state.parentSessionId) {
      WorkflowOrchestrator.setIdle(state.parentSessionId)
    }

    Bus.publish(TestFixEvent.OrchestratorStopped, { reason })
  }

  export function isRunning(): boolean {
    return instanceState().current.running
  }

  export function getStatus(): Workflow.Status<Phase> & { extra?: Record<string, unknown> } {
    const state = instanceState().current

    const groupStatuses = state.groupResults.map((g) => ({
      type: g.type,
      fileCount: g.files.length,
      passing: g.files.filter((f) => f.status === "passing").length,
      failing: g.files.filter((f) => f.status === "failing").length,
      erroring: g.files.filter((f) => f.status === "erroring").length,
      invalid: g.files.filter((f) => f.status === "invalid").length,
      suitePassedAfterFixes: g.suitePassedAfterFixes,
    }))

    const invalidTests = state.groupResults.flatMap((g) =>
      g.files.filter((f) => f.status === "invalid").map((f) => ({ file: f.file, reason: f.reason })),
    )

    return {
      running: state.running,
      phase: state.phase,
      phaseDetail: state.phaseDetail,
      parentSessionId: state.parentSessionId,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      stats: {
        inputTokens: state.stats.inputTokens,
        outputTokens: state.stats.outputTokens,
        cost: state.stats.cost,
        modifiedFiles: state.stats.modifiedFiles,
      },
      extra: {
        config: state.config,
        groups: groupStatuses,
        invalidTests,
        reportSessionId: state.reportSessionId,
      },
    }
  }
}
