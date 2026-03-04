import { Log } from "../util/log"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { TestFixEvent } from "./events"
import { FixAgent } from "./fix-agent"
import { WorkflowStore } from "../workflow/store"
import { spawn } from "child_process"
import type { TestFix } from "./types"

export namespace GroupRunner {
  const log = Log.create({ service: "test-fix-group" })

  export interface Options {
    type: TestFix.TestType
    method: TestFix.TestMethodConfig
    parentSessionId: string
    runId?: string
    concurrency: { current: number; max: number }
    abort: AbortSignal
  }

  async function runSuiteCommand(command: string, abort: AbortSignal): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      if (abort.aborted) {
        resolve({ success: false, output: "Aborted" })
        return
      }

      const proc = spawn("sh", ["-c", command], {
        cwd: Instance.directory,
        stdio: ["ignore", "pipe", "pipe"],
      })

      const onAbort = () => proc.kill()
      abort.addEventListener("abort", onAbort, { once: true })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on("close", (code) => {
        abort.removeEventListener("abort", onAbort)
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : "")
        resolve({ success: code === 0, output })
      })

      proc.on("error", (err) => {
        abort.removeEventListener("abort", onAbort)
        resolve({ success: false, output: `Failed to start: ${err.message}` })
      })
    })
  }

  async function parseFailingFiles(testOutput: string, sessionId: string, abort: AbortSignal): Promise<string[]> {
    const agent = await Agent.get("build")
    if (!agent) return []
    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

    const prompt = `# Parse Failing Test Files

Analyze the following test output and extract the file paths of all failing test files.

## Test Output

\`\`\`
${testOutput.slice(0, 15000)}${testOutput.length > 15000 ? "\n... (truncated)" : ""}
\`\`\`

## Instructions

Return ONLY a JSON array of file paths (relative to the project root) that have failing tests.
For example: ["tests/auth.test.ts", "tests/utils.test.ts"]

If you cannot determine specific file paths, return an empty array: []

Return only the JSON array, no other text.`

    const result = await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: sessionId,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      tools: { question: false },
      parts: [{ type: "text", text: prompt }],
    })

    if (abort.aborted) return []

    const responseText = result.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n")

    // Extract JSON array from response
    const jsonMatch = responseText.match(/\[[\s\S]*?\]/)
    if (!jsonMatch) return []

    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === "string")
    } catch {
      return []
    }
  }

  async function acquireConcurrency(concurrency: Options["concurrency"], abort: AbortSignal): Promise<boolean> {
    while (concurrency.current >= concurrency.max) {
      if (abort.aborted) return false
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    concurrency.current++
    return true
  }

  function releaseConcurrency(concurrency: Options["concurrency"]): void {
    concurrency.current = Math.max(0, concurrency.current - 1)
  }

  export async function run(options: Options): Promise<TestFix.GroupResult> {
    const { type, method, parentSessionId, concurrency, abort, runId } = options

    log.info("starting group runner", { type, command: method.command })

    const groupSession = await Session.create({
      parentID: parentSessionId,
      title: `Test Group: ${type}`,
    })
    if (runId) {
      await WorkflowStore.linkSession({
        runId,
        sessionId: groupSession.id,
        workflowId: "test-fix",
        role: "group",
        parentSessionId,
      })
    }

    SessionStatus.set(groupSession.id, { type: "busy" })

    Bus.publish(TestFixEvent.GroupStarted, {
      type,
      sessionId: groupSession.id,
    })

    const config = await Config.get()
    const maxGroupRetries = config.testFix?.maxGroupRetries ?? 3
    const staggerSeconds = config.testFix?.staggerSeconds ?? 3
    const allFileResults = new Map<string, TestFix.TestFileResult>()
    let regressionCycles = 0

    try {
      // Run full suite
      const suiteResult = await runSuiteCommand(method.command, abort)

      if (suiteResult.success) {
        log.info("suite already passing", { type })
        SessionStatus.set(groupSession.id, { type: "idle" })
        Bus.publish(TestFixEvent.GroupCompleted, {
          type,
          sessionId: groupSession.id,
          fileCount: 0,
          passingCount: 0,
          failingCount: 0,
          erroringCount: 0,
          invalidCount: 0,
        })
        return { type, sessionId: groupSession.id, files: [], regressionCycles: 0, suitePassedAfterFixes: true }
      }

      // Parse failing files using AI
      const failingFiles = await parseFailingFiles(suiteResult.output, groupSession.id, abort)
      if (abort.aborted) {
        SessionStatus.set(groupSession.id, { type: "idle" })
        return { type, sessionId: groupSession.id, files: [], regressionCycles: 0, suitePassedAfterFixes: false }
      }

      log.info("parsed failing files", { type, files: failingFiles })

      if (failingFiles.length === 0) {
        // Could not parse individual files — run whole suite as single fix target
        log.warn("could not parse failing files, treating suite as single target", { type })
        const acquired = await acquireConcurrency(concurrency, abort)
        if (!acquired) {
          SessionStatus.set(groupSession.id, { type: "idle" })
          return { type, sessionId: groupSession.id, files: [], regressionCycles: 0, suitePassedAfterFixes: false }
        }

        const result = await FixAgent.run({
          file: `${type} suite`,
          type,
          suiteCommand: method.command,
          fileCommand: null,
          parentSessionId: groupSession.id,
          runId,
          abort,
        })
        releaseConcurrency(concurrency)
        allFileResults.set(result.file, result)
      } else {
        // Dispatch fix agents for each failing file
        await dispatchFixAgents(
          failingFiles,
          type,
          method,
          groupSession.id,
          runId,
          concurrency,
          staggerSeconds,
          abort,
          allFileResults,
        )
      }

      // Regression loop
      for (let cycle = 0; cycle < maxGroupRetries && !abort.aborted; cycle++) {
        regressionCycles++

        Bus.publish(TestFixEvent.RegressionRunStarted, { type, cycle: regressionCycles })
        log.info("regression run", { type, cycle: regressionCycles })

        const regressionResult = await runSuiteCommand(method.command, abort)

        if (regressionResult.success) {
          log.info("suite passing after regression check", { type, cycle: regressionCycles })
          const files = Array.from(allFileResults.values())
          SessionStatus.set(groupSession.id, { type: "idle" })
          publishGroupCompleted(type, groupSession.id, files)
          return { type, sessionId: groupSession.id, files, regressionCycles, suitePassedAfterFixes: true }
        }

        // Parse new failures
        const newFailingFiles = await parseFailingFiles(regressionResult.output, groupSession.id, abort)
        const unhandledFiles = newFailingFiles.filter(
          (f) => !allFileResults.has(f) || allFileResults.get(f)!.status === "failing",
        )

        if (unhandledFiles.length === 0) break

        log.info("new failures found in regression", { type, files: unhandledFiles })
        await dispatchFixAgents(
          unhandledFiles,
          type,
          method,
          groupSession.id,
          runId,
          concurrency,
          staggerSeconds,
          abort,
          allFileResults,
        )
      }

      const files = Array.from(allFileResults.values())
      SessionStatus.set(groupSession.id, { type: "idle" })
      publishGroupCompleted(type, groupSession.id, files)
      return { type, sessionId: groupSession.id, files, regressionCycles, suitePassedAfterFixes: false }
    } catch (err: any) {
      log.error("group runner error", { type, error: err })
      const files = Array.from(allFileResults.values())
      SessionStatus.set(groupSession.id, { type: "idle" })
      publishGroupCompleted(type, groupSession.id, files)
      return {
        type,
        sessionId: groupSession.id,
        files,
        regressionCycles,
        suitePassedAfterFixes: false,
        error: err.message ?? String(err),
      }
    }
  }

  async function dispatchFixAgents(
    files: string[],
    type: TestFix.TestType,
    method: TestFix.TestMethodConfig,
    groupSessionId: string,
    runId: string | undefined,
    concurrency: Options["concurrency"],
    staggerSeconds: number,
    abort: AbortSignal,
    results: Map<string, TestFix.TestFileResult>,
  ): Promise<void> {
    const promises: Promise<void>[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      // Stagger launches
      if (i > 0 && staggerSeconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerSeconds * 1000))
      }

      if (abort.aborted) break

      const promise = (async () => {
        const acquired = await acquireConcurrency(concurrency, abort)
        if (!acquired) return

        try {
          const result = await FixAgent.run({
            file,
            type,
            suiteCommand: method.command,
            fileCommand: method.test_file_command ?? null,
            parentSessionId: groupSessionId,
            runId,
            abort,
          })
          results.set(file, result)
        } finally {
          releaseConcurrency(concurrency)
        }
      })()

      promises.push(promise)
    }

    await Promise.all(promises)
  }

  function publishGroupCompleted(type: TestFix.TestType, sessionId: string, files: TestFix.TestFileResult[]): void {
    Bus.publish(TestFixEvent.GroupCompleted, {
      type,
      sessionId,
      fileCount: files.length,
      passingCount: files.filter((f) => f.status === "passing").length,
      failingCount: files.filter((f) => f.status === "failing").length,
      erroringCount: files.filter((f) => f.status === "erroring").length,
      invalidCount: files.filter((f) => f.status === "invalid").length,
    })
  }
}
