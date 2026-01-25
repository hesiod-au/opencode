import { Log } from "../util/log"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { TaskList } from "./task-list"
import { TaskFile } from "./task-file"
import { TaskModeEvent } from "./events"
import fs from "fs/promises"

export namespace PlanningAgent {
  const log = Log.create({ service: "planning-agent" })

  // Helper to log actions to parent session
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
    const { paths, parentSessionId, context, userPrompt } = options

    log.info("starting planning agent", { taskListPath: paths.taskListPath })

    // Use parent session for planning work if available, otherwise create a new session
    // This ensures the planning conversation is visible in the main thread
    let sessionId: string
    if (parentSessionId) {
      sessionId = parentSessionId
      log.info("planning agent will run in parent session", { sessionId })
    } else {
      const session = await Session.create({
        title: "Task Planning Session",
      })
      sessionId = session.id
      log.info("planning agent created new session", { sessionId })
    }

    Bus.publish(TaskModeEvent.PlanningStarted, {
      sessionId,
    })

    try {
      const agent = await Agent.get("plan")

      if (!agent) {
        throw new Error("Plan agent not found")
      }

      // Fetch parent session messages to provide context
      let parentMessages: Awaited<ReturnType<typeof Session.messages>> = []
      if (parentSessionId) {
        try {
          parentMessages = await Session.messages({ sessionID: parentSessionId, includeCompacted: false })
          log.info("fetched parent session messages for planning context", {
            parentSessionId,
            messageCount: parentMessages.length,
          })
        } catch (err) {
          log.warn("failed to fetch parent session messages", { parentSessionId, error: err })
        }
      }

      // Build context from parent conversation
      const conversationContext = parentMessages.length > 0 ? buildConversationSummary(parentMessages) : undefined

      const messageID = Identifier.ascending("message")
      const prompt = buildPlanningPrompt(context, conversationContext, userPrompt)

      // Use the agent's configured model, or fall back to OpenAI's gpt-5.2-codex
      const model = agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: sessionId,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        variant: "max", // Maximum thinking budget for thorough planning
        parts: [{ type: "text", text: prompt }],
      })

      // Parse the generated plan from the response
      const responseText = result.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n\n")

      // Extract task list from response
      const plan = parsePlanFromResponse(responseText)

      if (plan.tasks.length === 0) {
        throw new Error("Planning agent did not generate any tasks")
      }

      // Create directories
      await fs.mkdir(paths.tasksDir, { recursive: true })

      // Write task list
      await TaskList.write(paths.taskListPath, plan)

      // Write individual task files with full descriptions
      for (const task of plan.tasks) {
        // Use the parsed description if available, otherwise fall back to title
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

      Bus.publish(TaskModeEvent.PlanningCompleted, {
        sessionId: sessionId,
        taskCount: plan.tasks.length,
      })

      log.info("planning completed", {
        sessionId: sessionId,
        taskCount: plan.tasks.length,
      })

      // Log to parent session with task summary
      const taskSummary = plan.tasks.map((t) => `- **${t.id}**: ${t.title}`).join("\n")
      await logToParent(
        parentSessionId,
        `**Planning completed** ✓\n\nGenerated ${plan.tasks.length} tasks:\n\n${taskSummary}`,
      )

      return {
        success: true,
        sessionId: sessionId,
        taskCount: plan.tasks.length,
      }
    } catch (err: any) {
      log.error("planning failed", { error: err })

      // Log failure to parent session
      await logToParent(parentSessionId, `**Planning failed:** ${err.message || String(err)}`)

      return {
        success: false,
        sessionId: sessionId,
        taskCount: 0,
        error: err.message || String(err),
      }
    }
  }

  function buildConversationSummary(messages: Awaited<ReturnType<typeof Session.messages>>): string {
    const lines: string[] = []

    for (const msg of messages) {
      if (msg.info.role === "user") {
        // Extract text parts from user messages
        const textParts = msg.parts
          .filter((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")
        if (textParts.trim()) {
          lines.push(`User: ${textParts.trim()}`)
        }
      } else if (msg.info.role === "assistant") {
        // Extract text parts from assistant messages (summarized)
        const textParts = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")
        if (textParts.trim()) {
          // Truncate long assistant responses
          const truncated = textParts.length > 500 ? textParts.slice(0, 500) + "..." : textParts
          lines.push(`Assistant: ${truncated.trim()}`)
        }
      }
    }

    return lines.join("\n\n")
  }

  function buildPlanningPrompt(context?: string, conversationContext?: string, userPrompt?: string): string {
    const userRequestSection = userPrompt
      ? `## User Request

The user has made the following request:

${userPrompt}

`
      : ""

    const conversationSection = conversationContext
      ? `## Previous Conversation

The user has been discussing the following with an assistant. Use this context to understand what needs to be done:

${conversationContext}

`
      : ""

    return `You are a task planning agent. Your job is to analyze the project and create a task breakdown for the work that needs to be done.

${userRequestSection}${conversationSection}${context ? `## Additional Context\n${context}\n\n` : ""}## Instructions

1. Analyze the project structure and requirements based on the conversation above
2. Break down the work into discrete, manageable tasks
3. Identify dependencies between tasks
4. Output a task list in the following markdown table format:

\`\`\`markdown
# Task List

Brief description of the overall goal.

| ID | Title | Status | Assignee | Deps | File |
|----|-------|--------|----------|------|------|
| 001 | First task title | ⬜ todo | - | - | 001.md |
| 002 | Second task title | ⬜ todo | - | 001 | 002.md |
| 003 | Third task title | ⬜ todo | - | 001,002 | 003.md |
\`\`\`

## Guidelines

- Each task should be completable independently (once dependencies are met)
- Tasks should be small enough for a single agent to complete in one session
- Dependencies should form a valid DAG (no cycles)
- Use descriptive titles that clearly indicate what needs to be done
- Number tasks sequentially starting from 001
- A task's File should match its ID (e.g., task 001 has file 001.md)

After the table, for each task provide a **comprehensive, self-contained description**:

## Task 001: First task title

**IMPORTANT:** Each task description must contain ALL context needed for an autonomous agent to complete it without access to the original conversation or other tasks. Include:

- **Background/Context**: Why this task exists and how it fits into the larger goal
- **Specific Requirements**: Exactly what needs to be done, in detail
- **Files to Modify/Create**: List specific file paths that will be affected
- **Implementation Details**: Technical approach, patterns to follow, constraints
- **Expected Outcomes**: What success looks like, how to verify completion
- **Relevant Code Snippets**: If the conversation mentioned specific code, APIs, or patterns, include them
- **Dependencies Context**: What the dependent tasks produce that this task needs

The agent working on this task will NOT have access to the original user conversation, so the description must be complete and standalone.

## Task 002: Second task title

And so on for each task...

Now, analyze the project and create the task breakdown based on what the user has requested.
`
  }

  function parsePlanFromResponse(response: string): TaskList.TaskListFile {
    // Try to parse the markdown table from the response
    const result: TaskList.TaskListFile = {
      title: "Task List",
      tasks: [],
    }

    // Extract title if present
    const titleMatch = response.match(/^#\s+(.+)$/m)
    if (titleMatch) {
      result.title = titleMatch[1]
    }

    // Look for the table
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

    // Also extract task descriptions and create enhanced task files
    const taskSections = response.matchAll(/##\s+Task\s+(\d+):\s*([^\n]+)\n([\s\S]*?)(?=##\s+Task|\s*$)/g)

    for (const match of taskSections) {
      const taskId = match[1]
      const description = match[3].trim()

      // Update task with description if it exists
      const existingTask = result.tasks.find((t) => t.id === taskId)
      if (existingTask) {
        // Store description for later use when writing task files
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

      // Remove tasks
      if (updates.removeTasks) {
        updated.tasks = updated.tasks.filter((t) => !updates.removeTasks!.includes(t.id))
      }

      // Add tasks
      if (updates.addTasks) {
        updated.tasks.push(...updates.addTasks)
      }

      // Update tasks
      if (updates.updateTasks) {
        for (const { id, updates: taskUpdates } of updates.updateTasks) {
          updated = TaskList.updateTask(updated, id, taskUpdates)
        }
      }

      return updated
    })
  }
}
