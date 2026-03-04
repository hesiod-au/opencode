import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { WorkflowEvent } from "../workflow/events"
import { TestConfigEvent } from "./events"
import { ComposableWorkflow } from "../workflow/composable"
import { WorkflowState } from "../workflow/state"
import { WorkflowStore } from "../workflow/store"
import type { Workflow } from "../workflow/workflow"
import fs from "fs/promises"
import path from "path"

export namespace TestConfigWorkflow {
  const log = Log.create({ service: "test-config" })

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

  async function readConfig(): Promise<Record<string, unknown> | undefined> {
    const configPath = `${Instance.directory}/test-config.json`
    const exists = await Bun.file(configPath)
      .exists()
      .catch(() => false)
    if (!exists) return undefined
    try {
      const text = await Bun.file(configPath).text()
      return parseConfig(JSON.parse(text))
    } catch {
      return undefined
    }
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

  const analyzeStep = ComposableWorkflow.step("analyze", "Analyze Project", async (ctx) => {
    const orchestratorSession = await Session.create({
      parentID: ctx.parentSessionId,
      title: "Test Config — Analysis",
    })
    const runId = WorkflowState.getActiveRun("test-config")?.runId
    if (runId) {
      await WorkflowStore.linkSession({
        runId,
        sessionId: orchestratorSession.id,
        workflowId: "test-config",
        role: "child",
        parentSessionId: ctx.parentSessionId,
      })
    }
    const sessionId = orchestratorSession.id

    const existing = await readConfig()
    const hasExisting = existing !== undefined

    ctx.progress(
      hasExisting ? "Found existing test-config.json, will validate and update" : "Analyzing project structure...",
    )

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
    if (!agent) return { status: "error" as const, output: "Build agent not found" }

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: sessionId,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false, ...ctx.disabledTools },
      parts: [{ type: "text", text: analyzePrompt }],
    })

    if (ctx.abort.aborted) return { status: "error" as const, output: "Aborted" }

    ctx.progress("Analysis complete, reading generated config...")

    const config = await readConfig()
    if (!config) {
      return { status: "error" as const, output: "Agent did not write test-config.json" }
    }

    const language = toStringValue(config.language)
    const framework = toStringValue(config.framework)

    Bus.publish(TestConfigEvent.AnalysisComplete, { language, framework })
    Bus.publish(TestConfigEvent.ConfigWritten, { path: `${Instance.directory}/test-config.json` })

    await addToGitignore()
    ctx.progress(`Config written: language=${language ?? "unknown"}, framework=${framework ?? "unknown"}`)

    return {
      status: "completed" as const,
      output: `Config generated: language=${language}, framework=${framework}`,
      data: { config, sessionId },
    }
  })

  const validateStep = ComposableWorkflow.step("validate", "Validate Config", async (ctx) => {
    const config = (ctx.previousResult?.data?.config as Record<string, unknown>) ?? (await readConfig())
    if (!config) return { status: "error" as const, output: "No config to validate" }

    const validationPlan = getValidationPlan(config)
    if (validationPlan.mode === "none") {
      ctx.progress("No test command in config. Skipping validation.")
      return { status: "completed" as const, output: "No validation needed", data: { config } }
    }

    const runnableSummary = validationPlan.runnable.map((item) => `${item.name}:${item.command}`).join(" | ")
    const missingSummary = validationPlan.missingRequired.join(", ")

    if (runnableSummary) ctx.progress(`Validating config by running: ${runnableSummary}`)
    if (missingSummary) ctx.progress(`Required test methods missing commands: ${missingSummary}`)

    const validateSession = await Session.create({
      parentID: ctx.parentSessionId,
      title: "Test Config — Validation",
    })
    const runId = WorkflowState.getActiveRun("test-config")?.runId
    if (runId) {
      await WorkflowStore.linkSession({
        runId,
        sessionId: validateSession.id,
        workflowId: "test-config",
        role: "child",
        parentSessionId: ctx.parentSessionId,
      })
    }

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

    const agent = await Agent.get("build")
    if (!agent) return { status: "error" as const, output: "Build agent not found" }

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

    await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: validateSession.id,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false, ...ctx.disabledTools },
      parts: [{ type: "text", text: validatePrompt }],
    })

    if (ctx.abort.aborted) return { status: "error" as const, output: "Aborted" }

    const finalConfig = await readConfig()
    const result = finalConfig ?? config
    const warnings = parseWarnings(result)
    if (warnings.length > 0) {
      warnings.forEach((warning) => ctx.progress(`Warning: ${warning}`))
    }
    ctx.progress("Test config complete.")

    return { status: "completed" as const, output: "Validation complete", data: { config: result } }
  })

  export const definition = ComposableWorkflow.define(
    {
      id: "test-config",
      name: "Test Config",
      activationMode: "start",
      toolInvocable: {
        description: [
          "Analyze a project's structure and generate a test-config.json file at the project root.",
          "",
          "Use this tool when:",
          "- The user asks to set up or configure testing for a project",
          "- You need to discover available test commands, frameworks, and file patterns",
          "- The user wants to create or update test-config.json",
          "- You need to know how to run tests but no test-config.json exists yet",
          "",
          "This workflow runs in two phases:",
          "1. Analyze — explores the project to detect language, framework, test commands, Docker support, and writes test-config.json",
          "2. Validate — runs the detected test commands to verify they work, retrying up to 3 times and updating the config if commands fail",
          "",
          "The tool is long-running and autonomous. It returns when both phases complete or an error occurs.",
          "Output includes the final status and any warnings from the generated config.",
          "The generated test-config.json is automatically added to .gitignore.",
        ].join("\n"),
      },
    },
    [analyzeStep, validateStep],
  )
}
