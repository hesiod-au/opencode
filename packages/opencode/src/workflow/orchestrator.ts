import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { WorkflowStore } from "./store"

export namespace WorkflowOrchestrator {
  const log = Log.create({ service: "workflow-orchestrator" })

  /**
   * Initialize orchestrator session for a workflow.
   * Uses provided parentSessionId if available, otherwise creates new session.
   *
   * @param workflowName - Display name for the workflow (e.g., "Task Mode", "PR Review")
   * @param parentSessionId - Optional existing session ID to use as orchestrator
   * @returns Guaranteed non-null orchestrator session ID
   */
  export async function initializeOrchestrator(
    workflowId: string,
    workflowName: string,
    runId?: string,
    parentSessionId?: string,
  ): Promise<string> {
    if (parentSessionId) {
      log.info("using existing session as orchestrator", { workflowName, sessionId: parentSessionId })
      if (runId) {
        WorkflowStore.linkSession({
          runId,
          sessionId: parentSessionId,
          workflowId,
          role: "orchestrator",
          parentSessionId,
        }).catch((err) => {
          log.error("failed to link orchestrator session", { error: err, runId, sessionId: parentSessionId })
        })
      }
      return parentSessionId
    }

    const session = await Session.create({
      title: `Orchestrator: ${workflowName}`,
    })

    log.info("created new orchestrator session", { workflowName, sessionId: session.id })
    if (runId) {
      WorkflowStore.linkSession({
        runId,
        sessionId: session.id,
        workflowId,
        role: "orchestrator",
        parentSessionId,
      }).catch((err) => {
        log.error("failed to link orchestrator session", { error: err, runId, sessionId: session.id })
      })
    }
    return session.id
  }

  /**
   * Log progress message to orchestrator session as synthetic user message.
   *
   * @param orchestratorSessionId - The orchestrator session ID
   * @param text - Progress message to log
   */
  export async function logProgress(orchestratorSessionId: string, text: string): Promise<void> {
    try {
      const agent = await Agent.get("build")
      const model = agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
      const messageID = Identifier.ascending("message")
      const partID = Identifier.ascending("part")

      await Session.updateMessage({
        id: messageID,
        sessionID: orchestratorSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })

      await Session.updatePart({
        id: partID,
        sessionID: orchestratorSessionId,
        messageID,
        type: "text",
        text,
        synthetic: true,
      })

      log.info("logged progress to orchestrator", { sessionId: orchestratorSessionId, text: text.slice(0, 50) })
    } catch (err) {
      log.error("failed to log progress", { error: err, sessionId: orchestratorSessionId })
    }
  }

  /**
   * Set orchestrator session status to busy (working).
   *
   * @param orchestratorSessionId - The orchestrator session ID
   */
  export function setBusy(orchestratorSessionId: string): void {
    SessionStatus.set(orchestratorSessionId, { type: "busy" })
    log.info("orchestrator set to busy", { sessionId: orchestratorSessionId })
  }

  /**
   * Set orchestrator session status to waiting.
   *
   * @param orchestratorSessionId - The orchestrator session ID
   */
  export function setWaiting(orchestratorSessionId: string): void {
    SessionStatus.set(orchestratorSessionId, { type: "waiting" })
    log.info("orchestrator set to waiting", { sessionId: orchestratorSessionId })
  }

  /**
   * Set orchestrator session status to idle (completed).
   *
   * @param orchestratorSessionId - The orchestrator session ID
   */
  export function setIdle(orchestratorSessionId: string): void {
    SessionStatus.set(orchestratorSessionId, { type: "idle" })
    log.info("orchestrator set to idle", { sessionId: orchestratorSessionId })
  }
}
