import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Config } from "../../config/config"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("task-mode", {
        alias: ["task"],
        type: "boolean",
        describe: "enable task mode (writes config before server start)",
      })
      .option("workflow", {
        type: "string",
        describe: "activate a workflow (e.g., task, pr-review)",
      })
      .option("pr-review", {
        type: "boolean",
        describe: "shorthand for --workflow pr-review",
      }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    // Enable task mode at startup if requested
    if (args.taskMode) {
      await Config.update({ taskMode: { enabled: true } })
    }

    // Enable workflow via config
    const workflowId = args.prReview ? "pr-review" : args.workflow
    if (workflowId) {
      if (workflowId === "task") {
        await Config.update({ taskMode: { enabled: true } })
      } else {
        await Config.update({ workflows: { active: workflowId } })
      }
    }

    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
