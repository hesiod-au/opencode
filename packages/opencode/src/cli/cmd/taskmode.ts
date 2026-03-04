import type { Argv } from "yargs"
import path from "path"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Server } from "../../server/server"
import { UI } from "../ui"

function directory(input?: string) {
  return path.resolve(process.cwd(), input ?? process.cwd())
}

async function api<T>(fetchFn: typeof fetch, method: string, route: string, directory?: string, body?: any): Promise<T> {
  const res = await fetchFn(`http://opencode.internal${route}`, {
    method,
    headers: {
      ...(directory ? { "x-opencode-directory": directory } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Task mode API error ${res.status}: ${text || res.statusText}`)
  }

  return (await res.json()) as T
}

export const TaskModeCommand = cmd({
  command: "taskmode",
  describe: "enable/disable task mode",
  builder: (yargs: Argv) =>
    yargs.command(TaskModeEnableCommand).command(TaskModeDisableCommand).command(TaskModeStatusCommand).demandCommand(),
  async handler() {},
})

export const TaskModeEnableCommand = cmd({
  command: "enable",
  describe: "enable task mode and start the orchestrator",
  builder: (yargs: Argv) =>
    yargs
      .option("no-orchestrator", {
        type: "boolean",
        describe: "enable task mode but do not start the orchestrator",
      })
      .option("tdd", {
        type: "boolean",
        describe: "enable TDD mode for task mode",
      })
      .option("directory", {
        alias: ["cwd", "dir"],
        type: "string",
        describe: "directory to run in",
      })
      .option("folder", {
        type: "string",
        describe: "task folder name under .opencode/tasks (selects its task_list.md)",
      })
      .option("parent-session", {
        type: "string",
        describe: "parent session id to log orchestrator actions to",
      }),
  handler: async (args) => {
    const cwd = directory(args.directory)
    await bootstrap(cwd, async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof globalThis.fetch

      const data = await api<{ success: boolean; orchestratorStarted: boolean }>(fetchFn, "POST", "/taskmode/enable", cwd, {
        startOrchestrator: !args.noOrchestrator,
        parentSessionId: args.parentSession,
        folderName: args.folder,
        tddMode: args.tdd,
      })

      if (data.orchestratorStarted) {
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓  Task mode enabled (orchestrator started)")
      } else {
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓  Task mode enabled")
      }
    })
  },
})

export const TaskModeDisableCommand = cmd({
  command: "disable",
  describe: "disable task mode and stop the orchestrator",
  builder: (yargs: Argv) =>
    yargs.option("directory", {
      alias: ["cwd", "dir"],
      type: "string",
      describe: "directory to run in",
    }),
  handler: async (args) => {
    const cwd = directory(args.directory)
    await bootstrap(cwd, async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof globalThis.fetch

      await api(fetchFn, "POST", "/taskmode/disable", cwd)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓  Task mode disabled")
    })
  },
})

export const TaskModeStatusCommand = cmd({
  command: "status",
  describe: "show task mode status",
  builder: (yargs: Argv) =>
    yargs.option("directory", {
      alias: ["cwd", "dir"],
      type: "string",
      describe: "directory to run in",
    }),
  handler: async (args) => {
    const cwd = directory(args.directory)
    await bootstrap(cwd, async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof globalThis.fetch

      const status = await api<{
        enabled: boolean
        exists: boolean
        path: string
        orchestratorRunning: boolean
        parentSessionId?: string
        activeTasks: number
        counts?: {
          total: number
          pending: number
          inProgress: number
          completed: number
          error: number
          paused: number
        }
      }>(fetchFn, "GET", "/taskmode/status", cwd)

      const counts = status.counts
        ? `tasks: ${status.counts.total} (pending ${status.counts.pending}, in-progress ${status.counts.inProgress}, done ${status.counts.completed}, error ${status.counts.error}, paused ${status.counts.paused})`
        : "tasks: n/a"

      UI.println(
        [
          `enabled=${String(status.enabled)}`,
          `orchestrator=${status.orchestratorRunning ? "running" : "stopped"}`,
          status.parentSessionId ? `parentSession=${status.parentSessionId}` : "parentSession=none",
          `activeTasks=${status.activeTasks}`,
          `taskList=${status.exists ? "yes" : "no"} (${status.path})`,
          counts,
        ].join("\n"),
      )
    })
  },
})
