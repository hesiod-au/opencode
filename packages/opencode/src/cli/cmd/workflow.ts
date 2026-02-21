import type { Argv } from "yargs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Server } from "../../server/server"
import { WorkflowRegistry } from "../../workflow/registry"

export const WorkflowCommand = cmd({
  command: "workflow <action> [id]",
  describe: "manage workflows",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        describe: "action to perform",
        type: "string",
        choices: ["list", "start", "stop", "status"],
        demandOption: true,
      })
      .positional("id", {
        describe: "workflow id",
        type: "string",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      // Ensure server app is initialized (registers workflows)
      Server.App()

      if (args.action === "list") {
        const workflows = WorkflowRegistry.list()
        if (workflows.length === 0) {
          UI.println("No workflows registered")
          return
        }
        for (const w of workflows) {
          const status = w.isRunning() ? UI.Style.TEXT_SUCCESS_BOLD + "running" : UI.Style.TEXT_DIM + "stopped"
          UI.println(`${w.id} — ${w.name} [${status}${UI.Style.TEXT_NORMAL}]`)
        }
        return
      }

      if (!args.id) {
        UI.error("Workflow id is required for this action")
        process.exit(1)
      }

      const workflow = WorkflowRegistry.get(args.id)
      if (!workflow) {
        UI.error(`Workflow "${args.id}" not found`)
        process.exit(1)
      }

      if (args.action === "status") {
        const status = workflow.getStatus()
        UI.println(`Workflow: ${workflow.name} (${workflow.id})`)
        UI.println(`Running: ${status.running}`)
        if (status.phase) UI.println(`Phase: ${status.phase}`)
        if (status.phaseDetail) UI.println(`Detail: ${status.phaseDetail}`)
        if (status.startedAt) UI.println(`Started: ${new Date(status.startedAt).toISOString()}`)
        if (status.completedAt) UI.println(`Completed: ${new Date(status.completedAt).toISOString()}`)
        return
      }

      if (args.action === "start") {
        if (workflow.isRunning()) {
          UI.error("Workflow is already running")
          process.exit(1)
        }
        await workflow.start({})
        UI.println(`Workflow "${workflow.name}" started`)
        return
      }

      if (args.action === "stop") {
        if (!workflow.isRunning()) {
          UI.error("Workflow is not running")
          process.exit(1)
        }
        await workflow.stop("manual")
        UI.println(`Workflow "${workflow.name}" stopped`)
        return
      }
    })
  },
})
