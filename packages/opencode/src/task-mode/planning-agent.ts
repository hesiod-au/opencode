import { Log } from "../util/log"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { TaskList } from "./task-list"
import { TaskFile } from "./task-file"
import { TaskModeEvent } from "./events"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { PlanningPrompts } from "./planning-prompts"
import { ClaudeCli } from "./claude-cli"
import fs from "fs/promises"

export namespace PlanningAgent {
  const log = Log.create({ service: "planning-agent" })

  async function logToParent(parentSessionId: string | undefined, text: string): Promise<void> {
    if (!parentSessionId) {
      log.warn("logToParent called but no parentSessionId", { text: text.slice(0, 50) })
      return
    }

    try {
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")

      log.info("logToParent: creating message", { messageID, parentSessionId, text: text.slice(0, 50) })

      await Session.updateMessage({
        id: messageID,
        sessionID: parentSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "planning",
        model: { providerID: "system", modelID: "planning-agent" },
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

  export interface PlanningOptions {
    paths: TaskList.Paths
    parentSessionId?: string
    context?: string
    userPrompt?: string
  }

  export interface PlanningResult {
    success: boolean
    sessionId: string
    taskCount: number
    error?: string
  }

  export async function generatePlan(options: PlanningOptions): Promise<PlanningResult> {
    const config = await Config.get()
    const enhancedTasks = config.taskMode?.enhancedTasks ?? true

    if (enhancedTasks) {
      return generatePlanEnhanced(options)
    }
    return generatePlanClassic(options)
  }

  async function resolveSession(parentSessionId?: string): Promise<string> {
    const session = await Session.create({
      parentID: parentSessionId,
      title: "Task Planning Session",
    })
    // Auto-allow all permissions to prevent blocking on "ask" prompts
    // in the child session where no user is watching.
    // Deny question tool since no user is available to answer.
    await Session.update(session.id, (draft) => {
      draft.permission = [
        { permission: "*", action: "allow", pattern: "*" },
        { permission: "question", action: "deny", pattern: "*" },
      ]
    })
    log.info("planning agent created session", { sessionId: session.id, parentId: parentSessionId })
    return session.id
  }

  async function fetchConversationContext(parentSessionId?: string): Promise<string | undefined> {
    if (!parentSessionId) return undefined
    try {
      const parentMessages = await Session.messages({ sessionID: parentSessionId, includeCompacted: false })
      log.info("fetched parent session messages for planning context", {
        parentSessionId,
        messageCount: parentMessages.length,
      })
      return parentMessages.length > 0 ? buildConversationSummary(parentMessages) : undefined
    } catch (err) {
      log.warn("failed to fetch parent session messages", { parentSessionId, error: err })
      return undefined
    }
  }

  function extractResponseText(result: { parts: Array<{ type: string; text?: string }> }): string {
    return result.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n\n")
  }

  function analyzeDescriptionCoverage(
    tasks: TaskList.TaskEntry[],
    descriptions: Map<string, string>,
  ): { total: number; withDescriptions: number; missingIds: string[] } {
    const missingIds: string[] = []
    for (const task of tasks) {
      const desc = descriptions.get(task.id)
      if (!desc || desc.trim().length === 0 || desc.trim() === task.title.trim()) {
        missingIds.push(task.id)
      }
    }
    return { total: tasks.length, withDescriptions: tasks.length - missingIds.length, missingIds }
  }

  async function finalizePlan(
    plan: TaskList.TaskListFile,
    paths: TaskList.Paths,
    sessionId: string,
    parentSessionId?: string,
  ): Promise<PlanningResult> {
    await fs.mkdir(paths.tasksDir, { recursive: true })
    await TaskList.write(paths.taskListPath, plan)

    if (parentSessionId) {
      const session = await Session.get(parentSessionId)
      if (session && Session.isDefaultTitle(session.title)) {
        const shorten = (v: string) => (v.length > 100 ? v.substring(0, 97) + "..." : v)
        const planTitle =
          plan.description?.trim() ||
          (plan.title && plan.title !== "Task List" ? plan.title.trim() : undefined)
        if (planTitle) {
          await Session.update(parentSessionId, (draft) => {
            draft.title = shorten(planTitle)
          })
          log.info("renamed parent session from plan", { parentSessionId, title: shorten(planTitle) })
        }
      }
    }

    for (const task of plan.tasks) {
      const description = (task as any)._description || task.title
      const taskFile: TaskFile.TaskFileData = {
        id: task.id,
        title: task.title,
        description,
        status: "todo",
        dependencies: task.dependencies,
      }
      await TaskFile.write(TaskFile.getFilePath(paths.tasksDir, task.id), taskFile)
    }

    Bus.publish(TaskModeEvent.PlanningCompleted, { sessionId, taskCount: plan.tasks.length })
    log.info("planning completed", { sessionId, taskCount: plan.tasks.length })

    const taskSummary = plan.tasks.map((t) => `- **${t.id}**: ${t.title}`).join("\n")
    await logToParent(parentSessionId, `**Planning completed** ✓\n\nGenerated ${plan.tasks.length} tasks:\n\n${taskSummary}`)

    return { success: true, sessionId, taskCount: plan.tasks.length }
  }

  async function generatePlanClassic(options: PlanningOptions): Promise<PlanningResult> {
    const { paths, parentSessionId, context, userPrompt } = options
    log.info("starting classic planning agent", { taskListPath: paths.taskListPath })

    const sessionId = await resolveSession(parentSessionId)
    Bus.publish(TaskModeEvent.PlanningStarted, { sessionId })

    try {
      const agent = await Agent.get("build")
      if (!agent) throw new Error("Build agent not found")

      const conversationContext = await fetchConversationContext(parentSessionId)
      const messageID = Identifier.ascending("message")
      const prompt = PlanningPrompts.buildCombinedPlanningPrompt(context, conversationContext, userPrompt)
      const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: sessionId,
        model: { modelID: model.modelID, providerID: model.providerID },
        agent: agent.name,
        variant: "max",
        parts: [{ type: "text", text: prompt }],
      })

      const responseText = extractResponseText(result)
      const plan = parsePlanFromResponse(responseText)
      if (plan.tasks.length === 0) throw new Error("Planning agent did not generate any tasks")

      return finalizePlan(plan, paths, sessionId, parentSessionId)
    } catch (err: any) {
      log.error("planning failed", { error: err })
      await logToParent(parentSessionId, `**Planning failed:** ${err.message || String(err)}`)
      return { success: false, sessionId, taskCount: 0, error: err.message || String(err) }
    }
  }

  async function generatePlanEnhanced(options: PlanningOptions): Promise<PlanningResult> {
    const { paths, parentSessionId, context, userPrompt } = options
    log.info("starting enhanced planning agent", { taskListPath: paths.taskListPath })

    const sessionId = await resolveSession(parentSessionId)
    Bus.publish(TaskModeEvent.PlanningStarted, { sessionId })

    try {
      const agent = await Agent.get("build")
      if (!agent) throw new Error("Build agent not found")

      const conversationContext = await fetchConversationContext(parentSessionId)
      const planOnlyPrompt = PlanningPrompts.buildPlanOnlyPrompt(context, conversationContext, userPrompt)
      const model = agent.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      await logToParent(parentSessionId, "**Enhanced planning:** dispatching plan to default model and Claude CLI in parallel...")

      // Phase 1: Parallel dispatch for plan table
      const [defaultResult, cliResult] = await Promise.allSettled([
        (async () => {
          const messageID = Identifier.ascending("message")
          const result = await SessionPrompt.prompt({
            messageID,
            sessionID: sessionId,
            model: { modelID: model.modelID, providerID: model.providerID },
            agent: agent.name,
            variant: "max",
            parts: [{ type: "text", text: planOnlyPrompt }],
          })
          return extractResponseText(result)
        })(),
        ClaudeCli.invokeClaude(planOnlyPrompt, Instance.directory, {
          onProgress: (info) => {
            logToParent(
              parentSessionId,
              `**Claude CLI:** ${info.totalChars} chars generated (${Math.round(info.elapsedMs / 1000)}s)...`,
            )
          },
          progressIntervalMs: 15_000,
        }),
      ])

      const defaultPlan = defaultResult.status === "fulfilled" ? defaultResult.value : null
      const cliPlan = cliResult.status === "fulfilled" ? cliResult.value : null

      if (defaultResult.status === "rejected") {
        log.warn("default model plan failed", { error: defaultResult.reason })
      }
      if (cliResult.status === "rejected") {
        log.warn("claude CLI plan failed", { error: cliResult.reason })
      }

      // Determine final plan table
      let finalPlanText: string
      if (defaultPlan && cliPlan) {
        await logToParent(parentSessionId, "**Enhanced planning:** both plans received, assessing and synthesizing...")

        // Randomize which is A vs B to reduce positional bias
        const swapped = Math.random() < 0.5
        const planA = swapped ? cliPlan : defaultPlan
        const planB = swapped ? defaultPlan : cliPlan
        const sourceA = swapped ? "Claude CLI" : "Default Model"
        const sourceB = swapped ? "Default Model" : "Claude CLI"

        try {
          const assessmentPrompt = PlanningPrompts.buildAssessmentPrompt(planA, planB, sourceA, sourceB)
          const assessMessageID = Identifier.ascending("message")
          const assessResult = await SessionPrompt.prompt({
            messageID: assessMessageID,
            sessionID: sessionId,
            model: { modelID: model.modelID, providerID: model.providerID },
            agent: agent.name,
            variant: "max",
            parts: [{ type: "text", text: assessmentPrompt }],
          })
          finalPlanText = extractResponseText(assessResult)
          await logToParent(parentSessionId, "**Enhanced planning:** assessment complete, synthesized plan ready")
        } catch (err: any) {
          log.warn("assessment failed, falling back to default model plan", { error: err })
          await logToParent(parentSessionId, `**Enhanced planning:** assessment failed (${err.message}), using default model plan`)
          finalPlanText = defaultPlan
        }
      } else if (defaultPlan) {
        await logToParent(parentSessionId, "**Enhanced planning:** Claude CLI unavailable, using default model plan")
        finalPlanText = defaultPlan
      } else if (cliPlan) {
        await logToParent(parentSessionId, "**Enhanced planning:** default model failed, using Claude CLI plan")
        finalPlanText = cliPlan
      } else {
        throw new Error("Both default model and Claude CLI failed to generate plans")
      }

      // Parse the plan table from the final text
      const planTableOnly = parsePlanFromResponse(finalPlanText)
      if (planTableOnly.tasks.length === 0) throw new Error("Enhanced planning did not generate any tasks")

      // Write task list and task files immediately so the orchestrator can proceed
      const result = await finalizePlan(planTableOnly, paths, sessionId, parentSessionId)

      // Phase 2: Enrich task descriptions before returning
      await enrichTaskDescriptions({
        plan: planTableOnly,
        paths,
        sessionId,
        parentSessionId,
        finalPlanText,
        context,
        conversationContext,
        userPrompt,
        agent,
        model,
      })

      return result
    } catch (err: any) {
      log.error("enhanced planning failed", { error: err })
      await logToParent(parentSessionId, `**Planning failed:** ${err.message || String(err)}`)
      return { success: false, sessionId, taskCount: 0, error: err.message || String(err) }
    }
  }

  async function enrichTaskDescriptions(opts: {
    plan: TaskList.TaskListFile
    paths: TaskList.Paths
    sessionId: string
    parentSessionId?: string
    finalPlanText: string
    context?: string
    conversationContext?: string
    userPrompt?: string
    agent: { name: string }
    model: { providerID: string; modelID: string }
  }): Promise<void> {
    const { plan, paths, sessionId, parentSessionId, finalPlanText, context, conversationContext, userPrompt, agent, model } = opts

    try {
      await logToParent(parentSessionId, "**Enhanced planning:** writing detailed task descriptions...")

      const taskWritingPrompt = PlanningPrompts.buildTaskWritingPrompt(
        finalPlanText,
        context,
        conversationContext,
        userPrompt,
        plan.tasks.length,
      )
      const taskWriteMessageID = Identifier.ascending("message")
      const taskWriteResult = await SessionPrompt.prompt({
        messageID: taskWriteMessageID,
        sessionID: sessionId,
        model: { modelID: model.modelID, providerID: model.providerID },
        agent: agent.name,
        variant: "max",
        parts: [{ type: "text", text: taskWritingPrompt }],
      })

      const taskDescriptionsText = extractResponseText(taskWriteResult)
      const taskDescriptions = parseTaskDescriptions(taskDescriptionsText)

      // Retry loop for incomplete descriptions
      let coverage = analyzeDescriptionCoverage(plan.tasks, taskDescriptions)
      const maxRetries = 2
      for (let attempt = 0; attempt < maxRetries && coverage.missingIds.length > 0; attempt++) {
        const completedIds = plan.tasks.map((t) => t.id).filter((id) => !coverage.missingIds.includes(id))
        log.warn("description coverage incomplete, retrying", {
          attempt: attempt + 1,
          missing: coverage.missingIds,
          total: coverage.total,
        })
        await logToParent(
          parentSessionId,
          `**Enhanced planning:** ${coverage.missingIds.length} of ${coverage.total} tasks missing descriptions, retrying (attempt ${attempt + 1}/${maxRetries})...`,
        )

        const continuationPrompt = PlanningPrompts.buildContinuationPrompt(
          finalPlanText,
          completedIds,
          coverage.missingIds,
        )
        const retryMessageID = Identifier.ascending("message")
        const retryResult = await SessionPrompt.prompt({
          messageID: retryMessageID,
          sessionID: sessionId,
          model: { modelID: model.modelID, providerID: model.providerID },
          agent: agent.name,
          variant: "max",
          parts: [{ type: "text", text: continuationPrompt }],
        })

        const retryText = extractResponseText(retryResult)
        const retryDescriptions = parseTaskDescriptions(retryText)
        for (const [id, desc] of retryDescriptions) {
          taskDescriptions.set(id, desc)
        }
        coverage = analyzeDescriptionCoverage(plan.tasks, taskDescriptions)
      }

      if (coverage.missingIds.length > 0) {
        log.warn("descriptions still incomplete after retries", { missing: coverage.missingIds })
        await logToParent(
          parentSessionId,
          `**Warning:** ${coverage.missingIds.length} task(s) still missing descriptions after retries: ${coverage.missingIds.join(", ")}`,
        )
      }

      // Update task files that got descriptions
      let updated = 0
      for (const task of plan.tasks) {
        const desc = taskDescriptions.get(task.id)
        if (desc && desc.trim() !== task.title.trim()) {
          const filePath = TaskFile.getFilePath(paths.tasksDir, task.id)
          const existing = await TaskFile.read(filePath)
          if (existing) {
            existing.description = desc
            await TaskFile.write(filePath, existing)
            updated++
          }
        }
      }

      if (updated > 0) {
        log.info("enriched task descriptions", { updated, total: plan.tasks.length })
        await logToParent(parentSessionId, `**Enhanced planning:** enriched ${updated} of ${plan.tasks.length} task descriptions`)
      }
    } catch (err: any) {
      log.error("description enrichment failed", { error: err })
      await logToParent(parentSessionId, `**Warning:** task description enrichment failed: ${err.message || String(err)}`)
    }
  }

  function parseTaskDescriptions(response: string): Map<string, string> {
    const descriptions = new Map<string, string>()
    const taskSections = response.matchAll(/##\s+Task\s+(\d+):\s*([^\n]+)\n([\s\S]*?)(?=##\s+Task|\s*$)/g)
    for (const match of taskSections) {
      descriptions.set(match[1], match[3].trim())
    }
    return descriptions
  }

  function buildConversationSummary(messages: Awaited<ReturnType<typeof Session.messages>>): string {
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
          const truncated = textParts.length > 500 ? textParts.slice(0, 500) + "..." : textParts
          lines.push(`Assistant: ${truncated.trim()}`)
        }
      }
    }

    return lines.join("\n\n")
  }

  function parsePlanFromResponse(response: string): TaskList.TaskListFile {
    const result: TaskList.TaskListFile = {
      title: "Task List",
      tasks: [],
    }

    const titleMatch = response.match(/^#\s+(.+)$/m)
    if (titleMatch) {
      result.title = titleMatch[1]
    }

    const lines = response.split("\n")
    const titleLineIdx = lines.findIndex((l) => /^#\s+/.test(l.trim()))
    for (let i = titleLineIdx >= 0 ? titleLineIdx + 1 : 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed.length === 0) continue
      if (trimmed.startsWith("#")) continue
      if (trimmed.startsWith("|")) break
      result.description = trimmed
      break
    }

    const tableMatch = response.match(/\|[^\n]+\|\n\|[-\s:|]+\|\n((?:\|[^\n]+\|\n?)+)/m)

    if (tableMatch) {
      const tableContent = tableMatch[1]
      const rows = tableContent.split("\n").filter((r) => r.trim().startsWith("|"))

      for (const row of rows) {
        const cells = row
          .split("|")
          .map((c) => c.trim())
          .filter((_, i, arr) => i > 0 && i < arr.length - 1)

        if (cells.length >= 2) {
          const id = cells[0]
          const title = cells[1]
          const statusStr = cells[2]?.toLowerCase() ?? ""
          const assignee = cells[3] !== "-" ? cells[3] : undefined
          const depsStr = cells[4]
          const file = cells[5] !== "-" ? cells[5] : undefined

          let status: TaskList.TaskStatus = "todo"
          if (statusStr.includes("done") || statusStr.includes("✅")) {
            status = "done"
          } else if (statusStr.includes("progress") || statusStr.includes("🔄")) {
            status = "in-progress"
          } else if (statusStr.includes("error") || statusStr.includes("❌")) {
            status = "error"
          }

          const dependencies = depsStr
            ? depsStr
                .split(",")
                .map((d) => d.trim())
                .filter((d) => d.length > 0 && d !== "-")
            : undefined

          result.tasks.push({
            id,
            title,
            status,
            assignee,
            dependencies: dependencies && dependencies.length > 0 ? dependencies : undefined,
            file,
          })
        }
      }
    }

    // Also extract task descriptions
    const taskSections = response.matchAll(/##\s+Task\s+(\d+):\s*([^\n]+)\n([\s\S]*?)(?=##\s+Task|\s*$)/g)

    for (const match of taskSections) {
      const taskId = match[1]
      const description = match[3].trim()

      const existingTask = result.tasks.find((t) => t.id === taskId)
      if (existingTask) {
        ;(existingTask as any)._description = description
      }
    }

    return result
  }

  export async function updatePlan(
    paths: TaskList.Paths,
    updates: {
      addTasks?: TaskList.TaskEntry[]
      removeTasks?: string[]
      updateTasks?: Array<{ id: string; updates: Partial<TaskList.TaskEntry> }>
    },
  ): Promise<TaskList.TaskListFile> {
    return TaskList.update(paths.taskListPath, paths.lockPath, (current) => {
      let updated = { ...current, tasks: [...current.tasks] }

      if (updates.removeTasks) {
        updated.tasks = updated.tasks.filter((t) => !updates.removeTasks!.includes(t.id))
      }

      if (updates.addTasks) {
        updated.tasks.push(...updates.addTasks)
      }

      if (updates.updateTasks) {
        for (const { id, updates: taskUpdates } of updates.updateTasks) {
          updated = TaskList.updateTask(updated, id, taskUpdates)
        }
      }

      return updated
    })
  }
}
