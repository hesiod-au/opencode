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
      return JSON.parse(text)
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
4. Write the final \`test-config.json\` using the write tool with this schema:

\`\`\`json
{
  "version": 1,
  "language": "<primary language>",
  "framework": "<test framework>",
  "docker": {
    "enabled": true,
    "image": "<appropriate base image>",
    "workdir": "/app",
    "setup": ["<install commands>"]
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
  }
}
\`\`\`

Be thorough but concise. Use the actual commands that work for this project.`

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

    Bus.publish(TestConfigEvent.AnalysisComplete, {
      language: (config.language as string) ?? undefined,
      framework: (config.framework as string) ?? undefined,
    })

    Bus.publish(TestConfigEvent.ConfigWritten, {
      path: `${Instance.directory}/test-config.json`,
    })

    await addToGitignore()
    progress(`Config written: language=${config.language}, framework=${config.framework}`)

    // Phase 2: Validating
    if (!state?.running) return

    const testCommand = (config.commands as any)?.test
    if (!testCommand) {
      progress("No test command in config. Skipping validation.")
      setPhase("complete")
      state.configContents = config
      state.completedAt = Date.now()
      progress("Test config complete.")
      await definition.stop("completed")
      return
    }

    setPhase("validating", "Running tests to verify config")
    progress(`Validating config by running: ${testCommand}`)

    const validateSession = await Session.create({
      parentID: state.orchestratorSessionId,
      title: "Test Config — Validation",
    })

    const validatePrompt = `# Test Config — Validation

A \`test-config.json\` has been generated for this project. Your job is to validate it works correctly.

## Steps

1. Read the \`test-config.json\` file
2. Run the test command from the config using the bash tool
3. If tests fail:
   - Diagnose the issue (missing dependencies, wrong command, incorrect paths, etc.)
   - Update \`test-config.json\` to fix the problem
   - Run the test command again
4. Retry up to 3 times until tests pass
5. If tests still fail after 3 attempts, leave the best config you can and report what went wrong

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
    state.completedAt = Date.now()
    progress("Test config complete.")
    await definition.stop("completed")
  }
}
