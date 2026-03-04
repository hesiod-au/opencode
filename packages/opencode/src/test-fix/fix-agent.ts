import { Log } from "../util/log"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { SessionPrompt } from "../session/prompt"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { TestFixEvent } from "./events"
import { WorkflowStore } from "../workflow/store"
import { spawn } from "child_process"
import type { TestFix } from "./types"

export namespace FixAgent {
  const log = Log.create({ service: "test-fix-agent" })

  export interface Options {
    file: string
    type: TestFix.TestType
    suiteCommand: string
    fileCommand: string | null
    parentSessionId: string
    runId?: string
    abort: AbortSignal
  }

  export interface Result {
    file: string
    status: TestFix.TestFileStatus
    retries: number
    sessionId: string
    error?: string
    reason?: string
  }

  async function readContractDocs(): Promise<string> {
    const docFiles = ["docs/contract.md", "docs/specs.md", "docs/sdd.md"]
    const parts: string[] = []
    for (const relative of docFiles) {
      const filepath = `${Instance.directory}/${relative}`
      const exists = await Bun.file(filepath)
        .exists()
        .catch(() => false)
      if (!exists) continue
      const text = await Bun.file(filepath)
        .text()
        .catch(() => "")
      if (text) parts.push(`## ${relative}\n\n${text}`)
    }
    return parts.join("\n\n---\n\n")
  }

  function buildCommand(suiteCommand: string, fileCommand: string | null, file: string): string {
    if (fileCommand) return fileCommand.replace("{file}", file)
    return suiteCommand
  }

  async function runTestCommand(command: string, abort: AbortSignal): Promise<{ success: boolean; output: string }> {
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

  function buildFixPrompt(file: string, testOutput: string, attempt: number, maxAttempts: number): string {
    return `# Test Fix: ${file}

The test file \`${file}\` is failing. This is attempt ${attempt}/${maxAttempts}.

## Test Output

\`\`\`
${testOutput.slice(0, 8000)}${testOutput.length > 8000 ? "\n... (truncated)" : ""}
\`\`\`

## Instructions

1. Read the failing test file to understand what it expects
2. Read the implementation code being tested
3. Fix the **implementation code** (not the tests) to make the tests pass
4. Do NOT modify any test files

If you determine the test itself is broken (e.g., import errors, syntax errors in the test, test infrastructure issues), respond with exactly:
\`[TEST_ERRORING: brief reason]\`

If you determine the test is testing incorrect/outdated behavior that doesn't match the project's actual requirements, respond with exactly:
\`[TEST_INVALID: brief reason]\`

Otherwise, fix the implementation and confirm what you changed.`
  }

  function buildErrorInvestigationPrompt(file: string, testOutput: string, reason: string): string {
    return `# Error Investigation: ${file}

The test file \`${file}\` has been identified as erroring (not a test failure, but the test itself cannot run).

**Reported reason:** ${reason}

## Test Output

\`\`\`
${testOutput.slice(0, 8000)}${testOutput.length > 8000 ? "\n... (truncated)" : ""}
\`\`\`

## Instructions

1. Read the test file and understand why it cannot run
2. Fix the infrastructure issue (missing imports, broken setup, incorrect paths, etc.)
3. Do NOT change the test assertions or behavior — only fix what prevents it from running
4. If the test requires external services or setup that cannot be provided, explain why`
  }

  function buildValidityAssessmentPrompt(
    file: string,
    testOutput: string,
    reason: string,
    contractDocs: string,
  ): string {
    let prompt = `# Validity Assessment: ${file}

The test file \`${file}\` has been flagged as potentially testing incorrect behavior.

**Reported reason:** ${reason}

## Test Output

\`\`\`
${testOutput.slice(0, 5000)}${testOutput.length > 5000 ? "\n... (truncated)" : ""}
\`\`\``

    if (contractDocs) {
      prompt += `

## Project Documentation

${contractDocs.slice(0, 10000)}${contractDocs.length > 10000 ? "\n... (truncated)" : ""}`
    }

    prompt += `

## Instructions

1. Read the test file and understand what behavior it's testing
2. Check project documentation (if available) to determine whether the tested behavior is correct
3. Read the implementation to understand current behavior
4. Determine whether the test or the implementation is correct
5. If the test is correct, fix the implementation
6. If the test is genuinely invalid, explain why in your response`

    return prompt
  }

  function parseAgentResponse(text: string): { type: "fixed" | "erroring" | "invalid"; reason?: string } {
    const errorMatch = text.match(/\[TEST_ERRORING:\s*(.+?)\]/)
    if (errorMatch) return { type: "erroring", reason: errorMatch[1].trim() }

    const invalidMatch = text.match(/\[TEST_INVALID:\s*(.+?)\]/)
    if (invalidMatch) return { type: "invalid", reason: invalidMatch[1].trim() }

    return { type: "fixed" }
  }

  export async function computeSessionStats(
    sessionId: string,
  ): Promise<{ inputTokens: number; outputTokens: number; cost: number }> {
    const messages = await Session.messages({ sessionID: sessionId, includeCompacted: true })
    let inputTokens = 0
    let outputTokens = 0
    let cost = 0

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "step-finish") {
          const step = part as MessageV2.StepFinishPart
          inputTokens += step.tokens.input + step.tokens.cache.read
          outputTokens += step.tokens.output + step.tokens.reasoning
          cost += step.cost
        }
      }
    }

    return { inputTokens, outputTokens, cost }
  }

  export async function run(options: Options): Promise<Result> {
    const { file, type, suiteCommand, fileCommand, parentSessionId, abort, runId } = options

    log.info("starting fix agent", { file, type })

    const session = await Session.create({
      parentID: parentSessionId,
      title: `Fix: ${file}`,
    })
    if (runId) {
      await WorkflowStore.linkSession({
        runId,
        sessionId: session.id,
        workflowId: "test-fix",
        role: "child",
        parentSessionId,
      })
    }

    SessionStatus.set(session.id, { type: "busy" })

    Bus.publish(TestFixEvent.FixAgentStarted, {
      type,
      file,
      sessionId: session.id,
    })

    const config = await Config.get()
    const maxRetries = config.testFix?.maxFixRetries ?? 5

    const command = buildCommand(suiteCommand, fileCommand, file)
    let lastOutput = ""
    let retries = 0

    try {
      const agent = await Agent.get("build")
      if (!agent) throw new Error("Build agent not found")
      const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      // Initial test run
      const initial = await runTestCommand(command, abort)
      lastOutput = initial.output

      if (initial.success) {
        log.info("test already passing", { file })
        SessionStatus.set(session.id, { type: "idle" })
        Bus.publish(TestFixEvent.FixAgentCompleted, {
          type,
          file,
          sessionId: session.id,
          status: "passing",
          retries: 0,
        })
        return { file, status: "passing", retries: 0, sessionId: session.id }
      }

      // Fix loop
      while (retries < maxRetries && !abort.aborted) {
        retries++
        log.info("fix attempt", { file, attempt: retries, maxRetries })

        const prompt = buildFixPrompt(file, lastOutput, retries, maxRetries)

        const result = await SessionPrompt.prompt({
          messageID: Identifier.ascending("message"),
          sessionID: session.id,
          model: { modelID: model.modelID, providerID: model.providerID },
          agent: agent.name,
          tools: { question: false },
          parts: [{ type: "text", text: prompt }],
        })

        if (abort.aborted) break

        // Check agent response for special markers
        const responseText = result.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")

        const parsed = parseAgentResponse(responseText)

        if (parsed.type === "erroring") {
          log.info("test identified as erroring", { file, reason: parsed.reason })
          // Dispatch error investigation
          const investigationResult = await investigateError(file, lastOutput, parsed.reason ?? "", session.id, {
            model,
            agent,
            abort,
          })
          // Re-run test after investigation
          const retest = await runTestCommand(command, abort)
          lastOutput = retest.output
          if (retest.success) {
            SessionStatus.set(session.id, { type: "idle" })
            Bus.publish(TestFixEvent.FixAgentCompleted, {
              type,
              file,
              sessionId: session.id,
              status: "passing",
              retries,
            })
            return { file, status: "passing", retries, sessionId: session.id }
          }
          // If still failing after investigation, mark as erroring
          SessionStatus.set(session.id, { type: "idle" })
          Bus.publish(TestFixEvent.FixAgentCompleted, {
            type,
            file,
            sessionId: session.id,
            status: "erroring",
            retries,
          })
          return { file, status: "erroring", retries, sessionId: session.id, reason: parsed.reason }
        }

        if (parsed.type === "invalid") {
          log.info("test identified as invalid", { file, reason: parsed.reason })
          // Dispatch validity assessment
          await assessValidity(file, lastOutput, parsed.reason ?? "", session.id, { model, agent, abort })
          // Re-run test
          const retest = await runTestCommand(command, abort)
          lastOutput = retest.output
          if (retest.success) {
            SessionStatus.set(session.id, { type: "idle" })
            Bus.publish(TestFixEvent.FixAgentCompleted, {
              type,
              file,
              sessionId: session.id,
              status: "passing",
              retries,
            })
            return { file, status: "passing", retries, sessionId: session.id }
          }
          SessionStatus.set(session.id, { type: "idle" })
          Bus.publish(TestFixEvent.FixAgentCompleted, {
            type,
            file,
            sessionId: session.id,
            status: "invalid",
            retries,
          })
          return { file, status: "invalid", retries, sessionId: session.id, reason: parsed.reason }
        }

        // Agent attempted a fix — re-run test
        const retest = await runTestCommand(command, abort)
        lastOutput = retest.output

        if (retest.success) {
          log.info("test now passing after fix", { file, retries })
          SessionStatus.set(session.id, { type: "idle" })
          Bus.publish(TestFixEvent.FixAgentCompleted, {
            type,
            file,
            sessionId: session.id,
            status: "passing",
            retries,
          })
          return { file, status: "passing", retries, sessionId: session.id }
        }
      }

      // Exhausted retries
      log.warn("fix agent exhausted retries", { file, retries })
      SessionStatus.set(session.id, { type: "idle" })
      Bus.publish(TestFixEvent.FixAgentCompleted, { type, file, sessionId: session.id, status: "failing", retries })
      return { file, status: "failing", retries, sessionId: session.id }
    } catch (err: any) {
      log.error("fix agent error", { file, error: err })
      SessionStatus.set(session.id, { type: "idle" })
      Bus.publish(TestFixEvent.FixAgentCompleted, { type, file, sessionId: session.id, status: "failing", retries })
      return { file, status: "failing", retries, sessionId: session.id, error: err.message ?? String(err) }
    }
  }

  async function investigateError(
    file: string,
    testOutput: string,
    reason: string,
    parentSessionId: string,
    ctx: {
      model: { providerID: string; modelID: string }
      agent: Agent.Info
      abort: AbortSignal
    },
  ): Promise<void> {
    const prompt = buildErrorInvestigationPrompt(file, testOutput, reason)
    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: parentSessionId,
      model: { modelID: ctx.model.modelID, providerID: ctx.model.providerID },
      agent: ctx.agent.name,
      tools: { question: false },
      parts: [{ type: "text", text: prompt }],
    })
  }

  async function assessValidity(
    file: string,
    testOutput: string,
    reason: string,
    parentSessionId: string,
    ctx: {
      model: { providerID: string; modelID: string }
      agent: Agent.Info
      abort: AbortSignal
    },
  ): Promise<void> {
    const contractDocs = await readContractDocs()
    const prompt = buildValidityAssessmentPrompt(file, testOutput, reason, contractDocs)
    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: parentSessionId,
      model: { modelID: ctx.model.modelID, providerID: ctx.model.providerID },
      agent: ctx.agent.name,
      tools: { question: false },
      parts: [{ type: "text", text: prompt }],
    })
  }
}
