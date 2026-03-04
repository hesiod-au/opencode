import { Log } from "../util/log"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { SessionPrompt } from "../session/prompt"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Bus } from "../bus"
import { File } from "../file"
import { TaskList } from "./task-list"
import { TaskFile } from "./task-file"
import { TaskModeEvent } from "./events"
import { Collision } from "./collision"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { spawn } from "child_process"
import path from "path"
import fs from "fs/promises"

export namespace TaskAgent {
  const log = Log.create({ service: "task-agent" })

  // Track pause info for tasks (stored when pause() is called)
  interface PauseInfo {
    collidingTaskId?: string
    collidingFile?: string
    reason: string
  }
  const pauseInfoMap = new Map<string, PauseInfo>()

  // Track modified files per task
  const modifiedFilesMap = new Map<string, Set<string>>()

  function trackModifiedFile(taskId: string, filePath: string): void {
    if (!modifiedFilesMap.has(taskId)) {
      modifiedFilesMap.set(taskId, new Set())
    }
    modifiedFilesMap.get(taskId)!.add(filePath)
  }

  function getModifiedFiles(taskId: string): string[] {
    return Array.from(modifiedFilesMap.get(taskId) ?? [])
  }

  function clearModifiedFiles(taskId: string): void {
    modifiedFilesMap.delete(taskId)
  }

  async function saveAttemptLog(
    taskId: string,
    attempt: number,
    testOutput: string,
    modifiedFiles: string[],
    tasksDir: string,
  ): Promise<void> {
    try {
      const logsDir = path.join(tasksDir, "..", "logs", taskId)
      await fs.mkdir(logsDir, { recursive: true })

      const timestamp = new Date().toISOString()
      const content = [
        `# Attempt ${attempt} — ${timestamp}`,
        "",
        "## Modified Files",
        "",
        ...modifiedFiles.map((f) => `- ${f}`),
        "",
        "## Test Output",
        "",
        "```",
        testOutput,
        "```",
        "",
      ].join("\n")

      const logPath = path.join(logsDir, `attempt-${attempt}.log`)
      await fs.writeFile(logPath, content, "utf-8")
      log.info("saved attempt log", { taskId, attempt, logPath })
    } catch (err) {
      log.warn("failed to save attempt log", { taskId, attempt, error: err })
    }
  }

  // Compute session stats from message parts
  async function computeSessionStats(
    sessionId: string,
  ): Promise<{ inputTokens: number; outputTokens: number; cost: number }> {
    const messages = await Session.messages({ sessionID: sessionId, includeCompacted: true })
    let inputTokens = 0
    let outputTokens = 0
    let cost = 0

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "step-finish") {
          const stepPart = part as MessageV2.StepFinishPart
          inputTokens += stepPart.tokens.input + stepPart.tokens.cache.read
          outputTokens += stepPart.tokens.output + stepPart.tokens.reasoning
          cost += stepPart.cost
        }
      }
    }

    return { inputTokens, outputTokens, cost }
  }

  function getPauseInfo(taskId: string): PauseInfo | undefined {
    return pauseInfoMap.get(taskId)
  }

  function setPauseInfo(taskId: string, info: PauseInfo): void {
    pauseInfoMap.set(taskId, info)
  }

  function clearPauseInfo(taskId: string): void {
    pauseInfoMap.delete(taskId)
  }

  // TDD Mode: Test running functions
  export interface TestRunResult {
    success: boolean
    output: string
    failedTests: string[]
    couldNotRun?: boolean // True if test runner couldn't be started (not a test failure)
  }

  export async function runTaskTests(
    tests: string[],
    testFramework?: TaskList.TestFrameworkInfo,
  ): Promise<TestRunResult> {
    if (tests.length === 0) {
      return { success: true, output: "No tests to run", failedTests: [] }
    }

    let command: string[]

    // Use test framework info if available (from test-writer agent)
    if (testFramework?.runCommand) {
      const baseCommand = testFramework.runCommand.split(" ")
      command = [...baseCommand]

      // Add test name filter based on framework
      // pytest -k uses "or" keyword, not "|" which causes "Wrong expression passed to '-k'"
      const framework = testFramework.framework.toLowerCase()
      if (framework.includes("pytest")) {
        command.push("-k", tests.join(" or "))
      } else if (framework.includes("bun")) {
        command.push("--test-name-pattern", tests.join("|"))
      } else if (framework.includes("vitest")) {
        command.push("-t", tests.join("|"))
      } else if (framework.includes("jest")) {
        command.push("-t", tests.join("|"))
      } else if (framework.includes("go") || framework === "testing") {
        command.push("-run", tests.join("|"))
      } else {
        // For unknown frameworks, try to append the test pattern
        command.push(tests.join("|"))
      }

      log.info("using test framework from task list", { testFramework, command })
    } else {
      // Fallback: Detect test runner based on project files
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

      if (hasPytest || hasPyprojectToml) {
        // Python project - use pytest (-k uses "or" keyword, not "|")
        command = ["pytest", "-v", "-k", tests.join(" or ")]
      } else if (hasBunLock || hasPackageJson) {
        // JavaScript/TypeScript project - use bun test
        command = ["bun", "test", "--test-name-pattern", tests.join("|")]
      } else {
        // Cannot determine test runner
        log.warn("could not determine test runner", { tests })
        return {
          success: false,
          output:
            "Could not determine how to run tests. No test framework info was provided and no recognized test configuration files were found.",
          failedTests: tests,
          couldNotRun: true,
        }
      }

      log.info("detected test runner from project files", { command })
    }

    log.info("running tests", { command, tests })

    return new Promise((resolve) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: Instance.directory,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (data) => {
        stdout += data.toString()
      })

      proc.stderr.on("data", (data) => {
        stderr += data.toString()
      })

      proc.on("close", (code) => {
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : "")
        const success = code === 0

        // Parse failed tests from output
        const failedTests: string[] = []
        if (!success) {
          for (const test of tests) {
            // Check if test name appears in failure context
            if (output.includes(`FAIL`) && output.includes(test)) {
              failedTests.push(test)
            }
          }
          // If we couldn't parse specific failures, assume all failed
          if (failedTests.length === 0 && tests.length > 0) {
            failedTests.push(...tests)
          }
        }

        log.info("test run completed", { success, code, failedTests })
        resolve({ success, output, failedTests })
      })

      proc.on("error", (err) => {
        log.error("test runner failed to start", { error: err })
        resolve({
          success: false,
          output: `Failed to start test runner "${command[0]}": ${err.message}. The test runner may not be installed.`,
          failedTests: tests,
          couldNotRun: true,
        })
      })
    })
  }

  export function buildTestFixPrompt(
    taskId: string,
    taskDescription: string,
    failedTests: string[],
    testOutput: string,
    guardrails?: string,
  ): string {
    let prompt = `# Test Failures for Task ${taskId}

The following tests are failing and need to be fixed:

**Failed tests:** ${failedTests.join(", ")}

## Test Output

\`\`\`
${testOutput.slice(0, 5000)}${testOutput.length > 5000 ? "\n... (truncated)" : ""}
\`\`\`

## Original Task Description

${taskDescription}

---

Please fix the implementation to make these tests pass. Do not modify the tests themselves - only fix the implementation code.

Important:
- Analyze the test failures carefully
- Fix only what's necessary to make the tests pass
- Do not over-engineer or add unrelated changes
- After fixing, the tests should pass
`
    if (guardrails) {
      prompt += `
---

## Project Guardrails

\`\`\`
${guardrails}
\`\`\`
`
    }
    return prompt
  }

  export interface TaskAgentOptions {
    taskId: string
    taskTitle: string
    taskDescription: string
    taskFilePath: string
    paths: TaskList.Paths
    parentSessionId?: string
    agent?: string
    model?: { providerID: string; modelID: string }
    disabledTools?: Record<string, false>
  }

  export interface TaskAgentResult {
    success: boolean
    sessionId: string
    comments?: string
    error?: string
    stats?: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
  }

  export async function run(options: TaskAgentOptions): Promise<TaskAgentResult> {
    const { taskId, taskTitle, taskDescription, taskFilePath, paths, parentSessionId, agent: agentName } = options

    log.info("starting task agent", { taskId, taskTitle })

    // Create session for this task as child of parent session (will be grouped under parent in UI)
    const session = await Session.create({
      parentID: parentSessionId,
      title: `Task ${taskId}: ${taskTitle}`,
    })

    // Set session status to busy
    SessionStatus.set(session.id, { type: "busy" })

    // Claim the task (update status to in-progress)
    try {
      await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
        TaskList.updateTask(current, taskId, {
          status: "in-progress",
          assignee: session.id,
        }),
      )

      // Update task file with session info
      const taskFile = await TaskFile.read(taskFilePath)
      if (taskFile) {
        await TaskFile.write(taskFilePath, {
          ...taskFile,
          status: "in-progress",
          sessionId: session.id,
          startedAt: new Date().toISOString(),
        })
      }

      // Register task context for collision detection in Edit tool
      Collision.registerTaskSession(session.id, {
        taskId,
        taskTitle,
        paths,
      })

      Bus.publish(TaskModeEvent.TaskStarted, {
        taskId,
        title: taskTitle,
        sessionId: session.id,
      })
    } catch (err) {
      log.error("failed to claim task", { taskId, error: err })
      return {
        success: false,
        sessionId: session.id,
        error: `Failed to claim task: ${err}`,
      }
    }

    // Track test attempts across try/catch for task file
    let totalTestAttempts = 0

    // Execute the task with retry on pause
    try {
      const agentToUse = agentName ?? "build"
      const agent = await Agent.get(agentToUse)

      if (!agent) {
        throw new Error(`Agent not found: ${agentToUse}`)
      }

      // Use the agent's configured model, or fall back to OpenAI's gpt-5.2-codex
      const model = options.model ?? agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      // Read config once for guardrails and other settings
      const config = await Config.get()
      const guardrails = config.taskMode?.taskPromptGuardrails

      let comments: string | undefined
      let retryCount = 0
      const maxRetries = 10
      const retryDelayMs = 5000

      // Retry loop for handling pauses due to file collisions
      while (retryCount < maxRetries) {
        const messageID = Identifier.ascending("message")

        // Build prompt with task context (include retry info if this is a retry)
        const prompt =
          retryCount === 0
            ? buildTaskPrompt(taskId, taskTitle, taskDescription, guardrails)
            : buildTaskPrompt(taskId, taskTitle, taskDescription, guardrails) +
              `\n\n---\n\n**Note:** This is retry attempt ${retryCount}. A previous attempt was paused due to a file collision. The blocking file should now be available. Please continue with your task.`

        const result = await SessionPrompt.prompt({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.name,
          // Disable question tool and workflow tools - sub-tasks should work autonomously
          tools: { question: false, ...options.disabledTools },
          parts: [{ type: "text", text: prompt }],
        })

        // Check if the task was paused due to a collision
        const taskList = await TaskList.read(paths.taskListPath)
        const currentTask = taskList ? TaskList.getTask(taskList, taskId) : undefined

        if (currentTask?.status === "paused") {
          // Task was paused during execution - wait for the blocking file to be released
          log.info("task paused due to collision, waiting for file to be released", {
            taskId,
            retryCount,
          })

          // Get the collision info from the pause event (stored in collision module)
          const pauseInfo = getPauseInfo(taskId)

          // Wait for the blocking file to be released
          let released = false
          const waitStartTime = Date.now()
          const maxWaitTime = 60000 // 1 minute max wait

          while (!released && Date.now() - waitStartTime < maxWaitTime) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs))

            // Check if the file is still reserved by the blocking task
            if (pauseInfo?.collidingFile) {
              const reservations = Collision.getAllReservations()
              const blockingReservations = reservations.get(pauseInfo.collidingTaskId ?? "")
              if (!blockingReservations || !blockingReservations.includes(pauseInfo.collidingFile)) {
                released = true
                log.info("blocking file released, resuming task", {
                  taskId,
                  file: pauseInfo.collidingFile,
                })
              }
            } else {
              // No specific file info, just wait and retry
              released = true
            }
          }

          if (!released) {
            log.warn("timeout waiting for blocking file, retrying anyway", { taskId })
          }

          // Set task back to in-progress and retry
          await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
            TaskList.updateTask(current, taskId, {
              status: "in-progress",
            }),
          )

          clearPauseInfo(taskId)
          retryCount++
          continue
        }

        // Task completed successfully (not paused)
        comments =
          result.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n\n") || undefined

        break
      }

      if (retryCount >= maxRetries) {
        throw new Error(`Task exceeded maximum retry attempts (${maxRetries}) due to file collisions`)
      }

      // TDD Mode: Run tests if any are assigned to this task
      const taskFileForTests = await TaskFile.read(taskFilePath)
      if (taskFileForTests?.tests && taskFileForTests.tests.length > 0) {
        log.info("running assigned tests before completion", { taskId, tests: taskFileForTests.tests })

        // Get test framework info from task list
        const taskListForFramework = await TaskList.read(paths.taskListPath)
        const testFramework = taskListForFramework?.testFramework

        const maxTestRetries = config.taskMode?.maxTestRetries ?? 10
        const tasksDir = path.dirname(taskFilePath)
        let testRetryCount = 0
        let testsPass = false
        let testsCouldNotRun = false

        while (!testsPass && !testsCouldNotRun && testRetryCount < maxTestRetries) {
          const testResult = await runTaskTests(taskFileForTests.tests, testFramework)

          // Save per-attempt log
          const attemptModifiedFiles = Collision.getReservationsForTask(taskId)
          await saveAttemptLog(taskId, testRetryCount + 1, testResult.output, attemptModifiedFiles, tasksDir)

          // If tests couldn't run (e.g., test runner not found), don't fail the task
          if (testResult.couldNotRun) {
            log.warn("tests could not be run, skipping test verification", { taskId, output: testResult.output })
            testsCouldNotRun = true
            comments =
              (comments ? comments + "\n\n" : "") +
              `⚠️ Tests could not be run automatically: ${testResult.output}\nPlease run tests manually to verify.`
            break
          }

          if (testResult.success) {
            testsPass = true
            log.info("all tests passed", { taskId })
            comments = (comments ? comments + "\n\n" : "") + "All assigned tests passed."
          } else {
            testRetryCount++
            log.info("tests failed, attempting fix", {
              taskId,
              retryCount: testRetryCount,
              failedTests: testResult.failedTests,
            })

            if (testRetryCount < maxTestRetries) {
              // Send test failure to agent for fixing
              const fixMessageID = Identifier.ascending("message")
              const fixPrompt = buildTestFixPrompt(
                taskId,
                taskDescription,
                testResult.failedTests,
                testResult.output,
                guardrails,
              )

              await SessionPrompt.prompt({
                messageID: fixMessageID,
                sessionID: session.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                agent: agent.name,
                tools: { question: false, ...options.disabledTools },
                parts: [{ type: "text", text: fixPrompt }],
              })
            }
          }
        }

        if (!testsPass && !testsCouldNotRun) {
          // Fresh-process verification: one final clean test run before failing
          log.info("running final fresh-process verification", { taskId })
          const freshResult = await runTaskTests(taskFileForTests.tests, testFramework)
          const freshAttemptModifiedFiles = Collision.getReservationsForTask(taskId)
          await saveAttemptLog(
            taskId,
            testRetryCount + 1,
            `[FRESH VERIFICATION]\n${freshResult.output}`,
            freshAttemptModifiedFiles,
            tasksDir,
          )

          if (freshResult.success) {
            testsPass = true
            testRetryCount++ // count the fresh run
            log.info("tests passed on final fresh verification", { taskId })
            comments =
              (comments ? comments + "\n\n" : "") + "Tests passed on final fresh verification (after retry exhaustion)."
          } else {
            // Tests truly failed — include fresh output in error
            throw new Error(
              `Tests failed after ${maxTestRetries} fix attempts (+ fresh verification). Failed tests: ${taskFileForTests.tests.join(", ")}\n\nFresh verification output:\n${freshResult.output.slice(0, 3000)}`,
            )
          }
        }

        // Store final attempt count for the task file
        totalTestAttempts = testRetryCount
      }

      // Mark task as done
      await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
        TaskList.updateTask(current, taskId, {
          status: "done",
        }),
      )

      // Update task file
      const taskFile = await TaskFile.read(taskFilePath)
      if (taskFile) {
        await TaskFile.write(taskFilePath, {
          ...taskFile,
          status: "done",
          completedAt: new Date().toISOString(),
          comments,
          ...(totalTestAttempts > 0 ? { attemptCount: totalTestAttempts } : {}),
        })
      }

      // Get modified files before releasing reservations
      const modifiedFiles = Collision.getReservationsForTask(taskId)

      // Compute session stats
      const sessionStats = await computeSessionStats(session.id)
      const stats = {
        ...sessionStats,
        modifiedFiles,
      }

      // Release all file reservations and unregister task session
      await Collision.releaseAllForTask(taskId)
      Collision.unregisterTaskSession(session.id)

      Bus.publish(TaskModeEvent.TaskCompleted, {
        taskId,
        title: taskTitle,
        sessionId: session.id,
        comments,
      })

      log.info("task completed", { taskId, sessionId: session.id, stats })

      // Set session status to idle
      SessionStatus.set(session.id, { type: "idle" })

      return {
        success: true,
        sessionId: session.id,
        comments,
        stats,
      }
    } catch (err: any) {
      log.error("task failed", { taskId, error: err })

      // Mark task as error
      await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
        TaskList.updateTask(current, taskId, {
          status: "error",
        }),
      ).catch(() => {})

      // Update task file
      const taskFile = await TaskFile.read(taskFilePath).catch(() => null)
      if (taskFile) {
        await TaskFile.write(taskFilePath, {
          ...taskFile,
          status: "error",
          comments: `Error: ${err.message || err}`,
          ...(totalTestAttempts > 0 ? { attemptCount: totalTestAttempts } : {}),
        }).catch(() => {})
      }

      // Get modified files before releasing reservations
      const modifiedFiles = Collision.getReservationsForTask(taskId)

      // Compute session stats (may fail if session errored early)
      const sessionStats = await computeSessionStats(session.id).catch(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      }))
      const stats = {
        ...sessionStats,
        modifiedFiles,
      }

      // Release file reservations and unregister task session
      await Collision.releaseAllForTask(taskId)
      Collision.unregisterTaskSession(session.id)

      Bus.publish(TaskModeEvent.TaskError, {
        taskId,
        title: taskTitle,
        sessionId: session.id,
        error: err.message || String(err),
      })

      // Set session status to idle
      SessionStatus.set(session.id, { type: "idle" })

      return {
        success: false,
        sessionId: session.id,
        error: err.message || String(err),
        stats,
      }
    }
  }

  export async function pause(
    taskId: string,
    paths: TaskList.Paths,
    reason: string,
    collidingTaskId?: string,
    collidingFile?: string,
  ): Promise<void> {
    // Store pause info for the retry loop to use
    setPauseInfo(taskId, {
      reason,
      collidingTaskId,
      collidingFile,
    })

    await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
      TaskList.updateTask(current, taskId, {
        status: "paused",
      }),
    )

    const taskList = await TaskList.read(paths.taskListPath)
    const task = taskList ? TaskList.getTask(taskList, taskId) : undefined

    Bus.publish(TaskModeEvent.TaskPaused, {
      taskId,
      title: task?.title ?? taskId,
      sessionId: task?.assignee ?? "",
      reason,
      collidingTaskId,
      collidingFile,
    })

    log.info("task paused", { taskId, reason, collidingTaskId, collidingFile })
  }

  function buildTaskPrompt(taskId: string, title: string, description: string, guardrails?: string): string {
    let prompt = `# Task ${taskId}: ${title}

${description}

---

Please complete this task. When you're done, provide a brief summary of what was accomplished.

Important:
- You are an autonomous sub-task agent - work independently without asking questions
- Make reasonable decisions when encountering ambiguity - choose the most sensible approach
- Focus only on this specific task
- Do not modify files that are not related to this task
- If you encounter a blocking issue that truly cannot be resolved, report it in your summary
- Do NOT ask the user for clarification - figure it out yourself or make a reasonable assumption
`
    if (guardrails) {
      prompt += `
---

## Project Guardrails

\`\`\`
${guardrails}
\`\`\`
`
    }
    return prompt
  }
}
