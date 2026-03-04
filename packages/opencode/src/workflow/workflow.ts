import type z from "zod"

export namespace Workflow {
  export type ActivationMode = "start" | "enable" | "both"

  export interface Definition<Phase extends string = string> {
    id: string
    name: string
    activationMode: ActivationMode
    recursive?: boolean
    disabledTools?: string[]
    steps?: Step[]
    toolInvocable?: ToolConfig
    start(options: StartOptions): Promise<void>
    stop(reason: StopReason): Promise<void>
    getStatus(): Status<Phase>
    isRunning(): boolean
    confirmPlan?(): Promise<void>
  }

  export interface StartOptions {
    parentSessionId?: string
    userPrompt?: string
    runId?: string
  }

  export type StopReason = "completed" | "error" | "manual"

  export interface Status<Phase extends string = string> {
    running: boolean
    phase?: Phase
    phaseDetail?: string
    parentSessionId?: string
    startedAt?: number
    completedAt?: number
    runId?: string
    progress?: {
      current: number
      total: number
      label?: string
    }
    stats?: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
    extra?: Record<string, unknown>
  }

  export interface StepContext {
    abort: AbortSignal
    parentSessionId?: string
    userPrompt?: string
    previousResult?: StepResult
    results: Map<string, StepResult>
    disabledTools: Record<string, false>
    progress(msg: string): void
  }

  export interface StepResult {
    status: "completed" | "error"
    output?: string
    data?: Record<string, unknown>
  }

  export interface StepFunction {
    type: "function"
    id: string
    name: string
    disabledTools?: string[]
    execute(ctx: StepContext): Promise<StepResult>
  }

  export interface StepWorkflow {
    type: "workflow"
    workflowId: string
  }

  export type Step = StepFunction | StepWorkflow

  export interface ToolConfig {
    description: string
    parameters?: z.ZodObject<any>
  }

  export function buildDisabledTools(
    workflow: Pick<Definition, "id" | "recursive" | "disabledTools">,
    step?: Pick<StepFunction, "disabledTools">,
  ): Record<string, false> {
    const result: Record<string, false> = {}
    if (!workflow.recursive) result[`workflow_${workflow.id}`] = false
    for (const id of workflow.disabledTools ?? []) result[id] = false
    for (const id of step?.disabledTools ?? []) result[id] = false
    return result
  }
}
