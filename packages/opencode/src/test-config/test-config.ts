import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { WorkflowEvent } from "../workflow/events"
import { TestConfigEvent } from "./events"
import type { Workflow } from "../workflow/workflow"
import fs from "fs/promises"
import path from "path"

export namespace TestConfigWorkflow {
  const log = Log.create({ service: "test-config" })

  type Phase = "analyzing" | "generating" | "validating" | "complete"
  type MethodName = "unit" | "endpoint" | "e2e"
  type ValidationName = MethodName | "default"

  interface ValidationTarget {
    name: ValidationName
    command: string
    required: boolean
  }

  interface ValidationPlan {
    mode: "structured" | "legacy" | "none"
    runnable: ValidationTarget[]
    missingRequired: MethodName[]
  }

  interface State {
    running: boolean
    phase?: Phase
    phaseDetail?: string
    orchestratorSessionId?: string
    startedAt: number
    completedAt?: number
    abortController: AbortController
    progressLog: Array<{ message: string; timestamp: number }>
    stats: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
    configContents?: Record<string, unknown>
  }

  let state: State | null = null

  function toObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Record<string, unknown>
  }

  function toStringValue(value: unknown): string | undefined {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (!trimmed) return
    return trimmed
  }

  function parseConfig(value: unknown): Record<string, unknown> | undefined {
    return toObject(value)
  }

  function parseWarnings(config?: Record<string, unknown>): string[] {
    if (!config) return []
    const value = config.warnings
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      const warning = toStringValue(item)
      return warning ? [warning] : []
    })
  }

  export function getValidationPlan(config: Record<string, unknown>): ValidationPlan {
    const methods = toObject(config.test_methods)
    if (methods) {
      const names: MethodName[] = ["unit", "endpoint", "e2e"]
      const runnable = names.flatMap((name) => {
        const method = toObject(methods[name])
        if (!method) return []
        const command = toStringValue(method.command)
        if (!command) return []
        return [{ name, command, required: method.required === true }]
      })
      const missingRequired = names.flatMap((name) => {
        const method = toObject(methods[name])
        if (!method || method.required !== true) return []
        return toStringValue(method.command) ? [] : [name]
      })
      if (runnable.length > 0 || missingRequired.length > 0) {
        return { mode: "structured", runnable, missingRequired }
      }
    }

    const commands = toObject(config.commands)
    const fallback = toStringValue(commands?.test)
    if (fallback) {
      return {
        mode: "legacy",
        runnable: [{ name: "default", command: fallback, required: true }],
        missingRequired: [],
      }
    }

    return { mode: "none", runnable: [], missingRequired: [] }
  }

  function setPhase(phase: Phase, detail?: string) {
    if (!state) return
    state.phase = phase
    state.phaseDetail = detail
    log.info("phase changed", { phase, detail })

    Bus.publish(WorkflowEvent.PhaseChanged, {
      workflowId: "test-config",
      phase,
      detail,
    })
  }

  async function logToSession(text: string): Promise<void> {
    if (!state?.orchestratorSessionId) return
    try {
      const agent = await Agent.get("build")
      const model = agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")
      await Session.updateMessage({
        id: messageID,
        sessionID: state.orchestratorSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })
      await Session.updatePart({
        id: partID,
        sessionID: state.orchestratorSessionId,
        messageID,
        type: "text",
        text,
        synthetic: true,
      })
    } catch (err) {
      log.error("logToSession failed", { error: err })
    }
  }

  function progress(message: string) {
    log.info("progress", { message })
    if (state) {
      state.progressLog.push({ message, timestamp: Date.now() })
      if (state.progressLog.length > 100) state.progressLog.shift()
    }
    Bus.publish(WorkflowEvent.Progress, {
      workflowId: "test-config",
      message,
    })
    logToSession(message).catch((err) => log.error("logToSession error", { error: err }))
  }

  async function configExists(): Promise<boolean> {
    const path = `${Instance.directory}/test-config.json`
    return Bun.file(path)
      .exists()
      .catch(() => false)
  }

  async function readConfig(): Promise<Record<string, unknown> | undefined> {
    const path = `${Instance.directory}/test-config.json`
    const exists = await Bun.file(path)
      .exists()
      .catch(() => false)
    if (!exists) return undefined
    try {
      const text = await Bun.file(path).text()
      return parseConfig(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  export const definition: Workflow.Definition<Phase> = {
    id: "test-config",
    name: "Test Config",
    activationMode: "start",

    async start() {
      if (state?.running) {
        log.warn("test-config workflow already running")
        return
      }

      const orchestratorSession = await Session.create({
        title: "Test Config",
      })

      state = {
        running: true,
        orchestratorSessionId: orchestratorSession.id,
        startedAt: Date.now(),
        abortController: new AbortController(),
        progressLog: [],
        stats: { inputTokens: 0, outputTokens: 0, cost: 0, modifiedFiles: [] },
      }

      Bus.publish(WorkflowEvent.Started, {
        workflowId: "test-config",
        parentSessionId: orchestratorSession.id,
      })

      try {
        await run()
      } catch (err: any) {
        log.error("test-config error", { error: err })
        progress(`Error: ${err.message}`)
        await definition.stop("error")
      }
    },

    async stop(reason) {
      if (!state) return
      log.info("stopping test-config", { reason })

      state.running = false
      state.completedAt = Date.now()
      state.abortController.abort()

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "test-config",
        reason,
      })

      state = null
    },

    getStatus() {
      return {
        running: state?.running ?? false,
        phase: state?.phase,
        phaseDetail: state?.phaseDetail,
        parentSessionId: state?.orchestratorSessionId,
        startedAt: state?.startedAt,
        completedAt: state?.completedAt,
        stats: state?.stats,
        extra: {
          progressLog: state?.progressLog ?? [],
          orchestratorSessionId: state?.orchestratorSessionId,
          configExists: state?.configContents !== undefined,
          config: state?.configContents,
        },
      }
    },

    isRunning() {
      return state?.running ?? false
    },
  }

  async function addToGitignore() {
    const gitignorePath = path.join(Instance.directory, ".gitignore")
    const entry = "test-config.json"
    try {
      let content = ""
      try {
        content = await fs.readFile(gitignorePath, "utf-8")
      } catch {
        // .gitignore doesn't exist yet
      }
      if (content.split("\n").some((line) => line.trim() === entry)) return
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : ""
      await fs.writeFile(gitignorePath, `${content}${separator}${entry}\n`)
      log.info("added test-config.json to .gitignore")
    } catch (err) {
      log.warn("failed to update .gitignore", { error: err })
    }
  }

  async function run() {
    if (!state) return

    const existing = await readConfig()
    const hasExisting = existing !== undefined

    // Phase 1: Analyzing
    setPhase("analyzing", hasExisting ? "Updating existing config" : "Discovering project structure")
    progress(hasExisting ? "Found existing test-config.json, will validate and update" : "Analyzing project structure...")

    const analyzeSession = await Session.create({
      parentID: state.orchestratorSessionId,
      title: "Test Config — Analysis",
    })

    const existingConfigBlock = hasExisting
      ? `\n\nAn existing test-config.json was found with this content:\n\`\`\`json\n${JSON.stringify(existing, null, 2)}\n\`\`\`\n\nValidate it and update only what's needed.`
      : ""

    const analyzePrompt = `# Test Config — Project Analysis

Analyze this project to determine the test configuration. Write a \`test-config.json\` file at the project root.${existingConfigBlock}

## Steps

1. Explore the project structure — look for package.json, Makefile, pyproject.toml, go.mod, Cargo.toml, docker-compose.yml, Dockerfile, pom.xml, build.gradle, mix.exs, Gemfile, etc.
2. Identify:
   - Primary language(s)
   - Package manager
   - Test framework(s) and how to run tests
   - Linting and type-checking commands
   - Existing test file patterns and locations
   - Source code locations
3. Check for Docker support:
   - If docker-compose.yml or Dockerfile exists, use it
   - If not, propose a minimal Docker image for the detected language
4. Determine project type:
   - Use \`web_app\` when the project serves a browser UI.
   - Use \`api_service\`, \`library\`, \`cli\`, or \`unknown\` otherwise.
5. Determine test methods:
   - \`unit\` is always required.
   - \`endpoint\` is required when API/server endpoints exist.
   - \`e2e\` is required for \`web_app\` projects, optional otherwise.
   - E2E must include a runner plus settings/mocks needed to run on command.
6. Write the final \`test-config.json\` using the write tool with this schema:

\`\`\`json
{
  "version": 1,
  "language": "<primary language>",
  "framework": "<test framework>",
  "project_type": "web_app|api_service|library|cli|unknown",
  "docker": {
    "enabled": true,
    "image": "<appropriate base image>",
    "workdir": "/app",
    "setup": ["<install commands>"]
  },
  "test_methods": {
    "unit": {
      "command": "<unit test command>",
      "test_file_command": "<single-file unit command with {file} placeholder or null>",
      "required": true
    },
    "endpoint": {
      "command": "<endpoint/integration test command or null>",
      "test_file_command": "<single-file endpoint command or null>",
      "required": true
    },
    "e2e": {
      "command": "<e2e command that can run on demand>",
      "required": true,
      "runner": "<playwright|cypress|other>",
      "settings": {
        "base_url": "<url used in e2e tests>",
        "start_command": "<command to start app/services for e2e>",
        "wait_for": "<readiness url/pattern/command>"
      },
      "mocks": {
        "enabled": true,
        "strategy": "<mock strategy or null>",
        "seed_command": "<seed/mock setup command or null>"
      }
    }
  },
  "commands": {
    "test": "<full test command>",
    "testFile": "<command to test a single file, use {file} placeholder>",
    "lint": "<lint command or null>",
    "typecheck": "<typecheck command or null>"
  },
  "paths": {
    "tests": ["<test file patterns>"],
    "source": ["<source directories>"]
  },
  "warnings": ["<optional actionable warnings>"]
}
\`\`\`

Notes:
- Keep \`commands\` for compatibility with existing consumers.
- For non-web projects, set \`test_methods.e2e.required\` to false if not applicable.
- Use the actual commands that work for this project.`

    const agent = await Agent.get("build")
    if (!agent) throw new Error("Build agent not found")

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: analyzeSession.id,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false },
      parts: [{ type: "text", text: analyzePrompt }],
    })

    if (!state?.running) return

    setPhase("generating")
    progress("Analysis complete, reading generated config...")

    const config = await readConfig()
    if (!config) {
      progress("Agent did not write test-config.json. Stopping.")
      await definition.stop("error")
      return
    }

    const language = toStringValue(config.language)
    const framework = toStringValue(config.framework)

    Bus.publish(TestConfigEvent.AnalysisComplete, {
      language,
      framework,
    })

    Bus.publish(TestConfigEvent.ConfigWritten, {
      path: `${Instance.directory}/test-config.json`,
    })

    await addToGitignore()
    progress(`Config written: language=${language ?? "unknown"}, framework=${framework ?? "unknown"}`)

    // Phase 2: Validating
    if (!state?.running) return

    const validationPlan = getValidationPlan(config)
    if (validationPlan.mode === "none") {
      progress("No test command in config. Skipping validation.")
      setPhase("complete")
      state.configContents = config
      state.completedAt = Date.now()
      progress("Test config complete.")
      await definition.stop("completed")
      return
    }

    const runnableSummary = validationPlan.runnable
      .map((item) => `${item.name}:${item.command}`)
      .join(" | ")
    const missingSummary = validationPlan.missingRequired.join(", ")

    setPhase("validating", "Running tests to verify config")
    if (runnableSummary) {
      progress(`Validating config by running: ${runnableSummary}`)
    }
    if (missingSummary) {
      progress(`Required test methods missing commands: ${missingSummary}`)
    }

    const validateSession = await Session.create({
      parentID: state.orchestratorSessionId,
      title: "Test Config — Validation",
    })

    const runnableBlock = validationPlan.runnable.length
      ? validationPlan.runnable
          .map((item) => `- ${item.name}: ${item.command}${item.required ? " (required)" : " (optional)"}`)
          .join("\n")
      : "- none"
    const missingBlock = validationPlan.missingRequired.length
      ? validationPlan.missingRequired.map((item) => `- ${item}`).join("\n")
      : "- none"

    const validatePrompt = `# Test Config — Validation

A \`test-config.json\` has been generated for this project. Your job is to validate it works correctly.

## Validation targets from the current config

Runnable methods:
${runnableBlock}

Required methods missing a command:
${missingBlock}

## Steps

1. Read the \`test-config.json\` file
2. Ensure method requirements are correct:
   - \`unit\` must be required.
   - \`endpoint\` is required only when API/server endpoints are present.
   - \`e2e\` is required for \`project_type=web_app\`.
3. Run each required runnable method command in this order when present: unit, endpoint, e2e.
4. Run optional methods only if they have commands and are feasible.
5. If a required method is missing a command, update \`test-config.json\` to fill it.
6. If tests fail:
   - Diagnose the issue (missing dependencies, wrong command, incorrect paths, etc.)
   - Update \`test-config.json\` to fix the problem
   - Run validation again
7. Keep a \`validation\` object in \`test-config.json\`:

\`\`\`json
{
  "validation": {
    "unit": { "status": "pass|fail|unknown", "note": "<short detail>" },
    "endpoint": { "status": "pass|fail|unknown", "note": "<short detail>" },
    "e2e": { "status": "pass|fail|unknown", "note": "<short detail>" }
  }
}
\`\`\`

8. If required E2E cannot run in this environment (missing browser/runtime/services), do not hard-fail:
   - keep the best E2E command/settings/mocks
   - add actionable warning text to the top-level \`warnings\` array
   - set \`validation.e2e.status\` to \`unknown\` with reason
9. Retry up to 3 times until all required runnable methods pass, or you reach best effort.
10. If still not fully passing after retries, keep the best config and clearly document why in \`warnings\` and \`validation\`.

Important: Only modify test-config.json, do NOT modify the project's actual source or test files.`

    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: validateSession.id,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false },
      parts: [{ type: "text", text: validatePrompt }],
    })

    if (!state?.running) return

    // Phase 3: Complete
    setPhase("complete")
    const finalConfig = await readConfig()
    state.configContents = finalConfig ?? config
    const warnings = parseWarnings(state.configContents)
    if (warnings.length > 0) {
      warnings.forEach((warning) => progress(`Warning: ${warning}`))
    }
    state.completedAt = Date.now()
    progress("Test config complete.")
    await definition.stop("completed")
  }
}
