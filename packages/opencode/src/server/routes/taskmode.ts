import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { TaskList } from "../../task-mode/task-list"
import { TaskFile } from "../../task-mode/task-file"
import { Orchestrator } from "../../task-mode/orchestrator"
import { Config } from "../../config/config"
import { Instance } from "../../project/instance"
import fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "taskmode-routes" })

// Helper to extract folder name from listPath
function getFolderName(listPath: string): string {
  // Extract folder name from path like ".opencode/tasks/{folderName}/task_list.md"
  const match = listPath.match(/\.opencode\/tasks\/([^/]+)\/task_list\.md$/)
  return match ? match[1] : "default"
}

// Helper to construct listPath from folder name
function getListPath(folderName: string): string {
  return `.opencode/tasks/${folderName}/task_list.md`
}

export const TaskModeRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get task list content",
        description: "Get the raw markdown content of the task list file",
        operationId: "taskmode.get",
        responses: {
          200: {
            description: "Task list markdown content",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    exists: z.boolean(),
                    content: z.string().optional(),
                    path: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        try {
          const content = await fs.readFile(paths.taskListPath, "utf-8")
          return c.json({
            exists: true,
            content,
            path: paths.taskListPath,
          })
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return c.json({
              exists: false,
              path: paths.taskListPath,
            })
          }
          throw err
        }
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get task list status",
        description: "Get the parsed task list with statuses and counts",
        operationId: "taskmode.status",
        responses: {
          200: {
            description: "Task list status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    enabled: z.boolean(),
                    exists: z.boolean(),
                    path: z.string(),
                    orchestratorRunning: z.boolean(),
                    parentSessionId: z.string().optional(),
                    activeTasks: z.number(),
                    taskList: TaskList.TaskListFile.optional(),
                    counts: z
                      .object({
                        total: z.number(),
                        pending: z.number(),
                        inProgress: z.number(),
                        completed: z.number(),
                        error: z.number(),
                        paused: z.number(),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const enabled = config.taskMode?.enabled ?? false
        const tddMode = config.taskMode?.tddMode ?? false
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)
        const folderName = getFolderName(listPath)

        const orchestratorStatus = Orchestrator.getStatus()
        const taskList = await TaskList.read(paths.taskListPath)

        return c.json({
          enabled,
          tddMode,
          exists: taskList !== null,
          path: paths.taskListPath,
          folderName,
          orchestratorRunning: orchestratorStatus.running,
          parentSessionId: orchestratorStatus.parentSessionId,
          activeTasks: orchestratorStatus.activeTasks,
          taskList: taskList ?? undefined,
          counts: taskList ? TaskList.getCounts(taskList) : undefined,
        })
      },
    )
    .get(
      "/folders",
      describeRoute({
        summary: "List task folders",
        description: "List all existing task folders in .opencode/tasks/",
        operationId: "taskmode.folders",
        responses: {
          200: {
            description: "List of task folders",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    folders: z.array(
                      z.object({
                        name: z.string(),
                        hasTaskList: z.boolean(),
                        taskCount: z.number().optional(),
                      }),
                    ),
                    currentFolder: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const currentListPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const currentFolder = getFolderName(currentListPath)

        const tasksDir = path.join(Instance.directory, ".opencode", "tasks")
        const folders: Array<{ name: string; hasTaskList: boolean; taskCount?: number }> = []

        try {
          const entries = await fs.readdir(tasksDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const folderPath = path.join(tasksDir, entry.name)
              const taskListPath = path.join(folderPath, "task_list.md")

              let hasTaskList = false
              let taskCount: number | undefined

              try {
                await fs.access(taskListPath)
                hasTaskList = true

                // Try to read and count tasks
                const paths = TaskList.resolvePaths(Instance.directory, getListPath(entry.name))
                const taskList = await TaskList.read(paths.taskListPath)
                if (taskList) {
                  taskCount = taskList.tasks.length
                }
              } catch {
                // Task list doesn't exist
              }

              folders.push({
                name: entry.name,
                hasTaskList,
                taskCount,
              })
            }
          }
        } catch (err: any) {
          // Directory doesn't exist yet
          if (err.code !== "ENOENT") {
            throw err
          }
        }

        return c.json({
          folders,
          currentFolder,
        })
      },
    )
    .get(
      "/task/:taskId",
      describeRoute({
        summary: "Get task details",
        description: "Get the full details of a specific task from its task file",
        operationId: "taskmode.task",
        responses: {
          200: {
            description: "Task details",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    exists: z.boolean(),
                    task: TaskFile.TaskFileData.optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const taskId = c.req.param("taskId")
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const taskFilePath = TaskFile.getFilePath(paths.tasksDir, taskId)
        const task = await TaskFile.read(taskFilePath)

        return c.json({
          exists: task !== null,
          task: task ?? undefined,
        })
      },
    )
    .get(
      "/tasks/details",
      describeRoute({
        summary: "Get all task details",
        description: "Get the full details of all tasks from their task files",
        operationId: "taskmode.tasks.details",
        responses: {
          200: {
            description: "All task details",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    tasks: z.record(z.string(), TaskFile.TaskFileData),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const taskList = await TaskList.read(paths.taskListPath)
        const tasks: Record<string, TaskFile.TaskFileData> = {}

        if (taskList) {
          for (const task of taskList.tasks) {
            const taskFilePath = TaskFile.getFilePath(paths.tasksDir, task.id)
            const taskFile = await TaskFile.read(taskFilePath)
            if (taskFile) {
              tasks[task.id] = taskFile
            }
          }
        }

        return c.json({ tasks })
      },
    )
    .post(
      "/enable",
      describeRoute({
        summary: "Enable task mode",
        description: "Enable task mode and optionally start the orchestrator",
        operationId: "taskmode.enable",
        responses: {
          200: {
            description: "Task mode enabled",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    orchestratorStarted: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          startOrchestrator: z.boolean().optional().default(true),
          parentSessionId: z.string().optional(),
          folderName: z.string().optional(),
          tddMode: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { startOrchestrator, parentSessionId, folderName, tddMode } = c.req.valid("json")

        // Build the listPath from folder name
        const listPath = folderName ? getListPath(folderName) : undefined

        // Update config to enable task mode
        await Config.update({
          taskMode: {
            enabled: true,
            ...(listPath && { listPath }),
            ...(tddMode !== undefined && { tddMode }),
          },
        })

        let orchestratorStarted = false
        if (startOrchestrator) {
          await Orchestrator.start({ parentSessionId })
          orchestratorStarted = Orchestrator.isRunning()
        }

        return c.json({
          success: true,
          orchestratorStarted,
        })
      },
    )
    .post(
      "/disable",
      describeRoute({
        summary: "Disable task mode",
        description: "Disable task mode and stop the orchestrator",
        operationId: "taskmode.disable",
        responses: {
          200: {
            description: "Task mode disabled",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        // Stop orchestrator if running
        if (Orchestrator.isRunning()) {
          await Orchestrator.stop("manual")
        }

        // Update config to disable task mode
        await Config.update({
          taskMode: {
            enabled: false,
          },
        })

        return c.json({
          success: true,
        })
      },
    )
    .post(
      "/confirm",
      describeRoute({
        summary: "Confirm generated plan",
        description: "Confirm the generated plan and start execution",
        operationId: "taskmode.confirm",
        responses: {
          200: {
            description: "Plan confirmed",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        try {
          await Orchestrator.confirmPlan()
          return c.json({
            success: true,
          })
        } catch (err: any) {
          return c.json(
            {
              success: false,
              error: err.message,
            },
            400,
          )
        }
      },
    )
    .post(
      "/start",
      describeRoute({
        summary: "Start orchestrator",
        description: "Start the task orchestrator",
        operationId: "taskmode.start",
        responses: {
          200: {
            description: "Orchestrator started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    running: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          parentSessionId: z.string().optional(),
        }),
      ),
      async (c) => {
        const { parentSessionId } = c.req.valid("json")
        await Orchestrator.start({ parentSessionId })

        return c.json({
          success: true,
          running: Orchestrator.isRunning(),
        })
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: "Stop orchestrator",
        description: "Stop the task orchestrator",
        operationId: "taskmode.stop",
        responses: {
          200: {
            description: "Orchestrator stopped",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        await Orchestrator.stop("manual")
        return c.json({
          success: true,
        })
      },
    )
    .get(
      "/task/:taskId",
      describeRoute({
        summary: "Get task details",
        description: "Get details for a specific task",
        operationId: "taskmode.task.get",
        responses: {
          200: {
            description: "Task details",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    task: TaskList.TaskEntry.optional(),
                    file: TaskFile.TaskFileData.optional(),
                  }),
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator(
        "param",
        z.object({
          taskId: z.string(),
        }),
      ),
      async (c) => {
        const { taskId } = c.req.valid("param")
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const taskList = await TaskList.read(paths.taskListPath)
        const task = taskList ? TaskList.getTask(taskList, taskId) : undefined

        const taskFilePath = TaskFile.getFilePath(paths.tasksDir, taskId)
        const file = await TaskFile.read(taskFilePath)

        if (!task && !file) {
          return c.json({ task: undefined, file: undefined }, 404)
        }

        return c.json({
          task,
          file: file ?? undefined,
        })
      },
    )
    .patch(
      "/task/:taskId",
      describeRoute({
        summary: "Update task",
        description: "Update a task's status or other properties",
        operationId: "taskmode.task.update",
        responses: {
          200: {
            description: "Task updated",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    task: TaskList.TaskEntry.optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          taskId: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          status: TaskList.TaskStatus.optional(),
          assignee: z.string().optional(),
        }),
      ),
      async (c) => {
        const { taskId } = c.req.valid("param")
        const updates = c.req.valid("json")

        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const updated = await TaskList.update(paths.taskListPath, paths.lockPath, (current) =>
          TaskList.updateTask(current, taskId, updates),
        )

        const task = TaskList.getTask(updated, taskId)

        return c.json({
          success: true,
          task,
        })
      },
    )
    .get(
      "/stats",
      describeRoute({
        summary: "Get completion stats",
        description: "Get completion statistics including time, tokens, cost, and modified files",
        operationId: "taskmode.stats",
        responses: {
          200: {
            description: "Completion stats",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    exists: z.boolean(),
                    stats: z
                      .object({
                        startedAt: z.number().optional(),
                        completedAt: z.number().optional(),
                        durationMs: z.number().optional(),
                        inputTokens: z.number(),
                        outputTokens: z.number(),
                        cost: z.number(),
                        modifiedFiles: z.array(z.string()),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const stats = await Orchestrator.getCompletionStats(paths)

        return c.json({
          exists: stats !== null,
          stats: stats ?? undefined,
        })
      },
    )
    .get(
      "/diff",
      describeRoute({
        summary: "Get unified diff",
        description: "Get a unified diff of all files modified during the task execution",
        operationId: "taskmode.diff",
        responses: {
          200: {
            description: "Unified diff",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    diff: z.string(),
                    fileCount: z.number(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const stats = await Orchestrator.getCompletionStats(paths)
        const modifiedFiles = stats?.modifiedFiles ?? []
        const diff = await Orchestrator.getUnifiedDiff(modifiedFiles)

        return c.json({
          diff,
          fileCount: modifiedFiles.length,
        })
      },
    )
    .post(
      "/archive",
      describeRoute({
        summary: "Archive task folder",
        description: "Move the task folder to the archived directory",
        operationId: "taskmode.archive",
        responses: {
          200: {
            description: "Task folder archived",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    archivePath: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        // Get task list title for archive name
        const taskList = await TaskList.read(paths.taskListPath)
        const title = taskList?.title

        // Stop orchestrator if running
        if (Orchestrator.isRunning()) {
          await Orchestrator.stop("manual")
        }

        const archivePath = await Orchestrator.archive(paths, title)

        // Disable task mode after archiving
        await Config.update({
          taskMode: {
            enabled: false,
          },
        })

        return c.json({
          success: true,
          archivePath,
        })
      },
    )
    .post(
      "/create-pr",
      describeRoute({
        summary: "Create pull request",
        description: "Create a pull request with all files modified during task execution",
        operationId: "taskmode.createPr",
        responses: {
          200: {
            description: "Pull request created",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    prUrl: z.string().optional(),
                    error: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          title: z.string(),
          body: z.string().optional(),
          branch: z.string().optional(),
        }),
      ),
      async (c) => {
        const { title, body, branch } = c.req.valid("json")
        const config = await Config.get()
        const listPath = config.taskMode?.listPath ?? ".opencode/tasks/default/task_list.md"
        const paths = TaskList.resolvePaths(Instance.directory, listPath)

        const stats = await Orchestrator.getCompletionStats(paths)
        const modifiedFiles = stats?.modifiedFiles ?? []

        if (modifiedFiles.length === 0) {
          return c.json({
            success: false,
            error: "No modified files to commit",
          })
        }

        try {
          const { execSync } = await import("child_process")
          const cwd = Instance.directory

          // Create branch if specified
          const branchName = branch ?? `task-mode-${Date.now()}`
          execSync(`git checkout -b "${branchName}"`, { cwd, encoding: "utf-8" })

          // Stage only the modified files
          for (const file of modifiedFiles) {
            try {
              execSync(`git add "${file}"`, { cwd, encoding: "utf-8" })
            } catch {
              // File might not exist or be ignored
            }
          }

          // Create commit
          execSync(`git commit -m "${title.replace(/"/g, '\\"')}"`, { cwd, encoding: "utf-8" })

          // Push branch
          execSync(`git push -u origin "${branchName}"`, { cwd, encoding: "utf-8" })

          // Create PR using gh CLI
          const prBody = body ?? `Created by task mode.\n\nModified files:\n${modifiedFiles.map((f) => `- ${f}`).join("\n")}`
          const result = execSync(
            `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
            { cwd, encoding: "utf-8" },
          )

          // Extract PR URL from output
          const prUrl = result.trim().split("\n").pop()

          return c.json({
            success: true,
            prUrl,
          })
        } catch (err: any) {
          return c.json({
            success: false,
            error: err.message || String(err),
          })
        }
      },
    ),
)
