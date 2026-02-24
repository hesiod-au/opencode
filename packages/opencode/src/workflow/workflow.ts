export namespace Workflow {
  export type ActivationMode = "start" | "enable" | "both"

  export interface Definition<Phase extends string = string> {
    id: string
    name: string
    activationMode: ActivationMode
    start(options: StartOptions): Promise<void>
    stop(reason: StopReason): Promise<void>
    getStatus(): Status<Phase>
    isRunning(): boolean
    confirmPlan?(): Promise<void>
  }

  export interface StartOptions {
    parentSessionId?: string
    userPrompt?: string
  }

  export type StopReason = "completed" | "error" | "manual"

  export interface Status<Phase extends string = string> {
    running: boolean
    phase?: Phase
    phaseDetail?: string
    parentSessionId?: string
    startedAt?: number
    completedAt?: number
    stats?: {
      inputTokens: number
      outputTokens: number
      cost: number
      modifiedFiles: string[]
    }
    extra?: Record<string, unknown>
  }
}
