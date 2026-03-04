import { Log } from "../util/log"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { TaskList } from "./task-list"
import { TaskFile } from "./task-file"
import { TaskModeEvent } from "./events"
import { Instance } from "../project/instance"
import { WorkflowStore } from "../workflow/store"
import { spawn, execSync } from "child_process"
import fs from "fs/promises"
import path from "path"

export namespace TestWriterAgent {
  const log = Log.create({ service: "test-writer-agent" })

  async function logToParent(parentSessionId: string | undefined, text: string): Promise<void> {
    if (!parentSessionId) {
      log.warn("logToParent called but no parentSessionId", { text: text.slice(0, 50) })
      return
    }

    try {
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")

      await Session.updateMessage({
        id: messageID,
        sessionID: parentSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "test-writer",
        model: { providerID: "system", modelID: "test-writer-agent" },
      })

      await Session.updatePart({
        id: partID,
        sessionID: parentSessionId,
        messageID,
        type: "text",
        text,
      })

      log.info("logToParent: message created successfully", { messageID })
    } catch (err) {
      log.error("logToParent failed", { error: err, text: text.slice(0, 50) })
    }
  }

  export interface TestWriterOptions {
    paths: TaskList.Paths
    parentSessionId?: string
    runId?: string
    planningConversation: string
    disabledTools?: Record<string, false>
  }

  export interface TestWriterResult {
    success: boolean
    sessionId: string
    tasksWithTests: number
    testFramework?: TestFrameworkInfo
    frameworkWarning?: string // Warning if framework couldn't be installed
    skipTests?: boolean // True if user chose to skip testing
    error?: string
  }

  export interface TestFrameworkInfo {
    language: string // e.g., "typescript", "python", "go"
    framework: string // e.g., "bun:test", "pytest", "vitest", "jest"
    runCommand?: string // e.g., "bun test", "pytest -v"
  }

  export interface TestMapping {
    taskId: string
    tests: string[]
  }

  export async function run(options: TestWriterOptions): Promise<TestWriterResult> {
    const { paths, parentSessionId, planningConversation, runId } = options

    log.info("starting test-writer agent", { taskListPath: paths.taskListPath })

    // Create a new session for test writing
    const session = await Session.create({
      parentID: parentSessionId,
      title: "Test Writing Session",
    })
    if (runId) {
      await WorkflowStore.linkSession({
        runId,
        sessionId: session.id,
        workflowId: "task",
        role: "child",
        parentSessionId,
      })
    }

    // Set session status to busy
    SessionStatus.set(session.id, { type: "busy" })

    // Read all tasks
    const taskList = await TaskList.read(paths.taskListPath)
    if (!taskList || taskList.tasks.length === 0) {
      SessionStatus.set(session.id, { type: "idle" })
      return {
        success: false,
        sessionId: session.id,
        tasksWithTests: 0,
        error: "No tasks found to write tests for",
      }
    }

    // Read task descriptions
    const taskDescriptions: Array<{ id: string; title: string; description: string }> = []
    for (const task of taskList.tasks) {
      const taskFilePath = TaskFile.getFilePath(paths.tasksDir, task.id)
      const taskFile = await TaskFile.read(taskFilePath)
      if (taskFile) {
        taskDescriptions.push({
          id: task.id,
          title: task.title,
          description: taskFile.description,
        })
      }
    }

    Bus.publish(TaskModeEvent.TestWritingStarted, {
      sessionId: session.id,
      taskCount: taskDescriptions.length,
    })

    await logToParent(parentSessionId, `**Starting test writing for ${taskDescriptions.length} tasks...**`)

    try {
      const agent = await Agent.get("build")

      if (!agent) {
        throw new Error("Build agent not found")
      }

      const messageID = Identifier.ascending("message")
      const prompt = buildTestWriterPrompt(planningConversation, taskDescriptions)

      const model = agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        variant: "max",
        tools: { question: false, ...options.disabledTools },
        parts: [{ type: "text", text: prompt }],
      })

      // Parse test mappings from response
      const responseText = result.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n\n")

      const { taskMappings, e2eTest, testFramework } = parseTestMappings(responseText)

      // Update task files with test assignments
      let tasksWithTests = 0
      for (const mapping of taskMappings) {
        if (mapping.tests.length > 0) {
          const taskFilePath = TaskFile.getFilePath(paths.tasksDir, mapping.taskId)
          const taskFile = await TaskFile.read(taskFilePath)
          if (taskFile) {
            await TaskFile.write(taskFilePath, {
              ...taskFile,
              tests: mapping.tests,
            })
            tasksWithTests++
            log.info("updated task with tests", { taskId: mapping.taskId, tests: mapping.tests })
          }
        }
      }

      // Check if test framework is installed and install if needed
      let frameworkWarning: string | undefined
      let finalTestFramework = testFramework

      if (testFramework) {
        const frameworkCheck = await ensureTestFrameworkInstalled(testFramework, parentSessionId)

        if (frameworkCheck.userActionRequired) {
          log.warn("test framework requires user action", { message: frameworkCheck.message })
          frameworkWarning = frameworkCheck.message

          await logToParent(
            parentSessionId,
            `⚠️ **Test framework issue:**\n\n${frameworkCheck.message}\n\n` +
              `You can:\n` +
              `1. Install the test framework manually and re-run\n` +
              `2. Update the task list with the correct framework info\n` +
              `3. Continue without automated testing (tests will need to be run manually)`,
          )
        } else if (frameworkCheck.installedSuccessfully) {
          // Update run command for Python venv if needed
          if (
            testFramework.language.toLowerCase() === "python" &&
            testFramework.framework.toLowerCase().includes("pytest")
          ) {
            finalTestFramework = {
              ...testFramework,
              runCommand: ".venv/bin/pytest -v",
            }
            log.info("updated test framework run command for venv", { runCommand: finalTestFramework.runCommand })
          }
        }
      }

      // Save E2E test and test framework info to task list
      if (e2eTest || finalTestFramework) {
        await TaskList.update(paths.taskListPath, paths.lockPath, (current) => ({
          ...current,
          ...(e2eTest && { e2eTest }),
          ...(finalTestFramework && { testFramework: finalTestFramework }),
        }))
        log.info("saved test info to task list", { e2eTest, testFramework: finalTestFramework })
      }

      Bus.publish(TaskModeEvent.TestWritingCompleted, {
        sessionId: session.id,
        tasksWithTests,
      })

      const testSummary = taskMappings
        .filter((m) => m.tests.length > 0)
        .map((m) => `- **${m.taskId}**: ${m.tests.join(", ")}`)
        .join("\n")

      const e2eSummary = e2eTest ? `\n\n**E2E Test:** ${e2eTest}` : ""
      const frameworkSummary = finalTestFramework
        ? `\n\n**Framework:** ${finalTestFramework.language}/${finalTestFramework.framework}${finalTestFramework.runCommand ? ` (${finalTestFramework.runCommand})` : ""}`
        : ""

      await logToParent(
        parentSessionId,
        `**Test writing completed** \n\nAssigned tests to ${tasksWithTests} tasks:\n\n${testSummary || "No test mappings found."}${e2eSummary}${frameworkSummary}`,
      )

      log.info("test writing completed", {
        sessionId: session.id,
        tasksWithTests,
        e2eTest,
        testFramework: finalTestFramework,
        mappings: taskMappings,
        frameworkWarning,
      })

      // Set session status to idle
      SessionStatus.set(session.id, { type: "idle" })

      return {
        success: true,
        sessionId: session.id,
        tasksWithTests,
        testFramework: finalTestFramework,
        frameworkWarning,
      }
    } catch (err: any) {
      log.error("test writing failed", { error: err })

      await logToParent(parentSessionId, `**Test writing failed:** ${err.message || String(err)}`)

      // Set session status to idle
      SessionStatus.set(session.id, { type: "idle" })

      return {
        success: false,
        sessionId: session.id,
        tasksWithTests: 0,
        error: err.message || String(err),
      }
    }
  }

  export function buildTestWriterPrompt(
    planningConversation: string,
    tasks: Array<{ id: string; title: string; description: string }>,
  ): string {
    const taskList = tasks
      .map(
        (t) => `### Task ${t.id}: ${t.title}

${t.description}`,
      )
      .join("\n\n")

    return `You are a test-driven development (TDD) agent. Your job is to write tests for a planned feature before implementation begins.

## Planning Context

The following conversation led to this task breakdown:

${planningConversation}

## Tasks to Write Tests For

${taskList}

## Instructions

1. Analyze the tasks and understand what each one needs to accomplish
2. For each task, write one or more test functions that will verify the task was completed correctly
3. Create test files following the project's testing conventions (look for existing test files for patterns)
4. Use descriptive test names that clearly indicate what is being tested
5. **IMPORTANT: Create a final end-to-end (E2E) test** that verifies the entire feature works as a whole

After writing the tests, output a mapping of task IDs to test function names in this exact format:

\`\`\`test-mapping
framework: <language>/<framework>/<run-command>
001: test_function_name_1, test_function_name_2
002: test_another_feature
003: test_integration_works
e2e: test_complete_feature_e2e
\`\`\`

**The \`framework:\` line is required** - it specifies the testing framework used. Examples:
- \`framework: typescript/bun:test/bun test\`
- \`framework: typescript/vitest/npx vitest run\`
- \`framework: typescript/jest/npx jest\`
- \`framework: python/pytest/pytest -v\`
- \`framework: go/testing/go test ./...\`

**The \`e2e:\` line is required** - it specifies the end-to-end test that validates the entire feature works together.

## Guidelines

- Tests should be specific enough to verify the task's requirements
- Tests should be written to FAIL initially (since implementation hasn't started)
- Use the project's existing test framework (look for package.json, pytest.ini, etc.)
- Test names should be descriptive: \`test_user_can_login_with_valid_credentials\` not \`test_login\`
- Include both unit tests and integration tests where appropriate
- The E2E test should exercise the complete user workflow from start to finish
- The E2E test should be comprehensive enough to catch integration issues between tasks

Now, write the tests and provide the test mapping.
`
  }

  export interface ParsedTestMappings {
    taskMappings: TestMapping[]
    e2eTest?: string
    testFramework?: TestFrameworkInfo
  }

  export function parseTestMappings(response: string): ParsedTestMappings {
    const taskMappings: TestMapping[] = []
    let e2eTest: string | undefined
    let testFramework: TestFrameworkInfo | undefined

    // Look for the test-mapping code block
    const mappingMatch = response.match(/```test-mapping\n([\s\S]*?)```/)

    if (mappingMatch) {
      const mappingContent = mappingMatch[1]
      const lines = mappingContent.split("\n").filter((l) => l.trim())

      for (const line of lines) {
        // Check for framework line (format: framework: language/framework/run-command)
        const frameworkMatch = line.match(/^framework:\s*(.+)$/)
        if (frameworkMatch) {
          const parts = frameworkMatch[1].trim().split("/")
          if (parts.length >= 2) {
            testFramework = {
              language: parts[0].trim(),
              framework: parts[1].trim(),
              runCommand: parts.slice(2).join("/").trim() || undefined,
            }
          }
          continue
        }

        // Check for e2e test line
        const e2eMatch = line.match(/^e2e:\s*(.+)$/)
        if (e2eMatch) {
          e2eTest = e2eMatch[1].trim()
          continue
        }

        // Check for task mapping line
        const match = line.match(/^(\d+):\s*(.+)$/)
        if (match) {
          const taskId = match[1]
          const tests = match[2]
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)

          taskMappings.push({ taskId, tests })
        }
      }
    }

    return { taskMappings, e2eTest, testFramework }
  }

  interface FrameworkCheckResult {
    installed: boolean
    installedSuccessfully?: boolean
    error?: string
    userActionRequired?: boolean
    message?: string
  }

  async function checkCommandExists(command: string): Promise<boolean> {
    try {
      execSync(`which ${command}`, { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }

  async function runCommand(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd,
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
        resolve({
          success: code === 0,
          output: stdout + stderr,
        })
      })

      proc.on("error", (err) => {
        resolve({
          success: false,
          output: err.message,
        })
      })
    })
  }

  export async function ensureTestFrameworkInstalled(
    testFramework: TestFrameworkInfo,
    parentSessionId?: string,
  ): Promise<FrameworkCheckResult> {
    const { language, framework, runCommand: frameworkRunCommand } = testFramework
    const projectDir = Instance.directory

    log.info("checking test framework installation", { language, framework })

    // Determine the command to check if framework is installed
    let checkCommand: string
    let checkArgs: string[]

    const lowerFramework = framework.toLowerCase()
    const lowerLanguage = language.toLowerCase()

    if (lowerFramework.includes("pytest") || lowerLanguage === "python") {
      checkCommand = "pytest"
      checkArgs = ["--version"]
    } else if (lowerFramework.includes("bun")) {
      checkCommand = "bun"
      checkArgs = ["--version"]
    } else if (lowerFramework.includes("vitest")) {
      checkCommand = "npx"
      checkArgs = ["vitest", "--version"]
    } else if (lowerFramework.includes("jest")) {
      checkCommand = "npx"
      checkArgs = ["jest", "--version"]
    } else if (lowerFramework.includes("go") || lowerFramework === "testing") {
      checkCommand = "go"
      checkArgs = ["version"]
    } else {
      // Unknown framework - ask user
      return {
        installed: false,
        userActionRequired: true,
        message: `Unknown test framework "${framework}". Please install it manually or specify a different framework.`,
      }
    }

    // Check if framework is installed
    const checkResult = await runCommand(checkCommand, checkArgs, projectDir)

    if (checkResult.success) {
      log.info("test framework is installed", { framework, output: checkResult.output.slice(0, 100) })
      return { installed: true }
    }

    log.info("test framework not found, attempting installation", { framework })
    await logToParent(parentSessionId, `**Test framework "${framework}" not found.** Attempting to install...`)

    // Try to install based on language/framework
    if (lowerLanguage === "python" || lowerFramework.includes("pytest")) {
      return await installPythonFramework(framework, projectDir, parentSessionId)
    } else if (
      lowerLanguage === "typescript" ||
      lowerLanguage === "javascript" ||
      lowerFramework.includes("bun") ||
      lowerFramework.includes("vitest") ||
      lowerFramework.includes("jest")
    ) {
      return await installJsFramework(framework, projectDir, parentSessionId)
    } else if (lowerLanguage === "go") {
      // Go testing is built-in, shouldn't need installation
      return {
        installed: false,
        userActionRequired: true,
        message: `Go testing framework should be built-in. Please ensure Go is installed correctly.`,
      }
    }

    return {
      installed: false,
      userActionRequired: true,
      message: `Cannot automatically install test framework "${framework}" for language "${language}". Please install it manually.`,
    }
  }

  async function installPythonFramework(
    framework: string,
    projectDir: string,
    parentSessionId?: string,
  ): Promise<FrameworkCheckResult> {
    const venvPath = path.join(projectDir, ".venv")
    const lowerFramework = framework.toLowerCase()

    // Determine package name
    let packageName = "pytest" // default
    if (lowerFramework.includes("pytest")) {
      packageName = "pytest"
    } else if (lowerFramework.includes("unittest")) {
      // unittest is built-in
      return { installed: true }
    }

    // Check if venv exists
    const venvExists = await fs
      .access(venvPath)
      .then(() => true)
      .catch(() => false)

    if (!venvExists) {
      // Create venv
      log.info("creating Python venv", { venvPath })
      await logToParent(parentSessionId, `Creating Python virtual environment...`)

      const pythonCmd = (await checkCommandExists("python3")) ? "python3" : "python"
      const venvResult = await runCommand(pythonCmd, ["-m", "venv", ".venv"], projectDir)

      if (!venvResult.success) {
        return {
          installed: false,
          userActionRequired: true,
          message: `Failed to create Python venv: ${venvResult.output}\n\nPlease create a virtual environment manually and install ${packageName}.`,
        }
      }
    }

    // Install package in venv
    const pipPath = path.join(venvPath, "bin", "pip")
    log.info("installing Python package", { packageName, pipPath })
    await logToParent(parentSessionId, `Installing ${packageName} in venv...`)

    const installResult = await runCommand(pipPath, ["install", packageName], projectDir)

    if (!installResult.success) {
      return {
        installed: false,
        userActionRequired: true,
        message: `Failed to install ${packageName}: ${installResult.output}\n\nPlease install it manually: ${pipPath} install ${packageName}`,
      }
    }

    // Verify installation
    const pytestPath = path.join(venvPath, "bin", "pytest")
    const verifyResult = await runCommand(pytestPath, ["--version"], projectDir)

    if (verifyResult.success) {
      log.info("Python test framework installed successfully", { packageName })
      await logToParent(parentSessionId, `✅ ${packageName} installed successfully in venv`)
      return { installed: true, installedSuccessfully: true }
    }

    return {
      installed: false,
      userActionRequired: true,
      message: `Installed ${packageName} but verification failed. Please check the installation.`,
    }
  }

  async function installJsFramework(
    framework: string,
    projectDir: string,
    parentSessionId?: string,
  ): Promise<FrameworkCheckResult> {
    const lowerFramework = framework.toLowerCase()

    // Determine package name and package manager
    let packageName: string
    if (lowerFramework.includes("vitest")) {
      packageName = "vitest"
    } else if (lowerFramework.includes("jest")) {
      packageName = "jest"
    } else if (lowerFramework.includes("bun")) {
      // bun test is built into bun
      const bunInstalled = await checkCommandExists("bun")
      if (bunInstalled) {
        return { installed: true }
      }
      return {
        installed: false,
        userActionRequired: true,
        message: `Bun is not installed. Please install Bun from https://bun.sh or use a different test framework.`,
      }
    } else {
      return {
        installed: false,
        userActionRequired: true,
        message: `Unknown JavaScript test framework "${framework}". Please install it manually.`,
      }
    }

    // Detect package manager
    const hasBunLock = await fs
      .access(path.join(projectDir, "bun.lock"))
      .then(() => true)
      .catch(() => false)
    const hasBunLockb = await fs
      .access(path.join(projectDir, "bun.lockb"))
      .then(() => true)
      .catch(() => false)
    const hasYarnLock = await fs
      .access(path.join(projectDir, "yarn.lock"))
      .then(() => true)
      .catch(() => false)
    const hasPnpmLock = await fs
      .access(path.join(projectDir, "pnpm-lock.yaml"))
      .then(() => true)
      .catch(() => false)
    const hasPackageJson = await fs
      .access(path.join(projectDir, "package.json"))
      .then(() => true)
      .catch(() => false)

    let installCmd: string
    let installArgs: string[]

    if (hasBunLock || hasBunLockb) {
      installCmd = "bun"
      installArgs = ["add", "-d", packageName]
    } else if (hasYarnLock) {
      installCmd = "yarn"
      installArgs = ["add", "-D", packageName]
    } else if (hasPnpmLock) {
      installCmd = "pnpm"
      installArgs = ["add", "-D", packageName]
    } else if (hasPackageJson) {
      installCmd = "npm"
      installArgs = ["install", "-D", packageName]
    } else {
      return {
        installed: false,
        userActionRequired: true,
        message: `No package.json found. Please initialize a Node.js project first or install ${packageName} manually.`,
      }
    }

    log.info("installing JS package", { packageName, installCmd })
    await logToParent(parentSessionId, `Installing ${packageName} using ${installCmd}...`)

    const installResult = await runCommand(installCmd, installArgs, projectDir)

    if (!installResult.success) {
      return {
        installed: false,
        userActionRequired: true,
        message: `Failed to install ${packageName}: ${installResult.output}\n\nPlease install it manually: ${installCmd} ${installArgs.join(" ")}`,
      }
    }

    log.info("JS test framework installed successfully", { packageName })
    await logToParent(parentSessionId, `✅ ${packageName} installed successfully`)
    return { installed: true, installedSuccessfully: true }
  }

  export async function buildPlanningConversationText(sessionId: string): Promise<string> {
    const messages = await Session.messages({ sessionID: sessionId, includeCompacted: false })
    const lines: string[] = []

    for (const msg of messages) {
      if (msg.info.role === "user") {
        const textParts = msg.parts
          .filter((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")
        if (textParts.trim()) {
          lines.push(`User: ${textParts.trim()}`)
        }
      } else if (msg.info.role === "assistant") {
        const textParts = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")
        if (textParts.trim()) {
          const truncated = textParts.length > 1000 ? textParts.slice(0, 1000) + "..." : textParts
          lines.push(`Assistant: ${truncated.trim()}`)
        }
      }
    }

    return lines.join("\n\n")
  }
}
