import { Log } from "../util/log"
import { Config } from "../config/config"
import type { Tool } from "../tool/tool"
import type { Workflow } from "./workflow"
import { WorkflowTool } from "./tool"

export namespace WorkflowRegistry {
  const log = Log.create({ service: "workflow-registry" })
  const workflows = new Map<string, Workflow.Definition>()

  export function register(workflow: Workflow.Definition): void {
    log.info("registering workflow", { id: workflow.id, name: workflow.name })
    workflows.set(workflow.id, workflow)
  }

  export function get(id: string): Workflow.Definition | undefined {
    return workflows.get(id)
  }

  export function list(): Workflow.Definition[] {
    return Array.from(workflows.values())
  }

  export function toolInvocableWorkflows(): Tool.Info[] {
    return Array.from(workflows.values()).flatMap((w) => {
      const tool = WorkflowTool.fromWorkflow(w)
      return tool ? [tool] : []
    })
  }

  export async function getActive(): Promise<Workflow.Definition | undefined> {
    const config = await Config.get()

    // Check explicit workflows.active config
    const activeId = (config as Record<string, any>).workflows?.active as string | undefined
    if (activeId) {
      const workflow = workflows.get(activeId)
      if (workflow) return workflow
      log.warn("configured active workflow not found", { activeId })
    }

    // Fallback: check taskMode.enabled → "task"
    if (config.taskMode?.enabled) {
      return workflows.get("task")
    }

    return undefined
  }
}
