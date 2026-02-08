import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { Instance } from "../project/instance"

export namespace TaskList {
  const log = Log.create({ service: "task-list" })

  export const TaskStatus = z.enum(["todo", "in-progress", "done", "error", "paused"])
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const TaskEntry = z.object({
    id: z.string(),
    title: z.string(),
    status: TaskStatus,
    assignee: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    file: z.string().optional(),
  })
  export type TaskEntry = z.infer<typeof TaskEntry>

  export const TestFrameworkInfo = z.object({
    language: z.string(), // e.g., "typescript", "python", "go"
    framework: z.string(), // e.g., "bun:test", "pytest", "vitest", "jest"
    runCommand: z.string().optional(), // e.g., "bun test", "pytest -v"
  })
  export type TestFrameworkInfo = z.infer<typeof TestFrameworkInfo>

  export const TaskListFile = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    tasks: z.array(TaskEntry),
    e2eTest: z.string().optional(), // End-to-end test name for TDD mode
    testFramework: TestFrameworkInfo.optional(), // Test framework info from test-writer
  })
  export type TaskListFile = z.infer<typeof TaskListFile>

  export interface Paths {
    taskListPath: string
    tasksDir: string
    lockPath: string
  }

  export function resolvePaths(projectRoot: string, listPath: string): Paths {
    const taskListPath = path.isAbsolute(listPath) ? listPath : path.join(projectRoot, listPath)
    const tasksDir = path.join(path.dirname(taskListPath), "tasks")
    const lockPath = path.join(path.dirname(taskListPath), ".task_list.lock")
    return { taskListPath, tasksDir, lockPath }
  }

  export function parseMarkdown(content: string): TaskListFile {
    const lines = content.split("\n")
    const result: TaskListFile = {
      tasks: [],
    }

    let inTable = false
    let headerParsed = false
    let columnIndices: { id: number; title: number; status: number; assignee: number; deps: number; file: number } = {
      id: -1,
      title: -1,
      status: -1,
      assignee: -1,
      deps: -1,
      file: -1,
    }

    for (const line of lines) {
      const trimmed = line.trim()

      // Parse title (# heading)
      if (trimmed.startsWith("# ") && !result.title) {
        result.title = trimmed.slice(2).trim()
        continue
      }

      // Parse e2eTest field
      if (trimmed.startsWith("e2e-test:")) {
        result.e2eTest = trimmed.slice("e2e-test:".length).trim()
        continue
      }

      // Parse testFramework field (format: test-framework: language/framework/run-command)
      if (trimmed.startsWith("test-framework:")) {
        const value = trimmed.slice("test-framework:".length).trim()
        const parts = value.split("/")
        if (parts.length >= 2) {
          result.testFramework = {
            language: parts[0].trim(),
            framework: parts[1].trim(),
            runCommand: parts.slice(2).join("/").trim() || undefined,
          }
        }
        continue
      }

      // Parse description (text before table)
      if (!inTable && !trimmed.startsWith("|") && !trimmed.startsWith("#") && trimmed.length > 0 && !result.description) {
        result.description = trimmed
        continue
      }

      // Detect table start
      if (trimmed.startsWith("|") && !inTable) {
        inTable = true
        // Parse header row to find column indices
        const headers = trimmed
          .split("|")
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0)

        columnIndices = {
          id: headers.findIndex((h) => h === "id" || h === "#"),
          title: headers.findIndex((h) => h === "title" || h === "task"),
          status: headers.findIndex((h) => h === "status"),
          assignee: headers.findIndex((h) => h === "assignee" || h === "assigned"),
          deps: headers.findIndex((h) => h === "deps" || h === "dependencies" || h === "depends"),
          file: headers.findIndex((h) => h === "file" || h === "task file"),
        }
        headerParsed = true
        continue
      }

      // Skip separator row
      if (inTable && trimmed.match(/^\|[\s-:|]+\|$/)) {
        continue
      }

      // Parse data row
      if (inTable && headerParsed && trimmed.startsWith("|")) {
        const cells = trimmed
          .split("|")
          .map((c) => c.trim())
          .filter((_, i, arr) => i > 0 && i < arr.length - 1) // Remove empty first/last from split

        const id = columnIndices.id >= 0 ? cells[columnIndices.id] : undefined
        const title = columnIndices.title >= 0 ? cells[columnIndices.title] : undefined
        const statusStr = columnIndices.status >= 0 ? cells[columnIndices.status]?.toLowerCase() : undefined
        const assignee = columnIndices.assignee >= 0 ? cells[columnIndices.assignee] : undefined
        const depsStr = columnIndices.deps >= 0 ? cells[columnIndices.deps] : undefined
        const file = columnIndices.file >= 0 ? cells[columnIndices.file] : undefined

        if (id && title) {
          // Parse status, handling emoji or text
          let status: TaskStatus = "todo"
          if (statusStr) {
            if (statusStr.includes("done") || statusStr.includes("✅") || statusStr.includes("complete")) {
              status = "done"
            } else if (statusStr.includes("progress") || statusStr.includes("🔄") || statusStr.includes("running")) {
              status = "in-progress"
            } else if (statusStr.includes("error") || statusStr.includes("❌") || statusStr.includes("fail")) {
              status = "error"
            } else if (statusStr.includes("pause") || statusStr.includes("⏸")) {
              status = "paused"
            }
          }

          // Parse dependencies (filter out "-" which means no dependencies)
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
            assignee: assignee && assignee !== "-" ? assignee : undefined,
            dependencies: dependencies && dependencies.length > 0 ? dependencies : undefined,
            file: file && file !== "-" ? file : undefined,
          })
        }
      }

      // End of table
      if (inTable && !trimmed.startsWith("|") && trimmed.length === 0) {
        inTable = false
      }
    }

    return result
  }

  export function toMarkdown(data: TaskListFile): string {
    const lines: string[] = []

    if (data.title) {
      lines.push(`# ${data.title}`)
      lines.push("")
    }

    if (data.description) {
      lines.push(data.description)
      lines.push("")
    }

    if (data.e2eTest) {
      lines.push(`e2e-test: ${data.e2eTest}`)
      lines.push("")
    }

    if (data.testFramework) {
      const parts = [data.testFramework.language, data.testFramework.framework]
      if (data.testFramework.runCommand) {
        parts.push(data.testFramework.runCommand)
      }
      lines.push(`test-framework: ${parts.join("/")}`)
      lines.push("")
    }

    // Table header
    lines.push("| ID | Title | Status | Assignee | Deps | File |")
    lines.push("|----|-------|--------|----------|------|------|")

    // Table rows
    for (const task of data.tasks) {
      const statusEmoji = {
        todo: "⬜ todo",
        "in-progress": "🔄 in-progress",
        done: "✅ done",
        error: "❌ error",
        paused: "⏸ paused",
      }[task.status]

      const deps = task.dependencies?.join(", ") || "-"
      const assignee = task.assignee || "-"
      const file = task.file || "-"

      lines.push(`| ${task.id} | ${task.title} | ${statusEmoji} | ${assignee} | ${deps} | ${file} |`)
    }

    lines.push("")
    return lines.join("\n")
  }

  export async function read(taskListPath: string): Promise<TaskListFile | null> {
    try {
      const content = await fs.readFile(taskListPath, "utf-8")
      return parseMarkdown(content)
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null
      }
      throw err
    }
  }

  export async function write(taskListPath: string, data: TaskListFile): Promise<void> {
    const dir = path.dirname(taskListPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(taskListPath, toMarkdown(data), "utf-8")
  }

  export async function update(
    taskListPath: string,
    lockPath: string,
    patchFn: (current: TaskListFile) => TaskListFile,
  ): Promise<TaskListFile> {
    using _ = await Lock.write(lockPath)

    const current = (await read(taskListPath)) || { tasks: [] }
    const updated = patchFn(current)
    await write(taskListPath, updated)

    log.info("task list updated", {
      taskListPath,
      taskCount: updated.tasks.length,
    })

    return updated
  }

  export function getTask(data: TaskListFile, taskId: string): TaskEntry | undefined {
    return data.tasks.find((t) => t.id === taskId)
  }

  export function updateTask(data: TaskListFile, taskId: string, updates: Partial<TaskEntry>): TaskListFile {
    return {
      ...data,
      tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
    }
  }

  export function getRunnableTasks(data: TaskListFile): TaskEntry[] {
    return data.tasks.filter((task) => {
      if (task.status !== "todo") return false
      if (!task.dependencies || task.dependencies.length === 0) return true

      // Check if all dependencies are done
      return task.dependencies.every((depId) => {
        const dep = data.tasks.find((t) => t.id === depId)
        return dep?.status === "done"
      })
    })
  }

  export function isAllDone(data: TaskListFile): boolean {
    return data.tasks.every((t) => t.status === "done" || t.status === "error")
  }

  export function hasErrors(data: TaskListFile): boolean {
    return data.tasks.some((t) => t.status === "error")
  }

  export function getCounts(data: TaskListFile): {
    total: number
    pending: number
    inProgress: number
    completed: number
    error: number
    paused: number
  } {
    return {
      total: data.tasks.length,
      pending: data.tasks.filter((t) => t.status === "todo").length,
      inProgress: data.tasks.filter((t) => t.status === "in-progress").length,
      completed: data.tasks.filter((t) => t.status === "done").length,
      error: data.tasks.filter((t) => t.status === "error").length,
      paused: data.tasks.filter((t) => t.status === "paused").length,
    }
  }
}
