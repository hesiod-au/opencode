import { Log } from "../util/log"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { TaskList } from "./task-list"
import { TaskFile } from "./task-file"
import { TaskModeEvent } from "./events"
import { TaskAgent } from "./task-agent"
import { PlanningAgent } from "./planning-agent"
import { TestWriterAgent } from "./test-writer-agent"
import { Collision } from "./collision"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { Storage } from "../storage/storage"
import { Snapshot } from "../snapshot"
import fs from "fs/promises"
import path from "path"

export namespace Orchestrator {
  const log = Log.create({ service: "orchestrator" })

  export type OrchestratorPhase =
    | "planning"
    | "test-writing"
    | "waiting-confirmation"
    | "executing"
    | "e2e-testing"
    | "completing"

  // Persisted state stored on disk
  interface PersistedState {
    running: boolean
    paths: TaskList.Paths
    activeTaskIds: string[] // Just the IDs, not the promises
    launchedTaskIds: string[] // All tasks that were ever launched (prevents re-launching)
    startedAt: number
    completedAt?: number
    phase?: OrchestratorPhase
    phaseDetail?: string
    stats: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
  }

  // Runtime state in memory
  interface OrchestratorState {
    running: boolean
    paths: TaskList.Paths
    parentSessionId?: string // Log to parent session (user's main session)
    activeTasks: Map<string, { sessionId: string; promise: Promise<TaskAgent.TaskAgentResult> }>
    launchedTaskIds: Set<string> // Track all tasks that have ever been launched (prevents re-launching)
    pollInterval: ReturnType<typeof setInterval> | null
    pollInProgress: boolean // Prevent overlapping poll calls
    pollStartedAt?: number // Track when current poll started for stuck detection
    abortController: AbortController | null
    startedAt: number
    completedAt?: number
    lastStatusMessage?: string // Track last status to avoid spam
    phase?: OrchestratorPhase
    phaseDetail?: string
    stats: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: Set<string>
    }
  }

  let state: OrchestratorState | null = null

  function setPhase(phase: OrchestratorPhase, detail?: string): void {
    if (!state) return
    const previous = state.phase
    state.phase = phase
    state.phaseDetail = detail
    log.info("orchestrator phase changed", { from: previous, to: phase, detail })
    Bus.publish(TaskModeEvent.OrchestratorPhaseChanged, { phase, detail })
  }

  // Log status message only if it's different from the last one (prevents spam)
  async function logStatus(key: string, text: string): Promise<void> {
    if (!state || state.lastStatusMessage === key) return
    state.lastStatusMessage = key
    await logAction(text)
  }

  let cachedModel: { providerID: string; modelID: string } | undefined
  async function resolveModel(): Promise<{ providerID: string; modelID: string }> {
    if (cachedModel) return cachedModel
    const agent = await Agent.get("build")
    if (agent?.model) {
      cachedModel = { providerID: agent.model.providerID, modelID: agent.model.modelID }
      return cachedModel
    }
    const agents = await Agent.list()
    const first = agents[0]
    if (first?.model) {
      cachedModel = { providerID: first.model.providerID, modelID: first.model.modelID }
      return cachedModel
    }
    cachedModel = { providerID: "openai", modelID: "gpt-5.2-codex" }
    return cachedModel
  }

  async function logAction(text: string): Promise<void> {
    if (!state?.parentSessionId) {
      log.warn("logAction called but no parentSessionId", { text: text.slice(0, 50) })
      return
    }

    try {
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")
      const model = await resolveModel()

      log.info("logAction: creating message", {
        messageID,
        parentSessionId: state.parentSessionId,
        text: text.slice(0, 50),
      })

      await Session.updateMessage({
        id: messageID,
        sessionID: state.parentSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })

      await Session.updatePart({
        id: partID,
        sessionID: state.parentSessionId,
        messageID,
        type: "text",
        text,
        synthetic: true,
      })

      log.info("logAction: message created successfully", { messageID })
    } catch (err) {
      log.error("logAction failed", { error: err, text: text.slice(0, 50) })
    }
  }

  async function computeFileDiffs(modifiedFiles: Set<string>): Promise<Snapshot.FileDiff[]> {
    const { execSync } = await import("child_process")
    const cwd = Instance.directory
    const diffs: Snapshot.FileDiff[] = []

    for (const file of modifiedFiles) {
      try {
        let before = ""
        let after = ""
        let additions = 0
        let deletions = 0
        let status: "added" | "deleted" | "modified" = "modified"

        // Get file status
        const statusOutput = execSync(`git status --porcelain -- "${file}"`, { cwd, encoding: "utf-8" }).trim()
        if (statusOutput.startsWith("??") || statusOutput.startsWith("A ")) {
          status = "added"
        } else if (statusOutput.startsWith("D ")) {
          status = "deleted"
        }

        // Get before content (from HEAD)
        if (status !== "added") {
          try {
            before = execSync(`git show HEAD:"${file}"`, { cwd, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 })
          } catch {
            before = ""
          }
        }

        // Get after content (current working tree)
        if (status !== "deleted") {
          try {
            after = await Bun.file(path.join(cwd, file)).text()
          } catch {
            after = ""
          }
        }

        // Get numstat for additions/deletions
        try {
          const numstat = execSync(`git diff HEAD --numstat -- "${file}"`, { cwd, encoding: "utf-8" }).trim()
          if (numstat) {
            const [adds, dels] = numstat.split("\t")
            additions = adds === "-" ? 0 : parseInt(adds ?? "0")
            deletions = dels === "-" ? 0 : parseInt(dels ?? "0")
            if (!Number.isFinite(additions)) additions = 0
            if (!Number.isFinite(deletions)) deletions = 0
          }
        } catch {
          // For untracked files, count all lines as additions
          if (status === "added" && after) {
            additions = after.split("\n").length
          }
        }

        diffs.push({ file, before, after, additions, deletions, status })
      } catch (err) {
        log.warn("failed to compute diff for file", { file, error: err })
      }
    }

    return diffs
  }

  async function createFinalReport(
    taskList: TaskList.TaskListFile,
    paths: TaskList.Paths,
    parentSessionId: string | undefined,
    stats: { inputTokens: number; outputTokens: number; cost: number; modifiedFiles: Set<string> },
    testInfo?: { testsCouldNotRun?: boolean; testsCouldNotRunReason?: string },
  ): Promise<string | undefined> {
    if (!parentSessionId) {
      log.warn("cannot create final report without parent session")
      return undefined
    }

    try {
      // Create a child session for the final report
      const reportSession = await Session.create({
        parentID: parentSessionId,
        title: "Task Mode Final Report",
      })

      const counts = TaskList.getCounts(taskList)

      // Read task files to get descriptions and test info
      const taskSummaries: string[] = []
      let totalTestsPassed = 0

      for (const task of taskList.tasks) {
        const taskFilePath = TaskFile.getFilePath(paths.tasksDir, task.id)
        const taskFile = await TaskFile.read(taskFilePath)

        const statusEmoji = task.status === "done" ? "✓" : task.status === "error" ? "✗" : "○"
        let summary = `### ${statusEmoji} Task ${task.id}: ${task.title}\n\n`

        if (taskFile?.description) {
          // Truncate long descriptions
          const desc =
            taskFile.description.length > 500 ? taskFile.description.slice(0, 500) + "..." : taskFile.description
          summary += `${desc}\n\n`
        }

        if (taskFile?.tests && taskFile.tests.length > 0) {
          summary += `**Tests:** ${taskFile.tests.join(", ")}\n`
          if (task.status === "done") {
            totalTestsPassed += taskFile.tests.length
          }
        }

        if (taskFile?.comments) {
          summary += `**Result:** ${taskFile.comments}\n`
        }

        taskSummaries.push(summary)
      }

      // Build warnings section if tests couldn't run
      const warningsSection = testInfo?.testsCouldNotRun
        ? `## ⚠️ Warnings

- **Tests could not be run automatically.** ${testInfo.testsCouldNotRunReason || "The test runner could not be determined or executed."}
- Please run the tests manually to verify the implementation.

`
        : ""

      // Build the final report content
      const reportContent = `# Task Mode Final Report

## Summary

- **Total Tasks:** ${counts.total}
- **Completed:** ${counts.completed}
- **Errors:** ${counts.error}
- **Tests Passed:** ${totalTestsPassed}

${warningsSection}## Statistics

- **Duration:** ${formatDuration(state?.completedAt ? state.completedAt - state.startedAt : 0)}
- **Input Tokens:** ${stats.inputTokens.toLocaleString()}
- **Output Tokens:** ${stats.outputTokens.toLocaleString()}
- **Cost:** $${stats.cost.toFixed(4)}
- **Files Modified:** ${stats.modifiedFiles.size}

## Task Details

${taskSummaries.join("\n---\n\n")}

## Modified Files

${
  Array.from(stats.modifiedFiles)
    .map((f) => `- \`${f}\``)
    .join("\n") || "No files modified"
}
`

      // Write the report as a message in the report session
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")

      const model = await resolveModel()
      await Session.updateMessage({
        id: messageID,
        sessionID: reportSession.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })

      await Session.updatePart({
        id: partID,
        sessionID: reportSession.id,
        messageID,
        type: "text",
        text: reportContent,
        synthetic: true,
      })

      // Compute and store file diffs for the review tab
      if (stats.modifiedFiles.size > 0) {
        const fileDiffs = await computeFileDiffs(stats.modifiedFiles)
        await Storage.write(["session_diff", reportSession.id], fileDiffs)
        await Session.update(reportSession.id, (draft) => {
          draft.summary = {
            additions: fileDiffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: fileDiffs.reduce((sum, x) => sum + x.deletions, 0),
            files: fileDiffs.length,
          }
        })
        Bus.publish(Session.Event.Diff, {
          sessionID: reportSession.id,
          diff: fileDiffs,
        })
        log.info("final report diffs stored", { sessionId: reportSession.id, fileCount: fileDiffs.length })
      }

      log.info("final report created", { sessionId: reportSession.id })

      // Also log to parent session
      const testWarning = testInfo?.testsCouldNotRun
        ? `\n\n⚠️ **Tests could not be run automatically.** Please run tests manually.`
        : ""
      await logAction(
        `**Final Report created** - see child session for details\n\n**Summary:** ${counts.completed}/${counts.total} tasks completed, ${totalTestsPassed} tests passed${testWarning}`,
      )

      return reportSession.id
    } catch (err) {
      log.error("failed to create final report", { error: err })
      return undefined
    }
  }

  function formatDuration(ms: number): string {
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

  // E2E Test running and fixing
  async function runE2ETest(
    e2eTestName: string,
    testFramework?: TaskList.TestFrameworkInfo,
  ): Promise<{ success: boolean; output: string; couldNotRun?: boolean }> {
    const { spawn } = await import("child_process")

    let command: string[]

    // Use test framework info if available
    if (testFramework?.runCommand) {
      // Parse the run command and add test name pattern
      const baseCommand = testFramework.runCommand.split(" ")
      command = [...baseCommand]

      // Add test name filter based on framework
      // pytest -k uses "or" keyword, not "|" which causes "Wrong expression passed to '-k'"
      const framework = testFramework.framework.toLowerCase()
      if (framework.includes("pytest")) {
        command.push("-k", e2eTestName.replaceAll("|", " or "))
      } else if (framework.includes("bun")) {
        command.push("--test-name-pattern", e2eTestName)
      } else if (framework.includes("vitest")) {
        command.push("-t", e2eTestName)
      } else if (framework.includes("jest")) {
        command.push("-t", e2eTestName)
      } else if (framework.includes("go") || framework === "testing") {
        command.push("-run", e2eTestName)
      } else {
        // For unknown frameworks, try to append the test name
        command.push(e2eTestName)
      }

      log.info("using test framework from task list", { testFramework, command })
    } else {
      // Fallback: try to detect test runner from project files
      const hasBunLock = await Bun.file(`${Instance.directory}/bun.lock`)
        .exists()
        .catch(() => false)
      const hasPackageJson = await Bun.file(`${Instance.directory}/package.json`)
        .exists()
        .catch(() => false)
      const hasPytest = await Bun.file(`${Instance.directory}/pytest.ini`)
        .exists()
        .catch(() => false)
      const hasPyprojectToml = await Bun.file(`${Instance.directory}/pyproject.toml`)
        .exists()
        .catch(() => false)
      const hasGoMod = await Bun.file(`${Instance.directory}/go.mod`)
        .exists()
        .catch(() => false)

      if (hasPytest || hasPyprojectToml) {
        // pytest -k uses "or" keyword, not "|"
        command = ["pytest", "-v", "-k", e2eTestName.replaceAll("|", " or ")]
      } else if (hasGoMod) {
        command = ["go", "test", "-v", "-run", e2eTestName, "./..."]
      } else if (hasBunLock) {
        command = ["bun", "test", "--test-name-pattern", e2eTestName]
      } else if (hasPackageJson) {
        // Check if it's npm/yarn project - try npx vitest or jest
        command = ["npx", "vitest", "run", "-t", e2eTestName]
      } else {
        // Cannot determine test runner
        log.warn("could not determine test runner", { e2eTestName })
        return {
          success: false,
          output:
            "Could not determine how to run tests. No test framework info was provided and no recognized test configuration files were found.",
          couldNotRun: true,
        }
      }

      log.info("detected test runner from project files", { command })
    }

    log.info("running E2E test", { command, e2eTestName })

    return new Promise((resolve) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: Instance.directory,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on("close", (code: number | null) => {
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : "")
        const success = code === 0

        log.info("E2E test completed", { success, code })
        resolve({ success, output })
      })

      proc.on("error", (err: Error) => {
        log.error("E2E test runner failed to start", { error: err })
        resolve({
          success: false,
          output: `Failed to start test runner "${command[0]}": ${err.message}. The test runner may not be installed.`,
          couldNotRun: true,
        })
      })
    })
  }

  async function runE2EFixAgent(
    e2eTestName: string,
    testOutput: string,
    taskList: TaskList.TaskListFile,
    paths: TaskList.Paths,
    parentSessionId: string | undefined,
  ): Promise<{ success: boolean; sessionId: string }> {
    // Create a new session for E2E fix
    const fixSession = await Session.create({
      parentID: parentSessionId,
      title: `E2E Fix: ${e2eTestName}`,
    })

    // Build context with all task descriptions
    const taskDescriptions: string[] = []
    for (const task of taskList.tasks) {
      const taskFilePath = TaskFile.getFilePath(paths.tasksDir, task.id)
      const taskFile = await TaskFile.read(taskFilePath)
      if (taskFile) {
        taskDescriptions.push(`### Task ${task.id}: ${task.title}\n${taskFile.description}\n`)
      }
    }

    const prompt = `# E2E Test Failure - Fix Required

The end-to-end test \`${e2eTestName}\` is failing after all individual tasks completed successfully.

## Test Output

\`\`\`
${testOutput.slice(0, 8000)}${testOutput.length > 8000 ? "\n... (truncated)" : ""}
\`\`\`

## Task Summary

The following tasks were completed:

${taskDescriptions.join("\n")}

## Instructions

1. Analyze the E2E test failure carefully
2. Identify what's causing the integration to fail
3. Fix the implementation to make the E2E test pass
4. **IMPORTANT: Do not break any of the individual task tests** - all existing tests must continue to pass
5. Run the E2E test to verify your fix works

The E2E test validates that all components work together correctly. Focus on integration issues, missing connections between components, or configuration problems.
`

    try {
      const agent = await Agent.get("build")
      if (!agent) {
        throw new Error("Build agent not found")
      }

      const model = agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
      const messageID = Identifier.ascending("message")

      await SessionPrompt.prompt({
        messageID,
        sessionID: fixSession.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        variant: "max",
        parts: [{ type: "text", text: prompt }],
      })

      return { success: true, sessionId: fixSession.id }
    } catch (err: any) {
      log.error("E2E fix agent failed", { error: err })
      return { success: false, sessionId: fixSession.id }
    }
  }

  // Result type for E2E test loop
  interface E2ETestLoopResult {
    success: boolean
    skipped?: boolean
    couldNotRun?: boolean
    reason?: string
  }

  async function runE2ETestLoop(
    taskList: TaskList.TaskListFile,
    paths: TaskList.Paths,
    parentSessionId: string | undefined,
  ): Promise<E2ETestLoopResult> {
    const e2eTestName = taskList.e2eTest
    if (!e2eTestName) {
      log.info("no E2E test defined, skipping E2E test phase")
      return { success: true, skipped: true, reason: "No E2E test defined" }
    }

    const config = await Config.get()
    const maxE2ERetries = config.taskMode?.maxTestRetries ?? 10

    log.info("starting E2E test loop", {
      e2eTestName,
      maxRetries: maxE2ERetries,
      testFramework: taskList.testFramework,
    })
    await logAction(`**Running E2E test:** ${e2eTestName}`)

    for (let attempt = 1; attempt <= maxE2ERetries; attempt++) {
      const testResult = await runE2ETest(e2eTestName, taskList.testFramework)

      // If we couldn't run the tests at all (not a test failure), give up gracefully
      if (testResult.couldNotRun) {
        log.warn("could not run E2E tests, skipping test phase", { output: testResult.output })
        await logAction(
          `**Could not run E2E tests:** ${testResult.output}\n\nSkipping E2E test phase. Please run tests manually.`,
        )
        return {
          success: true, // Don't fail the overall task
          couldNotRun: true,
          reason: testResult.output,
        }
      }

      if (testResult.success) {
        log.info("E2E test passed", { attempt })
        await logAction(`**E2E test passed** on attempt ${attempt}`)
        return { success: true }
      }

      log.info("E2E test failed", { attempt, maxRetries: maxE2ERetries })
      await logAction(`**E2E test failed** (attempt ${attempt}/${maxE2ERetries})\n\nLaunching fix agent...`)

      if (attempt < maxE2ERetries) {
        // Launch fix agent
        const fixResult = await runE2EFixAgent(e2eTestName, testResult.output, taskList, paths, parentSessionId)

        if (!fixResult.success) {
          log.warn("E2E fix agent failed", { attempt })
          await logAction(`**E2E fix agent failed** on attempt ${attempt}`)
        }
      }
    }

    log.error("E2E test failed after max retries", { maxRetries: maxE2ERetries })
    await logAction(`**E2E test failed** after ${maxE2ERetries} attempts. Manual intervention required.`)
    return { success: false, reason: `E2E test failed after ${maxE2ERetries} attempts` }
  }

  function getStateFilePath(paths: TaskList.Paths): string {
    return path.join(path.dirname(paths.taskListPath), ".orchestrator_state.json")
  }

  async function saveState(): Promise<void> {
    if (!state) return

    const persisted: PersistedState = {
      running: state.running,
      paths: state.paths,
      activeTaskIds: Array.from(state.activeTasks.keys()),
      launchedTaskIds: Array.from(state.launchedTaskIds),
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      phase: state.phase,
      phaseDetail: state.phaseDetail,
      stats: {
        inputTokens: state.stats.inputTokens,
        outputTokens: state.stats.outputTokens,
        cost: state.stats.cost,
        modifiedFiles: Array.from(state.stats.modifiedFiles),
      },
    }

    const stateFilePath = getStateFilePath(state.paths)
    // Ensure directory exists before writing
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true })
    await fs.writeFile(stateFilePath, JSON.stringify(persisted, null, 2))
    log.info("orchestrator state saved", { path: stateFilePath })
  }

  async function loadState(paths: TaskList.Paths): Promise<PersistedState | null> {
    const stateFilePath = getStateFilePath(paths)
    try {
      const content = await fs.readFile(stateFilePath, "utf-8")
      const persisted = JSON.parse(content) as PersistedState
      log.info("orchestrator state loaded", { path: stateFilePath, persisted })
      return persisted
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null
      }
      log.warn("failed to load orchestrator state", { path: stateFilePath, error: err })
      return null
    }
  }

  async function clearPersistedState(paths: TaskList.Paths): Promise<void> {
    const stateFilePath = getStateFilePath(paths)
    try {
      await fs.unlink(stateFilePath)
      log.info("orchestrator state cleared", { path: stateFilePath })
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        log.warn("failed to clear orchestrator state", { path: stateFilePath, error: err })
      }
    }
  }

  export async function start(options?: { parentSessionId?: string; userPrompt?: string }): Promise<void> {
    if (state?.running) {
      log.warn("orchestrator already running")
      return
    }

    const config = await Config.get()
    const taskModeConfig = config.taskMode

    if (!taskModeConfig?.enabled) {
      log.info("task mode not enabled in config")
      return
    }

    const paths = TaskList.resolvePaths(
      Instance.directory,
      taskModeConfig.listPath ?? ".opencode/tasks/default/task_list.md",
    )

    // Use parent session for logging (user's main session)
    const parentSessionId = options?.parentSessionId
    log.info("orchestrator start options", {
      parentSessionId,
      hasParent: !!parentSessionId,
      userPrompt: options?.userPrompt?.slice(0, 50),
    })
    if (parentSessionId) {
      log.info("orchestrator will log to parent session", { parentSessionId })
    } else {
      log.warn("orchestrator started without parent session, actions will not be logged to UI")
    }

    state = {
      running: true,
      paths,
      parentSessionId,
      activeTasks: new Map(),
      launchedTaskIds: new Set(),
      pollInterval: null,
      pollInProgress: false,
      abortController: new AbortController(),
      startedAt: Date.now(),
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        modifiedFiles: new Set(),
      },
    }

    log.info("orchestrator starting", { taskListPath: paths.taskListPath })

    // Log initial action to parent session
    await logAction(`**Orchestrator started**\n\nTask list: \`${paths.taskListPath}\``)

    // Check for persisted state from previous run (recovery)
    const persistedState = await loadState(paths)
    if (persistedState && persistedState.running) {
      log.info("recovering from previous orchestrator state", {
        activeTaskIds: persistedState.activeTaskIds,
        launchedTaskIds: persistedState.launchedTaskIds,
        startedAt: persistedState.startedAt,
      })

      // Restore launched task IDs to prevent re-launching
      if (persistedState.launchedTaskIds) {
        for (const taskId of persistedState.launchedTaskIds) {
          state.launchedTaskIds.add(taskId)
        }
        log.info("restored launched task IDs", { count: state.launchedTaskIds.size })
      }

      // Restore stats from previous run
      if (persistedState.stats) {
        state.stats.inputTokens = persistedState.stats.inputTokens
        state.stats.outputTokens = persistedState.stats.outputTokens
        state.stats.cost = persistedState.stats.cost ?? 0
        for (const file of persistedState.stats.modifiedFiles) {
          state.stats.modifiedFiles.add(file)
        }
        state.startedAt = persistedState.startedAt
        log.info("restored stats from previous run", { stats: persistedState.stats })
      }

      // Mark any previously active tasks as needing recovery
      if (persistedState.activeTaskIds.length > 0) {
        try {
          await TaskList.update(paths.taskListPath, paths.lockPath, (current) => {
            let updated = current
            for (const taskId of persistedState.activeTaskIds) {
              // Mark as error since the orchestrator crashed while they were running
              updated = TaskList.updateTask(updated, taskId, {
                status: "error",
                assignee: undefined,
              })
            }
            return updated
          })
          log.info("recovered orphaned tasks from previous crash", {
            count: persistedState.activeTaskIds.length,
          })
          await logAction(`**Recovered ${persistedState.activeTaskIds.length} orphaned tasks** from previous crash`)
        } catch (err) {
          log.warn("failed to recover orphaned tasks", { error: err })
        }
      }
    }

    // Save initial state
    log.info("saving initial state...")
    await saveState()
    log.info("state saved")

    log.info("publishing OrchestratorStarted event")
    Bus.publish(TaskModeEvent.OrchestratorStarted, {
      taskListPath: paths.taskListPath,
    })

    // Check if task_list.md exists
    log.info("reading task list from", { path: paths.taskListPath })
    const taskList = await TaskList.read(paths.taskListPath)
    log.info("task list read result", { exists: !!taskList, taskCount: taskList?.tasks?.length ?? 0 })

    // Check if all tasks are already done - skip orchestration and let normal coding agent handle it
    if (taskList && TaskList.isAllDone(taskList)) {
      log.info("all tasks already completed, skipping orchestration to allow normal conversation")
      state.running = false
      state = null
      return
    }

    // If user sent a message and there are errored tasks with incomplete work remaining,
    // reset errored tasks to "todo" so they can be retried
    if (taskList && options?.userPrompt) {
      const counts = TaskList.getCounts(taskList)
      if (counts.error > 0) {
        const erroredTaskIds = taskList.tasks.filter((t) => t.status === "error").map((t) => t.id)
        log.info("user message received with errored tasks, resetting for retry", {
          erroredTaskIds,
          pendingCount: counts.pending,
        })

        await TaskList.update(paths.taskListPath, paths.lockPath, (current) => {
          let updated = current
          for (const taskId of erroredTaskIds) {
            updated = TaskList.updateTask(updated, taskId, {
              status: "todo",
              assignee: undefined,
            })
          }
          return updated
        })

        // Remove errored tasks from launchedTaskIds so they can be relaunched
        for (const taskId of erroredTaskIds) {
          state.launchedTaskIds.delete(taskId)
        }

        await logAction(
          `**Retrying ${erroredTaskIds.length} failed task(s):** ${erroredTaskIds.join(", ")}\n\n` +
            `User message received, resetting errored tasks for another attempt.`,
        )
      }
    }

    // If user sent a message, check for tasks that were manually reset to "todo" via the UI
    // but are still in launchedTaskIds — clear them so orchestrator will re-run them
    if (taskList && options?.userPrompt && state) {
      const manuallyResetIds = taskList.tasks
        .filter((t) => t.status === "todo" && state!.launchedTaskIds.has(t.id))
        .map((t) => t.id)
      if (manuallyResetIds.length > 0) {
        log.info("found manually-reset tasks, clearing from launchedTaskIds for re-execution", { manuallyResetIds })
        for (const taskId of manuallyResetIds) {
          state!.launchedTaskIds.delete(taskId)
        }
        await logAction(
          `**Re-queuing ${manuallyResetIds.length} manually-reset task(s):** ${manuallyResetIds.join(", ")}\n\n` +
            `Tasks were reset to "todo" via the UI, will be re-executed.`,
        )
      }
    }

    if (!taskList) {
      // No task list exists - launch planning agent
      log.info("no task list found, launching planning agent", { hasUserPrompt: !!options?.userPrompt })
      setPhase("planning")
      await logAction("**Launching planning agent**")
      const planningResult = await PlanningAgent.generatePlan({
        paths,
        parentSessionId: state.parentSessionId,
        userPrompt: options?.userPrompt,
      })

      // If planning failed, stop cleanly instead of falling through to runLoop
      if (!planningResult.success) {
        log.error("planning failed, stopping orchestrator", { error: planningResult.error })
        await logAction(`**Planning failed:** ${planningResult.error ?? "Unknown error"}\n\nOrchestrator stopping.`)
        await stop("error")
        return
      }

      // If TDD mode is enabled and planning succeeded, run test-writer agent
      if (taskModeConfig.tddMode) {
        log.info("TDD mode enabled, launching test-writer agent")
        setPhase("test-writing")
        await logAction("**Launching test-writer agent (TDD mode)**")

        // Build conversation text from the planning session
        const planningConversation = await TestWriterAgent.buildPlanningConversationText(planningResult.sessionId)

        const testWriterResult = await TestWriterAgent.run({
          paths,
          parentSessionId: state.parentSessionId,
          planningConversation,
        })

        if (!testWriterResult.success) {
          log.warn("test-writer agent failed", { error: testWriterResult.error })
          await logAction(`**Test-writer failed:** ${testWriterResult.error}`)
        } else {
          log.info("test-writer completed", { tasksWithTests: testWriterResult.tasksWithTests })
        }
      }

      // If plan confirmation required, wait for confirmation
      if (taskModeConfig.requirePlanConfirmation) {
        log.info("waiting for plan confirmation")
        setPhase("waiting-confirmation")
        await logAction("**Waiting for plan confirmation...**")
        // The UI will call confirmPlan() when user confirms
        return
      }
    }

    // Start the main orchestration loop
    log.info("entering runLoop")
    setPhase("executing")
    await runLoop()
  }

  export async function stop(
    reason: "completed" | "error" | "manual" = "manual",
    reportSessionId?: string,
  ): Promise<void> {
    if (!state) {
      log.warn("orchestrator not running")
      return
    }

    log.info("orchestrator stopping", { reason })
    await logAction(`**Orchestrator stopped:** ${reason}`)

    const paths = state.paths
    state.running = false
    state.completedAt = Date.now()

    if (state.pollInterval) {
      clearInterval(state.pollInterval)
      state.pollInterval = null
    }

    if (state.abortController) {
      state.abortController.abort()
    }

    // Wait for active tasks to complete (with timeout)
    const timeout = 30000
    const startTime = Date.now()
    while (state.activeTasks.size > 0 && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Clear collision reservations
    Collision.clearAll()

    // Save final state with completion info (don't clear - needed for stats display)
    await saveState()

    Bus.publish(TaskModeEvent.OrchestratorStopped, {
      taskListPath: paths.taskListPath,
      reason,
      reportSessionId,
    })

    state = null
  }

  export async function confirmPlan(): Promise<void> {
    if (!state) {
      throw new Error("Orchestrator not started")
    }

    log.info("plan confirmed, starting orchestration")
    setPhase("executing")
    await logAction("**Plan confirmed, starting execution**")
    await runLoop()
  }

  export function isRunning(): boolean {
    return state?.running ?? false
  }

  export function getStatus(): {
    running: boolean
    activeTasks: number
    paths?: TaskList.Paths
    parentSessionId?: string
    startedAt?: number
    completedAt?: number
    phase?: OrchestratorPhase
    phaseDetail?: string
    stats?: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
  } {
    return {
      running: state?.running ?? false,
      activeTasks: state?.activeTasks.size ?? 0,
      paths: state?.paths,
      parentSessionId: state?.parentSessionId,
      startedAt: state?.startedAt,
      completedAt: state?.completedAt,
      phase: state?.phase,
      phaseDetail: state?.phaseDetail,
      stats: state
        ? {
            inputTokens: state.stats.inputTokens,
            outputTokens: state.stats.outputTokens,
            cost: state.stats.cost,
            modifiedFiles: Array.from(state.stats.modifiedFiles),
          }
        : undefined,
    }
  }

  async function runLoop(): Promise<void> {
    if (!state) return

    const config = await Config.get()
    const taskModeConfig = config.taskMode
    const staggerSeconds = taskModeConfig?.agentLaunchStaggerSeconds ?? 5
    const pollIntervalMs = taskModeConfig?.pollIntervalMs ?? 1000
    const maxConcurrent = taskModeConfig?.maxConcurrentTasks ?? 3

    log.info("orchestration loop started", { staggerSeconds, pollIntervalMs, maxConcurrent })

    // Log initial task list status
    const initialTaskList = await TaskList.read(state.paths.taskListPath)
    if (initialTaskList) {
      const counts = TaskList.getCounts(initialTaskList)
      const statusParts = [
        `**${counts.total} tasks total**`,
        counts.completed > 0 ? `${counts.completed} done` : null,
        counts.inProgress > 0 ? `${counts.inProgress} in progress` : null,
        counts.pending > 0 ? `${counts.pending} pending` : null,
        counts.error > 0 ? `${counts.error} failed` : null,
      ].filter(Boolean)

      await logAction(
        `**Starting orchestration**\n\n` +
          `${statusParts.join(" · ")}\n\n` +
          `Max concurrent: ${maxConcurrent} · Stagger: ${staggerSeconds}s`,
      )
    }

    const poll = async () => {
      if (!state?.running) return

      // Prevent overlapping poll calls (poll has stagger delays, so interval can fire while still running)
      if (state.pollInProgress) {
        log.info("poll: skipping, previous poll still in progress")
        return
      }
      state.pollInProgress = true
      state.pollStartedAt = Date.now()

      try {
        const taskList = await TaskList.read(state.paths.taskListPath)
        if (!taskList) {
          log.warn("task list not found during poll")
          return
        }

        // Publish task list update event
        const counts = TaskList.getCounts(taskList)
        Bus.publish(TaskModeEvent.TaskListUpdated, {
          taskListPath: state.paths.taskListPath,
          taskCount: counts.total,
          pendingCount: counts.pending,
          inProgressCount: counts.inProgress,
          completedCount: counts.completed,
        })

        // Check if all done
        if (TaskList.isAllDone(taskList)) {
          log.info("all tasks completed")
          let hasErrors = TaskList.hasErrors(taskList)
          let testsCouldNotRun = false
          let testsCouldNotRunReason: string | undefined

          // Run E2E test if defined (TDD mode)
          if (taskList.e2eTest && !hasErrors) {
            setPhase("e2e-testing")
            const e2eResult = await runE2ETestLoop(taskList, state.paths, state.parentSessionId)
            if (!e2eResult.success) {
              hasErrors = true
            }
            if (e2eResult.couldNotRun) {
              testsCouldNotRun = true
              testsCouldNotRunReason = e2eResult.reason
            }
          }

          // Create final report as a child session
          setPhase("completing")
          const reportSessionId = await createFinalReport(taskList, state.paths, state.parentSessionId, state.stats, {
            testsCouldNotRun,
            testsCouldNotRunReason,
          })

          await stop(hasErrors ? "error" : "completed", reportSessionId)
          return
        }

        // Detect orphaned tasks (in-progress but not actively tracked)
        const orphanedTasks = taskList.tasks.filter((t) => t.status === "in-progress" && !state!.activeTasks.has(t.id))
        if (orphanedTasks.length > 0) {
          log.warn("detected orphaned tasks", { orphanedIds: orphanedTasks.map((t) => t.id) })
          await logAction(
            `**Orphaned tasks detected**\n\n` +
              `The following tasks are marked as in-progress but have no active agent:\n` +
              orphanedTasks.map((t) => `- ${t.id}: ${t.title}`).join("\n") +
              `\n\nThese tasks may have crashed. Please review and manually set their status to "todo" to retry or "error" to skip.`,
          )
          // Don't launch new tasks while there are orphaned tasks - wait for human intervention
          return
        }

        // Find runnable tasks
        const runnableTasks = TaskList.getRunnableTasks(taskList)

        // Diagnostic: detect stuck state (no runnable, no active, but pending remain)
        const pendingCount = counts.pending
        if (runnableTasks.length === 0 && state.activeTasks.size === 0 && pendingCount > 0) {
          log.warn("possible dependency cycle: no runnable tasks, no active tasks, but pending tasks remain", {
            pendingCount,
            pendingIds: taskList.tasks.filter((t) => t.status === "todo").map((t) => t.id),
          })
          await logAction(
            `**Possible dependency cycle detected**\n\n` +
              `No tasks can run but ${pendingCount} task(s) are still pending. ` +
              `This may indicate a circular dependency. Please review task dependencies.`,
          )
        }

        log.info("poll: checking tasks", {
          runnableCount: runnableTasks.length,
          activeCount: state.activeTasks.size,
          launchedCount: state.launchedTaskIds.size,
          maxConcurrent,
          runnableIds: runnableTasks.map((t) => t.id),
          activeIds: Array.from(state.activeTasks.keys()),
        })

        // Launch new task agents with stagger (respecting max concurrent limit)
        let launchedThisPoll = 0
        for (const task of runnableTasks) {
          if (!state.running) break
          if (state.activeTasks.has(task.id)) {
            log.info("poll: skipping task, already active", { taskId: task.id })
            continue
          }

          // Never re-launch a task that was already launched
          if (state.launchedTaskIds.has(task.id)) {
            log.warn("poll: skipping task, already launched previously", { taskId: task.id })
            continue
          }

          // Check max concurrent limit
          if (state.activeTasks.size >= maxConcurrent) {
            log.info("poll: max concurrent tasks reached", { maxConcurrent, activeCount: state.activeTasks.size })
            break
          }

          // Check if we should stagger
          if (state.activeTasks.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, staggerSeconds * 1000))
          }

          if (!state.running) break

          // Launch the task
          await launchTask(task)
          launchedThisPoll++
        }

        // Log waiting status if we didn't launch anything new
        if (launchedThisPoll === 0 && state.activeTasks.size > 0) {
          const activeTaskIds = Array.from(state.activeTasks.keys())
          const pendingTasks = taskList.tasks.filter((t) => t.status === "todo" && !state!.activeTasks.has(t.id))
          const waitingOnDeps = pendingTasks.filter((t) => {
            if (!t.dependencies || t.dependencies.length === 0) return false
            return t.dependencies.some((depId) => {
              const dep = taskList.tasks.find((d) => d.id === depId)
              return dep && dep.status !== "done"
            })
          })

          if (state.activeTasks.size >= maxConcurrent && pendingTasks.length > 0) {
            // At capacity with more work waiting
            await logStatus(
              `waiting-capacity-${activeTaskIds.sort().join(",")}`,
              `**Waiting for task slot** (${state.activeTasks.size}/${maxConcurrent} running)\n\n` +
                `Active: ${activeTaskIds.join(", ")}\n` +
                `Queued: ${pendingTasks.length} task${pendingTasks.length === 1 ? "" : "s"} waiting`,
            )
          } else if (waitingOnDeps.length > 0 && pendingTasks.length === waitingOnDeps.length) {
            // All remaining tasks are blocked by dependencies
            const depInfo = waitingOnDeps
              .slice(0, 3)
              .map((t) => `${t.id} → needs ${t.dependencies!.join(", ")}`)
              .join("\n")
            await logStatus(
              `waiting-deps-${activeTaskIds.sort().join(",")}`,
              `**Waiting for dependencies**\n\n` +
                `Active: ${activeTaskIds.join(", ")}\n` +
                `Blocked:\n${depInfo}${waitingOnDeps.length > 3 ? `\n...and ${waitingOnDeps.length - 3} more` : ""}`,
            )
          } else if (pendingTasks.length === 0) {
            // No pending tasks, just waiting for active ones to finish
            await logStatus(
              `waiting-completion-${activeTaskIds.sort().join(",")}`,
              `**Waiting for tasks to complete**\n\n` + `Active: ${activeTaskIds.join(", ")}`,
            )
          }
        }
      } catch (err) {
        log.error("poll error", { error: err })
      } finally {
        if (state) {
          state.pollInProgress = false
        }
      }
    }

    // Initial poll
    await poll()

    // Start polling
    if (state) {
      state.pollInterval = setInterval(poll, pollIntervalMs)
    }
  }

  async function launchTask(task: TaskList.TaskEntry): Promise<void> {
    if (!state) return

    const taskFilePath = task.file
      ? TaskFile.getFilePath(state.paths.tasksDir, task.file.replace(".md", ""))
      : TaskFile.getFilePath(state.paths.tasksDir, task.id)

    // Read task file for full description
    const taskFile = await TaskFile.read(taskFilePath)
    const description = taskFile?.description ?? task.title

    log.info("launching task", { taskId: task.id, title: task.title })

    // Build context for why this task is being launched
    const depsInfo = task.dependencies?.length
      ? `Dependencies satisfied: ${task.dependencies.join(", ")}`
      : "No dependencies"

    await logAction(
      `**Launching task ${task.id}:** ${task.title}\n\n` +
        `${depsInfo}\n\n` +
        `_Starting autonomous sub-agent to work on this task..._`,
    )

    const promise = TaskAgent.run({
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: description,
      taskFilePath,
      paths: state.paths,
      parentSessionId: state.parentSessionId,
    })

    state.activeTasks.set(task.id, { sessionId: "", promise })
    state.launchedTaskIds.add(task.id) // Track that this task was launched (prevents re-launching)

    // Save state after launching task
    await saveState()

    // Handle completion
    promise
      .then(async (result) => {
        if (state) {
          state.activeTasks.delete(task.id)
          state.lastStatusMessage = undefined // Clear so next status update shows new state

          // Aggregate stats from task result
          if (result.stats) {
            state.stats.inputTokens += result.stats.inputTokens
            state.stats.outputTokens += result.stats.outputTokens
            state.stats.cost += result.stats.cost ?? 0
            for (const file of result.stats.modifiedFiles) {
              state.stats.modifiedFiles.add(file)
            }
          }

          await saveState() // Save state after task completes
        }
        log.info("task finished", { taskId: task.id, success: result.success, stats: result.stats })
        if (result.success) {
          await logAction(`**Task ${task.id} completed** ✓`)
        } else {
          await logAction(`**Task ${task.id} failed:** ${result.error ?? "Unknown error"}`)
        }
      })
      .catch(async (err) => {
        if (state) {
          state.activeTasks.delete(task.id)
          state.lastStatusMessage = undefined // Clear so next status update shows new state
          await saveState() // Save state after task errors
        }
        log.error("task error", { taskId: task.id, error: err })
        await logAction(`**Task ${task.id} failed:** ${err.message ?? err}`)
      })
  }

  // Recovery functions

  export async function cleanupStaleLocks(maxAgeMs: number = 60000): Promise<number> {
    // This would clean up locks older than maxAgeMs
    // For now, the Lock utility handles this via file-based locking
    log.info("cleanup stale locks", { maxAgeMs })
    return 0
  }

  export async function detectOrphanedTasks(): Promise<TaskList.TaskEntry[]> {
    if (!state) return []

    const taskList = await TaskList.read(state.paths.taskListPath)
    if (!taskList) return []

    const orphaned: TaskList.TaskEntry[] = []

    for (const task of taskList.tasks) {
      if (task.status === "in-progress" && !state.activeTasks.has(task.id)) {
        orphaned.push(task)
      }
    }

    return orphaned
  }

  export async function recoverOrphanedTasks(): Promise<void> {
    const orphaned = await detectOrphanedTasks()

    if (orphaned.length === 0) return

    log.info("recovering orphaned tasks", { count: orphaned.length })

    if (!state) return

    await TaskList.update(state.paths.taskListPath, state.paths.lockPath, (current) => {
      let updated = current
      for (const task of orphaned) {
        updated = TaskList.updateTask(updated, task.id, {
          status: "error",
          assignee: undefined,
        })
      }
      return updated
    })
  }

  // Get completion stats (from memory if running, from persisted state if stopped)
  export async function getCompletionStats(paths: TaskList.Paths): Promise<{
    startedAt?: number
    completedAt?: number
    durationMs?: number
    inputTokens: number
    outputTokens: number
    cost: number
    modifiedFiles: string[]
  } | null> {
    // First check runtime state
    if (state) {
      const durationMs = state.completedAt ? state.completedAt - state.startedAt : Date.now() - state.startedAt
      return {
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        durationMs,
        inputTokens: state.stats.inputTokens,
        outputTokens: state.stats.outputTokens,
        cost: state.stats.cost,
        modifiedFiles: Array.from(state.stats.modifiedFiles),
      }
    }

    // Fall back to persisted state
    const persisted = await loadState(paths)
    if (!persisted?.stats) return null

    const durationMs = persisted.completedAt ? persisted.completedAt - persisted.startedAt : undefined

    return {
      startedAt: persisted.startedAt,
      completedAt: persisted.completedAt,
      durationMs,
      inputTokens: persisted.stats.inputTokens,
      outputTokens: persisted.stats.outputTokens,
      cost: persisted.stats.cost ?? 0,
      modifiedFiles: persisted.stats.modifiedFiles,
    }
  }

  // Archive completed task folder
  export async function archive(paths: TaskList.Paths, taskListTitle?: string): Promise<string> {
    const taskDir = path.dirname(paths.taskListPath)
    const archiveDir = path.join(Instance.directory, ".opencode", "tasks", "archived")
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const safeName = (taskListTitle ?? "task-list").replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 50)
    const archiveName = `${safeName}-${timestamp}`
    const archivePath = path.join(archiveDir, archiveName)

    // Create archive directory
    await fs.mkdir(archiveDir, { recursive: true })

    // Move task folder to archive
    await fs.rename(taskDir, archivePath)

    log.info("task folder archived", { from: taskDir, to: archivePath })

    // Clear orchestrator state file if it exists (it would have been moved)
    if (state) {
      state = null
    }

    return archivePath
  }

  // Get unified diff of all modified files
  export async function getUnifiedDiff(modifiedFiles: string[]): Promise<string> {
    const { execSync } = await import("child_process")
    const diffs: string[] = []

    for (const file of modifiedFiles) {
      try {
        // Try git diff HEAD first (for committed repos)
        const diff = execSync(`git diff HEAD -- "${file}"`, {
          cwd: Instance.directory,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        })
        if (diff.trim()) {
          diffs.push(diff)
        }
      } catch {
        // HEAD might not exist (new repo) - try diff against empty tree or just show file content
        try {
          // Try showing staged changes
          const stagedDiff = execSync(`git diff --cached -- "${file}"`, {
            cwd: Instance.directory,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          })
          if (stagedDiff.trim()) {
            diffs.push(stagedDiff)
            continue
          }

          // Try showing unstaged changes
          const unstagedDiff = execSync(`git diff -- "${file}"`, {
            cwd: Instance.directory,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          })
          if (unstagedDiff.trim()) {
            diffs.push(unstagedDiff)
            continue
          }

          // For new untracked files, show the content as an addition
          const status = execSync(`git status --porcelain -- "${file}"`, {
            cwd: Instance.directory,
            encoding: "utf-8",
          })
          if (status.startsWith("??") || status.startsWith("A ")) {
            // File is untracked or newly added - show as new file diff
            const content = execSync(`cat "${file}"`, {
              cwd: Instance.directory,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
            })
            const lines = content.split("\n")
            const diffLines = [
              `diff --git a/${file} b/${file}`,
              `new file mode 100644`,
              `--- /dev/null`,
              `+++ b/${file}`,
              `@@ -0,0 +1,${lines.length} @@`,
              ...lines.map((line) => `+${line}`),
            ]
            diffs.push(diffLines.join("\n"))
          }
        } catch {
          // File might not exist or other error - skip
        }
      }
    }

    return diffs.join("\n")
  }
}
