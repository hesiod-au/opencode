import z from "zod"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { Tool } from "../tool/tool"
import { WorkflowEvent } from "./events"
import type { Workflow } from "./workflow"

export namespace WorkflowTool {
  const log = Log.create({ service: "workflow-tool" })

  export function fromWorkflow(workflow: Workflow.Definition): Tool.Info | undefined {
    if (!workflow.toolInvocable) return

    const config = workflow.toolInvocable
    const toolId = `workflow_${workflow.id}`

    return Tool.define(toolId, {
      description: config.description,
      parameters: config.parameters ?? z.object({}),
      async execute(args, ctx) {
        await ctx.ask({
          permission: "workflow",
          patterns: [workflow.id],
          metadata: {},
          always: [],
        })

        if (workflow.isRunning()) {
          return {
            title: `Workflow ${workflow.id}`,
            output: `Workflow "${workflow.id}" is already running.`,
            metadata: {},
          }
        }

        log.info("starting workflow from tool", { workflowId: workflow.id, sessionId: ctx.sessionID })

        const result = await new Promise<{ reason: string; reportSessionId?: string }>((resolve) => {
          const unsub = Bus.subscribe(WorkflowEvent.Stopped, (event) => {
            if (event.properties.workflowId !== workflow.id) return
            unsub()
            resolve({
              reason: event.properties.reason,
              reportSessionId: event.properties.reportSessionId,
            })
          })

          workflow
            .start({
              parentSessionId: ctx.sessionID,
              userPrompt: config.parameters ? JSON.stringify(args) : undefined,
            })
            .catch((err) => {
              unsub()
              resolve({ reason: "error" })
            })
        })

        const status = workflow.getStatus()
        const output = [
          `Workflow "${workflow.id}" ${result.reason}.`,
          status.phase ? `Final phase: ${status.phase}` : "",
          result.reportSessionId ? `Report session: ${result.reportSessionId}` : "",
        ]
          .filter(Boolean)
          .join("\n")

        return {
          title: `Workflow ${workflow.id}`,
          output,
          metadata: {},
        }
      },
    })
  }
}
