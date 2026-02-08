import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"

export namespace TaskFile {
  const log = Log.create({ service: "task-file" })

  export const TaskFileData = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["todo", "in-progress", "done", "error", "paused"]).optional(),
    dependencies: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
    comments: z.string().optional(),
    sessionId: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  export type TaskFileData = z.infer<typeof TaskFileData>

  export function parseMarkdown(content: string): TaskFileData {
    const lines = content.split("\n")
    const result: Partial<TaskFileData> = {}

    let inFrontmatter = false
    let frontmatterDone = false
    let descriptionLines: string[] = []
    let commentsLines: string[] = []
    let inComments = false

    for (const line of lines) {
      const trimmed = line.trim()

      // Handle frontmatter
      if (trimmed === "---") {
        if (!inFrontmatter && !frontmatterDone) {
          inFrontmatter = true
          continue
        } else if (inFrontmatter) {
          inFrontmatter = false
          frontmatterDone = true
          continue
        }
      }

      if (inFrontmatter) {
        const match = trimmed.match(/^(\w+):\s*(.*)$/)
        if (match) {
          const [, key, value] = match
          switch (key) {
            case "id":
              result.id = value
              break
            case "title":
              result.title = value
              break
            case "status":
              result.status = value as TaskFileData["status"]
              break
            case "dependencies":
              result.dependencies = value
                .split(",")
                .map((d) => d.trim())
                .filter((d) => d.length > 0)
              break
            case "files":
              result.files = value
                .split(",")
                .map((f) => f.trim())
                .filter((f) => f.length > 0)
              break
            case "tests":
              result.tests = value
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
              break
            case "sessionId":
              result.sessionId = value
              break
            case "startedAt":
              result.startedAt = value
              break
            case "completedAt":
              result.completedAt = value
              break
          }
        }
        continue
      }

      // Parse title from # heading if not in frontmatter
      if (trimmed.startsWith("# ") && !result.title) {
        result.title = trimmed.slice(2).trim()
        continue
      }

      // Parse comments section
      if (trimmed === "## Comments" || trimmed === "## Completion Comments") {
        inComments = true
        continue
      }

      if (inComments) {
        commentsLines.push(line)
      } else if (frontmatterDone && !trimmed.startsWith("#")) {
        descriptionLines.push(line)
      }
    }

    result.description = descriptionLines.join("\n").trim()
    if (commentsLines.length > 0) {
      result.comments = commentsLines.join("\n").trim()
    }

    // Extract ID from filename pattern if not in frontmatter
    if (!result.id) {
      result.id = "000"
    }

    if (!result.title) {
      result.title = "Untitled Task"
    }

    return TaskFileData.parse(result)
  }

  export function toMarkdown(data: TaskFileData): string {
    const lines: string[] = []

    // Frontmatter
    lines.push("---")
    lines.push(`id: ${data.id}`)
    lines.push(`title: ${data.title}`)
    if (data.status) {
      lines.push(`status: ${data.status}`)
    }
    if (data.dependencies && data.dependencies.length > 0) {
      lines.push(`dependencies: ${data.dependencies.join(", ")}`)
    }
    if (data.files && data.files.length > 0) {
      lines.push(`files: ${data.files.join(", ")}`)
    }
    if (data.tests && data.tests.length > 0) {
      lines.push(`tests: ${data.tests.join(", ")}`)
    }
    if (data.sessionId) {
      lines.push(`sessionId: ${data.sessionId}`)
    }
    if (data.startedAt) {
      lines.push(`startedAt: ${data.startedAt}`)
    }
    if (data.completedAt) {
      lines.push(`completedAt: ${data.completedAt}`)
    }
    lines.push("---")
    lines.push("")

    // Title
    lines.push(`# ${data.title}`)
    lines.push("")

    // Description
    if (data.description) {
      lines.push(data.description)
      lines.push("")
    }

    // Comments section
    if (data.comments) {
      lines.push("## Completion Comments")
      lines.push("")
      lines.push(data.comments)
      lines.push("")
    }

    return lines.join("\n")
  }

  export async function read(filePath: string): Promise<TaskFileData | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8")
      return parseMarkdown(content)
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null
      }
      throw err
    }
  }

  export async function write(filePath: string, data: TaskFileData): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, toMarkdown(data), "utf-8")
    log.info("task file written", { filePath, taskId: data.id })
  }

  export function getFilePath(tasksDir: string, taskId: string): string {
    return path.join(tasksDir, `${taskId}.md`)
  }
}
