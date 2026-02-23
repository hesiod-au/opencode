import { Log } from "../util/log"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { WorkflowEvent } from "../workflow/events"
import { PRReviewEvent } from "./events"
import { GH } from "./gh"
import type { Workflow } from "../workflow/workflow"

export namespace PRReviewWorkflow {
  const log = Log.create({ service: "pr-review" })

  type Phase =
    | "fetching-comments"
    | "fixing"
    | "testing"
    | "committing"
    | "requesting-review"
    | "waiting"
    | "checking-comments"
    | "completing"

  interface State {
    running: boolean
    phase?: Phase
    phaseDetail?: string
    orchestratorSessionId?: string
    startedAt: number
    completedAt?: number
    prNumber?: number
    cycleCount: number
    lastCommitSha?: string
    abortController: AbortController
    progressLog: Array<{ message: string; timestamp: number }>
    sessionIds: string[]
    stats: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
  }

  let state: State | null = null

  function setPhase(phase: Phase, detail?: string) {
    if (!state) return
    state.phase = phase
    state.phaseDetail = detail
    log.info("phase changed", { phase, detail })

    Bus.publish(WorkflowEvent.PhaseChanged, {
      workflowId: "pr-review",
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
      workflowId: "pr-review",
      message,
    })
    logToSession(message).catch((err) => log.error("logToSession error", { error: err }))
  }

  async function detectTestCommand(): Promise<string | undefined> {
    const config = await Config.get()
    const prConfig = config.prReview
    if (prConfig?.testCommand) return prConfig.testCommand

    // Auto-detect test command from project files
    const dir = Instance.directory
    const hasBunLock = await Bun.file(`${dir}/bun.lock`)
      .exists()
      .catch(() => false)
    const hasPackageJson = await Bun.file(`${dir}/package.json`)
      .exists()
      .catch(() => false)
    const hasPytest = await Bun.file(`${dir}/pytest.ini`)
      .exists()
      .catch(() => false)
    const hasPyprojectToml = await Bun.file(`${dir}/pyproject.toml`)
      .exists()
      .catch(() => false)
    const hasGoMod = await Bun.file(`${dir}/go.mod`)
      .exists()
      .catch(() => false)
    const hasMakefile = await Bun.file(`${dir}/Makefile`)
      .exists()
      .catch(() => false)

    if (hasPytest || hasPyprojectToml) return "pytest"
    if (hasGoMod) return "go test ./..."
    if (hasBunLock) return "bun test"
    if (hasPackageJson) return "npm test"
    if (hasMakefile) return "make test"

    return undefined
  }

  async function runTests(testCommand: string): Promise<{ success: boolean; output: string }> {
    const parts = testCommand.split(" ")
    const proc = Bun.spawn(parts, {
      cwd: Instance.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return {
      success: exitCode === 0,
      output: stdout + (stderr ? `\nStderr:\n${stderr}` : ""),
    }
  }

  async function runFixAgent(comments: any[]): Promise<{ success: boolean; sessionId: string }> {
    const fixSession = await Session.create({
      parentID: state?.orchestratorSessionId,
      title: `PR Review Fix — Cycle ${state?.cycleCount ?? 0}`,
    })

    const commentText = comments
      .map((c) => {
        const location = c.path ? `File: ${c.path}${c.line ? `:${c.line}` : ""}` : "General comment"
        return `### ${c.user.login} (${location})\n${c.body}`
      })
      .join("\n\n---\n\n")

    const prompt = `# PR Review Feedback — Fix Required

The following review comments were left on the PR. Address each one:

${commentText}

## Instructions

1. Read and understand each review comment
2. Make the necessary code changes to address the feedback
3. Ensure all changes are correct and complete
4. Do NOT break existing functionality
5. Keep changes minimal and focused on the review feedback
`

    const agent = await Agent.get("build")
    if (!agent) throw new Error("Build agent not found")

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
    const messageID = Identifier.ascending("message")

    await SessionPrompt.prompt({
      messageID,
      sessionID: fixSession.id,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      parts: [{ type: "text", text: prompt }],
    })

    if (state) state.sessionIds.push(fixSession.id)
    return { success: true, sessionId: fixSession.id }
  }

  export const definition: Workflow.Definition<Phase> = {
    id: "pr-review",
    name: "PR Review",

    async start(options) {
      if (state?.running) {
        log.warn("pr-review workflow already running")
        return
      }

      const config = await Config.get()
      const prConfig = config.prReview

      // Create an orchestrator session to track progress
      const orchestratorSession = await Session.create({
        title: "PR Review",
      })

      state = {
        running: true,
        orchestratorSessionId: orchestratorSession.id,
        startedAt: Date.now(),
        cycleCount: 0,
        abortController: new AbortController(),
        progressLog: [],
        sessionIds: [],
        stats: { inputTokens: 0, outputTokens: 0, cost: 0, modifiedFiles: [] },
      }

      Bus.publish(WorkflowEvent.Started, {
        workflowId: "pr-review",
        parentSessionId: orchestratorSession.id,
      })

      // Resolve PR number
      const prNumber = prConfig?.prNumber ?? (await GH.getCurrentBranchPR())
      if (!prNumber) {
        progress("No PR found for current branch. Use --pr <number> or prReview.prNumber config.")
        await definition.stop("error")
        return
      }

      state.prNumber = prNumber
      progress(`Starting PR review cycle for PR #${prNumber}`)

      // Run the main loop
      const maxCycles = prConfig?.maxCycles ?? 20
      const pollMinutes = prConfig?.pollIntervalMinutes ?? 2
      const reviewComment = prConfig?.reviewRequestComment ?? "@codex review"

      try {
        await reviewLoop({ prNumber, maxCycles, pollMinutes, reviewComment })
      } catch (err: any) {
        log.error("pr-review loop error", { error: err })
        progress(`Error: ${err.message}`)
        await definition.stop("error")
      }
    },

    async stop(reason) {
      if (!state) return
      log.info("stopping pr-review", { reason })

      state.running = false
      state.completedAt = Date.now()
      state.abortController.abort()

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "pr-review",
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
          prNumber: state?.prNumber,
          cycleCount: state?.cycleCount,
          lastCommitSha: state?.lastCommitSha,
          progressLog: state?.progressLog ?? [],
          sessionIds: state?.sessionIds ?? [],
          orchestratorSessionId: state?.orchestratorSessionId,
        },
      }
    },

    isRunning() {
      return state?.running ?? false
    },
  }

  async function reviewLoop(opts: { prNumber: number; maxCycles: number; pollMinutes: number; reviewComment: string }) {
    if (!state) return

    // Get initial HEAD commit
    state.lastCommitSha = await GH.getLastCommitSha()
    log.info("initial commit", { sha: state.lastCommitSha })

    // Detect test command
    const testCommand = await detectTestCommand()
    if (testCommand) {
      progress(`Detected test command: ${testCommand}`)
    } else {
      progress("No test command detected — skipping test phase")
    }

    for (let cycle = 1; cycle <= opts.maxCycles; cycle++) {
      if (!state?.running) return

      state.cycleCount = cycle

      // 1. Fetch comments since last commit
      setPhase("fetching-comments", `Cycle ${cycle}`)
      progress(`Cycle ${cycle}: Fetching review comments since ${state.lastCommitSha?.slice(0, 7)}...`)

      const comments = await GH.getCommentsSinceCommit(opts.prNumber, state.lastCommitSha!)

      if (comments.length === 0) {
        if (cycle === 1) {
          progress("No review comments found. Nothing to do.")
          Bus.publish(PRReviewEvent.NoNewComments, {})
          await definition.stop("completed")
          return
        }

        setPhase("completing")
        progress("No new review comments. All feedback addressed!")
        Bus.publish(PRReviewEvent.NoNewComments, {})
        await definition.stop("completed")
        return
      }

      progress(`Found ${comments.length} review comment(s)`)
      Bus.publish(PRReviewEvent.CycleStarted, {
        cycleNumber: cycle,
        commentCount: comments.length,
      })

      // 2. Run fix agent
      setPhase("fixing", `${comments.length} comments`)
      progress(`Running agent to address ${comments.length} comment(s)...`)

      const fixResult = await runFixAgent(comments).catch((err) => {
        log.error("fix agent failed", { error: err })
        return { success: false, sessionId: "" }
      })

      if (!fixResult.success) {
        progress("Fix agent failed. Stopping.")
        await definition.stop("error")
        return
      }

      // 3. Run tests (if test command available)
      if (testCommand && state.running) {
        setPhase("testing")
        progress("Running tests...")

        const maxTestRetries = 5
        let testsPassed = false

        for (let attempt = 1; attempt <= maxTestRetries; attempt++) {
          const testResult = await runTests(testCommand)
          if (testResult.success) {
            progress(`Tests passed (attempt ${attempt})`)
            testsPassed = true
            break
          }

          if (attempt < maxTestRetries) {
            progress(`Tests failed (attempt ${attempt}/${maxTestRetries}), running fix agent...`)
            // Feed test output to the fix agent
            const testFixSession = await Session.create({
              parentID: state.orchestratorSessionId,
              title: `Test Fix — Cycle ${cycle}, Attempt ${attempt}`,
            })

            const agent = await Agent.get("build")
            if (!agent) break

            const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
            await SessionPrompt.prompt({
              messageID: Identifier.ascending("message"),
              sessionID: testFixSession.id,
              model: { modelID: model.modelID, providerID: model.providerID },
              agent: agent.name,
              variant: "max",
              parts: [
                {
                  type: "text",
                  text: `# Test Failure — Fix Required\n\nTest command: \`${testCommand}\`\n\nOutput:\n\`\`\`\n${testResult.output.slice(0, 8000)}\n\`\`\`\n\nFix the failing tests without breaking other functionality.`,
                },
              ],
            })
          } else {
            progress(`Tests failed after ${maxTestRetries} attempts. Continuing with commit anyway.`)
          }
        }
      }

      if (!state?.running) return

      // 4. Commit and push
      setPhase("committing")
      progress("Committing and pushing changes...")

      const newSha = await GH.addAndCommitAndPush("Address PR review feedback").catch((err) => {
        log.error("commit/push failed", { error: err })
        return undefined
      })

      if (!newSha) {
        progress("Failed to commit/push. Stopping.")
        await definition.stop("error")
        return
      }

      state.lastCommitSha = newSha
      Bus.publish(PRReviewEvent.CycleCompleted, {
        cycleNumber: cycle,
        commitSha: newSha,
      })

      progress(`Pushed commit ${newSha.slice(0, 7)}`)

      // 5. Request review
      setPhase("requesting-review")
      progress(`Posting review request comment...`)

      await GH.postComment(opts.prNumber, opts.reviewComment).catch((err) => {
        log.warn("failed to post review comment", { error: err })
      })

      // 6. Wait for next review
      if (cycle < opts.maxCycles) {
        setPhase("waiting", `${opts.pollMinutes} minutes`)
        progress(`Waiting ${opts.pollMinutes} minutes for new review comments...`)

        const aborted = await sleep(opts.pollMinutes * 60 * 1000, state.abortController.signal)
        if (aborted || !state?.running) return

        // 7. Check for new comments
        setPhase("checking-comments")
        progress("Checking for new review comments...")
      }
    }

    progress(`Reached max cycles (${opts.maxCycles}). Stopping.`)
    await definition.stop("completed")
  }

  function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve(true)
        },
        { once: true },
      )
    })
  }
}
