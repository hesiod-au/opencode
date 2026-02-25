import { Log } from "../util/log"
import { Bus } from "../bus"
import { WorkflowEvent } from "./events"
import { WorkflowRegistry } from "./registry"
import { Workflow } from "./workflow"

export namespace ComposableWorkflow {
  const log = Log.create({ service: "composable-workflow" })

  interface Options {
    id: string
    name: string
    activationMode?: Workflow.ActivationMode
    recursive?: boolean
    disabledTools?: string[]
    toolInvocable?: Workflow.ToolConfig
  }

  interface State {
    running: boolean
    currentStepIndex: number
    abortController: AbortController
    parentSessionId?: string
    startedAt: number
    completedAt?: number
    results: Map<string, Workflow.StepResult>
    stepStatuses: Record<string, Workflow.StepResult["status"] | "running" | "pending">
    subWorkflowUnsub?: () => void
  }

  export function step(id: string, name: string, fn: Workflow.StepFunction["execute"]): Workflow.StepFunction {
    return { type: "function", id, name, execute: fn }
  }

  export function sub(workflowId: string): Workflow.StepWorkflow {
    return { type: "workflow", workflowId }
  }

  export function define(options: Options, steps: Workflow.Step[]): Workflow.Definition {
    let state: State | null = null

    function stepId(s: Workflow.Step): string {
      return s.type === "function" ? s.id : s.workflowId
    }

    function stepName(s: Workflow.Step): string {
      return s.type === "function" ? s.name : s.workflowId
    }

    function progress(msg: string) {
      log.info("progress", { workflow: options.id, message: msg })
      Bus.publish(WorkflowEvent.Progress, { workflowId: options.id, message: msg })
    }

    const definition: Workflow.Definition = {
      id: options.id,
      name: options.name,
      activationMode: options.activationMode ?? "start",
      recursive: options.recursive,
      disabledTools: options.disabledTools,
      steps,
      toolInvocable: options.toolInvocable,

      async start(opts) {
        if (state?.running) {
          log.warn("workflow already running", { id: options.id })
          return
        }

        state = {
          running: true,
          currentStepIndex: 0,
          abortController: new AbortController(),
          parentSessionId: opts.parentSessionId,
          startedAt: Date.now(),
          results: new Map(),
          stepStatuses: Object.fromEntries(steps.map((s) => [stepId(s), "pending"])),
        }

        Bus.publish(WorkflowEvent.Started, {
          workflowId: options.id,
          parentSessionId: opts.parentSessionId,
        })

        try {
          await run(opts)
        } catch (err: any) {
          log.error("workflow error", { id: options.id, error: err })
          progress(`Error: ${err.message}`)
          await definition.stop("error")
        }
      },

      async stop(reason) {
        if (!state) return
        log.info("stopping workflow", { id: options.id, reason })

        state.running = false
        state.completedAt = Date.now()
        state.abortController.abort()
        state.subWorkflowUnsub?.()

        Bus.publish(WorkflowEvent.Stopped, { workflowId: options.id, reason })
        state = null
      },

      getStatus() {
        return {
          running: state?.running ?? false,
          phase: state ? stepName(steps[state.currentStepIndex] ?? steps[steps.length - 1]) : undefined,
          parentSessionId: state?.parentSessionId,
          startedAt: state?.startedAt,
          completedAt: state?.completedAt,
          extra: {
            currentStepIndex: state?.currentStepIndex ?? 0,
            stepStatuses: state?.stepStatuses ?? {},
          },
        }
      },

      isRunning() {
        return state?.running ?? false
      },
    }

    async function run(opts: Workflow.StartOptions) {
      let previous: Workflow.StepResult | undefined

      for (let i = 0; i < steps.length; i++) {
        if (!state?.running) return
        const s = steps[i]
        const id = stepId(s)
        state.currentStepIndex = i

        Bus.publish(WorkflowEvent.PhaseChanged, {
          workflowId: options.id,
          phase: stepName(s),
        })
        Bus.publish(WorkflowEvent.StepStarted, {
          workflowId: options.id,
          stepId: id,
          stepIndex: i,
        })
        state.stepStatuses[id] = "running"

        const stepDisabledTools = Workflow.buildDisabledTools(definition, s.type === "function" ? s : undefined)

        const ctx: Workflow.StepContext = {
          abort: state.abortController.signal,
          parentSessionId: opts.parentSessionId,
          userPrompt: opts.userPrompt,
          previousResult: previous,
          results: state.results,
          disabledTools: stepDisabledTools,
          progress,
        }

        let result: Workflow.StepResult

        if (s.type === "function") {
          result = await s.execute(ctx)
        } else {
          result = await runSubWorkflow(s.workflowId, opts)
        }

        if (!state) return
        state.results.set(id, result)
        state.stepStatuses[id] = result.status
        previous = result

        Bus.publish(WorkflowEvent.StepCompleted, {
          workflowId: options.id,
          stepId: id,
          stepIndex: i,
        })

        if (result.status === "error") {
          progress(`Step "${stepName(s)}" failed: ${result.output ?? "unknown error"}`)
          await definition.stop("error")
          return
        }
      }

      if (state?.running) {
        progress("All steps completed")
        await definition.stop("completed")
      }
    }

    async function runSubWorkflow(workflowId: string, opts: Workflow.StartOptions): Promise<Workflow.StepResult> {
      const workflow = WorkflowRegistry.get(workflowId)
      if (!workflow) return { status: "error", output: `Sub-workflow "${workflowId}" not found` }

      return new Promise<Workflow.StepResult>((resolve) => {
        const unsub = Bus.subscribe(WorkflowEvent.Stopped, (event) => {
          if (event.properties.workflowId !== workflowId) return
          unsub()
          if (state) state.subWorkflowUnsub = undefined
          resolve({
            status: event.properties.reason === "completed" ? "completed" : "error",
            output: `Sub-workflow "${workflowId}" ${event.properties.reason}`,
          })
        })
        if (state) state.subWorkflowUnsub = unsub
        workflow.start(opts).catch((err) => {
          unsub()
          if (state) state.subWorkflowUnsub = undefined
          resolve({ status: "error", output: `Sub-workflow "${workflowId}" failed: ${err.message}` })
        })
      })
    }

    return definition
  }
}
