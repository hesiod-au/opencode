import z from "zod"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { WorkflowEvent } from "../workflow/events"
import { WorkflowState } from "../workflow/state"
import { PRReviewEvent } from "./events"
import { GH } from "./gh"
import { Workflow } from "../workflow/workflow"
import { WorkflowOrchestrator } from "../workflow/orchestrator"

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
    runId?: string
    running: boolean
    phase?: Phase
    phaseDetail?: string
    orchestratorSessionId?: string
    startedAt: number
    completedAt?: number
    prNumber?: number
    cycleCount: number
    recheckAttempts: number
    lastCommitSha?: string
    abortController: AbortController
    seenCommentIds: Set<number>
    progressLog: Array<{ message: string; timestamp: number }>
    sessionIds: string[]
    stats: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
  }

  const instanceState = Instance.state(
    () => ({
      current: null as State | null,
    }),
    async (data) => {
      if (data.current?.running) {
        data.current.abortController.abort()
      }
    },
  )
  type ReviewAction = "fix" | "ignore"
  type AssessedComment = GH.ReviewComment & {
    action: ReviewAction
    reason: string
  }
  type InvestigatedFixResult = {
    sessionId: string
    appliedFix: boolean
  }

  function setPhase(phase: Phase, detail?: string) {
    const state = instanceState().current
    if (!state) return
    state.phase = phase
    state.phaseDetail = detail
    log.info("phase changed", { phase, detail })

    Bus.publish(WorkflowEvent.PhaseChanged, {
      workflowId: "pr-review",
      phase,
      detail,
      runId: state.runId,
    })

    if (state.runId) {
      WorkflowState.updateStatus(state.runId, { phase, phaseDetail: detail })
    }
  }

  async function logToSession(text: string): Promise<void> {
    const state = instanceState().current
    if (!state?.orchestratorSessionId) {
      log.error("logToSession called without orchestrator session")
      return
    }
    await WorkflowOrchestrator.logProgress(state.orchestratorSessionId, text)
  }

  function progress(message: string) {
    log.info("progress", { message })
    const state = instanceState().current
    if (state) {
      state.progressLog.push({ message, timestamp: Date.now() })
      if (state.progressLog.length > 100) state.progressLog.shift()
    }
    Bus.publish(WorkflowEvent.Progress, {
      workflowId: "pr-review",
      message,
      runId: state?.runId,
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

  async function workingTreeStatus(): Promise<string> {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: Instance.directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trim()
  }

  function responseText(result: { parts: Array<{ type: string; text?: string }> }): string {
    return result.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("\n\n")
      .trim()
  }

  function isLikelyNoAction(body: string): boolean {
    const text = body.toLowerCase()
    return [
      "looks good",
      "lgtm",
      "approve",
      "approved",
      "no changes",
      "nothing to do",
      "nothing else",
      "not needed",
      "resolved",
      "thanks",
      "thank you",
      "nit:",
      "nitpick",
      "ack",
    ].some((phrase) => text.includes(phrase))
  }

  function parseAssessmentText(text: string): Array<{
    id: number
    action: ReviewAction
    reason: string
  }> {
    const decode = (raw: unknown) => {
      if (typeof raw !== "object" || raw === null) return []
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { assessments?: unknown }).assessments)
          ? (raw as { assessments: unknown }).assessments
          : []
      if (!Array.isArray(list)) return []
      return list
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return undefined
          const item = entry as {
            id?: unknown
            action?: unknown
            reason?: unknown
          }
          if (typeof item.id !== "number") return undefined
          const action = (
            typeof item.action === "string" && (item.action === "fix" || item.action === "ignore") ? item.action : "fix"
          ) as ReviewAction

          return {
            id: item.id,
            action,
            reason: typeof item.reason === "string" ? item.reason : "Automated triage",
          }
        })
        .filter((item): item is { id: number; action: ReviewAction; reason: string } => item !== undefined)
    }

    try {
      return decode(JSON.parse(text))
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match?.[0]) return []
      try {
        return decode(JSON.parse(match[0]))
      } catch {
        return []
      }
    }
  }

  async function assessComments(comments: GH.ReviewComment[]): Promise<AssessedComment[]> {
    if (comments.length === 0) return []

    const state = instanceState().current

    const fallback = comments.map((comment) => {
      const isIgnore = isLikelyNoAction(comment.body)
      const reason = isIgnore ? "Likely non-actionable review note" : "Automated default"
      return {
        ...comment,
        action: isIgnore ? "ignore" : "fix",
        reason,
      } as AssessedComment
    })
    if (!state?.orchestratorSessionId) return fallback

    const agent = await Agent.get("build")
    if (!agent) return fallback

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
    const payload = comments
      .map((comment) => ({
        id: comment.id,
        user: comment.user.login,
        path: comment.path,
        line: comment.line,
        body: comment.body,
      }))
      .map((comment) => JSON.stringify(comment))
      .join("\n")

    const prompt = `# PR Review Comment Triage

Classify each review comment as one of:
- fix: actionable and should be investigated before deciding how to resolve
- ignore: non-actionable (ack/nice/thank-you/looks good)

For each item, output strict JSON with this shape:
{"assessments":[{"id":123,"action":"fix|ignore","reason":"short reason"}]}

Only output JSON, no markdown.

COMMENTS:
${payload}
`

    const messageID = Identifier.ascending("message")
    const result = await SessionPrompt.prompt({
      messageID,
      sessionID: state.orchestratorSessionId,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false, workflow_task: true, ...Workflow.buildDisabledTools(definition) },
      parts: [{ type: "text", text: prompt }],
    })

    const parsed = parseAssessmentText(responseText(result))
    if (parsed.length === 0) return fallback
    const byId = new Map(parsed.map((item) => [item.id, item]))

    return comments.map((comment) => {
      const item = byId.get(comment.id)
      if (!item) {
        return {
          ...comment,
          action: "fix",
          reason: "Classification not returned",
        } as AssessedComment
      }
      return {
        ...comment,
        action: item.action,
        reason: item.reason,
      }
    })
  }

  async function runFixAgent(comment: AssessedComment): Promise<InvestigatedFixResult> {
    const state = instanceState().current
    const fixSession = await Session.create({
      parentID: state?.orchestratorSessionId,
      title: `PR Review Fix — Cycle ${state?.cycleCount ?? 0}`,
    })
    if (state) state.sessionIds.push(fixSession.id)

    const location = comment.path ? `File: ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "General comment"
    const commentText = `### ${comment.user.login} (${location})\n${comment.body}`
    const investigatePrompt = `# PR Review Feedback — Root Cause Investigation and Fix

Issue:
${commentText}

Investigate the root cause deeply in surrounding code.
Then decide the best action:
- If this is local/single-scope and safe, fix it directly in this session.
- If this is cross-file, architectural, or wide-ranging, escalate and stop local edits.

Before continuing, if escalation is required, invoke:
tool: workflow_task
userPrompt: Original issue: ${commentText}
Investigation outcome: {brief finding + category + rationale}

If the issue is local, continue with a minimal code fix in this same message.
`

    const agent = await Agent.get("build")
    if (!agent) throw new Error("Build agent not found")

    const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
    const preFixState = await workingTreeStatus()
    const assessResult = await SessionPrompt.prompt({
      messageID: Identifier.ascending("message"),
      sessionID: fixSession.id,
      model: { modelID: model.modelID, providerID: model.providerID },
      agent: agent.name,
      variant: "max",
      tools: { question: false, workflow_task: true, ...Workflow.buildDisabledTools(definition) },
      parts: [{ type: "text", text: investigatePrompt }],
    })
    const calledTaskMode = assessResult.parts.some(
      (part) => part.type === "tool" && (part as { tool?: string }).tool === "workflow_task",
    )
    if (!calledTaskMode) {
      const postFixState = await workingTreeStatus()
      if (preFixState === postFixState) {
        log.warn("root cause investigation completed without local changes or escalation", { sessionId: fixSession.id })
        progress("Root cause investigation did not produce a local patch; review may be needed.")
      }

      return { sessionId: fixSession.id, appliedFix: preFixState !== postFixState }
    }

    const postFixState = await workingTreeStatus()
    return { sessionId: fixSession.id, appliedFix: preFixState !== postFixState }
  }

  export const definition: Workflow.Definition<Phase> = {
    id: "pr-review",
    name: "PR Review",
    activationMode: "start",
    toolInvocable: {
      description: [
        "Run an automated PR review feedback loop that addresses reviewer comments on a GitHub pull request.",
        "",
        "Use this tool when:",
        "- The user asks to address or fix PR review feedback",
        "- The user wants to automate the review-fix-commit cycle for a pull request",
        "- There are outstanding review comments on a PR that need to be resolved",
        "",
        "The workflow runs in cycles (up to 20 by default):",
        "1. Fetch review comments since the last commit",
        "2. Run an agent to make code changes addressing the feedback",
        "3. Run tests (auto-detected) and fix failures if needed",
        "4. Commit and push the changes",
        "5. Post a review request comment, then wait for new comments",
        "6. Repeat until no new comments remain or max cycles reached",
        "",
        "If no prNumber is provided, the workflow auto-detects the PR for the current branch.",
        "The tool is long-running. It returns the final status when all cycles complete or an error occurs.",
      ].join("\n"),
      parameters: z.object({
        prNumber: z.number().optional().describe("PR number to review. Auto-detects from current branch if omitted."),
      }),
    },

    async start(options) {
      if (instanceState().current?.running) {
        log.warn("pr-review workflow already running")
        return
      }

      const runId = options.runId ?? WorkflowState.startRun("pr-review")

      const config = await Config.get()
      const prConfig = config.prReview

      // Initialize orchestrator session (use existing or create new)
      const orchestratorSessionId = await WorkflowOrchestrator.initializeOrchestrator(
        "PR Review",
        options.parentSessionId,
      )

      instanceState().current = {
        runId,
        running: true,
        orchestratorSessionId,
        startedAt: Date.now(),
        cycleCount: 0,
        recheckAttempts: 0,
        abortController: new AbortController(),
        seenCommentIds: new Set(),
        progressLog: [],
        sessionIds: [],
        stats: { inputTokens: 0, outputTokens: 0, cost: 0, modifiedFiles: [] },
      }

      WorkflowState.updateStatus(runId, {
        running: true,
        parentSessionId: orchestratorSessionId,
        startedAt: Date.now(),
      })

      Bus.publish(WorkflowEvent.Started, {
        workflowId: "pr-review",
        parentSessionId: orchestratorSessionId,
        runId,
      })

      // Resolve PR number from tool args, config, or auto-detect
      let toolPrNumber: number | undefined
      if (options.userPrompt) {
        try {
          const parsed = JSON.parse(options.userPrompt)
          toolPrNumber = parsed?.prNumber
        } catch {}
      }
      const prNumber = toolPrNumber ?? prConfig?.prNumber ?? (await GH.getCurrentBranchPR())
      if (!prNumber) {
        progress("No PR found for current branch. Use --pr <number> or prReview.prNumber config.")
        await definition.stop("error")
        return
      }

      instanceState().current!.prNumber = prNumber
      progress(`Starting PR review cycle for PR #${prNumber}`)

      // Set orchestrator to busy
      WorkflowOrchestrator.setBusy(orchestratorSessionId)

      // Run the main loop
      const maxCycles = prConfig?.maxCycles ?? 20
      const pollMinutes = prConfig?.pollIntervalMinutes ?? 2
      const maxRecheckAttempts = prConfig?.maxRecheckAttempts ?? 5
      const reviewComment = prConfig?.reviewRequestComment ?? "@codex review"

      try {
        await reviewLoop({ prNumber, maxCycles, pollMinutes, reviewComment, maxRecheckAttempts })
      } catch (err: any) {
        log.error("pr-review loop error", { error: err })
        progress(`Error: ${err.message}`)
        await definition.stop("error")
      }
    },

    async stop(reason) {
      const state = instanceState().current
      if (!state) return
      log.info("stopping pr-review", { reason })

      const runId = state.runId
      state.running = false
      state.completedAt = Date.now()
      state.abortController.abort()

      if (state.orchestratorSessionId) {
        WorkflowOrchestrator.setIdle(state.orchestratorSessionId)
      }

      if (runId) {
        WorkflowState.endRun(runId, reason)
        WorkflowState.updateStatus(runId, {
          running: false,
          completedAt: state.completedAt,
        })
      }

      Bus.publish(WorkflowEvent.Stopped, {
        workflowId: "pr-review",
        reason,
        runId,
      })

      instanceState().current = null
    },

    getStatus() {
      const state = instanceState().current
      const activeRun = WorkflowState.getActiveRun("pr-review")
      return {
        running: state?.running ?? false,
        phase: state?.phase,
        phaseDetail: state?.phaseDetail,
        parentSessionId: state?.orchestratorSessionId,
        startedAt: state?.startedAt,
        completedAt: state?.completedAt,
        runId: state?.runId ?? activeRun?.runId,
        progress: activeRun?.status.progress,
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
      return instanceState().current?.running ?? false
    },
  }

  async function reviewLoop(opts: {
    prNumber: number
    maxCycles: number
    pollMinutes: number
    reviewComment: string
    maxRecheckAttempts: number
  }) {
    const state = instanceState().current
    if (!state || !state.orchestratorSessionId) return

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

    while (state?.running) {
      const cycle = state.cycleCount + 1
      if (!state?.running) return

      // 1. Fetch comments since last commit
      setPhase("fetching-comments", `Cycle ${cycle}`)
      progress(`Cycle ${cycle}: Fetching review comments since ${state.lastCommitSha?.slice(0, 7)}...`)

      const comments = await GH.getCommentsSinceCommit(opts.prNumber, state.lastCommitSha!)
      const unseen = comments.filter((comment) => !state?.seenCommentIds.has(comment.id))
      unseen.forEach((comment) => state?.seenCommentIds.add(comment.id))
      const assessed = await assessComments(unseen)
      const actionable = assessed.filter((comment) => comment.action === "fix")

      if (actionable.length === 0) {
        state.recheckAttempts += 1

        if (state.recheckAttempts >= opts.maxRecheckAttempts) {
          setPhase("completing")
          progress("No actionable review comments after re-check attempts. All feedback addressed.")
          Bus.publish(PRReviewEvent.NoNewComments, {})
          await definition.stop("completed")
          return
        }

        setPhase("waiting", `${opts.pollMinutes} minutes`)
        progress(`No new actionable comments. Waiting ${opts.pollMinutes} minutes for next review...`)
        WorkflowOrchestrator.setWaiting(state.orchestratorSessionId!)

        const aborted = await sleep(opts.pollMinutes * 60 * 1000, state.abortController.signal)
        if (aborted || !state?.running) return

        setPhase("checking-comments")
        progress("Checking for new review comments...")
        WorkflowOrchestrator.setBusy(state.orchestratorSessionId!)
        continue
      }

      if (cycle > opts.maxCycles) {
        progress(`Reached max cycles (${opts.maxCycles}). Stopping.`)
        await definition.stop("completed")
        return
      }

      state.recheckAttempts = 0
      state.cycleCount = cycle

      let localFixCount = 0
      let taskModeCount = 0

      for (const comment of actionable) {
        const result = await runFixAgent(comment).catch((err) => {
          log.error("fix agent failed", { error: err, commentId: comment.id })
          return { sessionId: "", appliedFix: false }
        })

        if (result.appliedFix) {
          localFixCount += 1
        } else {
          taskModeCount += 1
        }
      }

      if (localFixCount === 0) {
        Bus.publish(PRReviewEvent.CycleStarted, {
          cycleNumber: cycle,
          commentCount: actionable.length,
        })
        progress(
          `Found ${actionable.length} actionable comment(s); no local fixes applied (${taskModeCount} handed to task mode).`,
        )
        // Skip tests and commit when no local changes were made.
      } else {
        progress(`Found ${actionable.length} actionable comment(s)`)
        Bus.publish(PRReviewEvent.CycleStarted, {
          cycleNumber: cycle,
          commentCount: localFixCount,
        })
        const phase = `${localFixCount} comments`
        // 2. Run fix agent per actionable comment
        setPhase("fixing", phase)
        progress(`Running agents to address ${phase}...`)

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
                tools: { question: false, workflow_task: true, ...Workflow.buildDisabledTools(definition) },
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

          if (!testsPassed && !state.running) return
        }

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
      }

      if (cycle >= opts.maxCycles) {
        progress(`Reached max cycles (${opts.maxCycles}). Stopping.`)
        await definition.stop("completed")
        return
      }

      // 6. Wait for next review
      setPhase("waiting", `${opts.pollMinutes} minutes`)
      progress(`Waiting ${opts.pollMinutes} minutes for new review comments...`)
      WorkflowOrchestrator.setWaiting(state.orchestratorSessionId!)

      const aborted = await sleep(opts.pollMinutes * 60 * 1000, state.abortController.signal)
      if (aborted || !state?.running) return

      // 7. Check for new comments
      setPhase("checking-comments")
      progress("Checking for new review comments...")
      WorkflowOrchestrator.setBusy(state.orchestratorSessionId!)
    }
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
