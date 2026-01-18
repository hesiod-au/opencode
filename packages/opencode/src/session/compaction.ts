import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { LLM } from "./llm"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  // Default compaction prompt
  export const DEFAULT_PROMPT =
    "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."

  // Compaction prompt templates
  export const TEMPLATES = {
    default: DEFAULT_PROMPT,
    "code-changes": `List only the code changes made:
- Files created/modified/deleted
- Key functions or components changed
- No conversation summary needed`,
    decisions: `Summarize the decisions made:
- What approaches were chosen and why
- What was rejected and why
- Key constraints or requirements identified`,
    technical: `Keep technical details, minimize conversation:
- API endpoints, data structures, algorithms
- Configuration changes
- Dependencies added/removed
- Error messages and solutions`,
  } as const

  export type TemplateKey = keyof typeof TEMPLATES

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = input.model.limit.input || context - output
    return count > usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID, includeCompacted: false })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  // Preview compaction - generates summary without applying
  export const preview = fn(
    z.object({
      sessionID: z.string(),
      providerID: z.string(),
      modelID: z.string(),
      prompt: z.string().optional(),
      partIds: z.array(z.string()).optional(),
    }),
    async (input): Promise<{ summary: string; tokenEstimate: number }> => {
      const msgs = await Session.messages({ sessionID: input.sessionID, includeCompacted: false })
      const agent = await Agent.get("compaction")
      const model = await Provider.getModel(input.providerID, input.modelID)

      // Filter messages if partIds specified (selective compaction)
      let contextMessages = msgs
      if (input.partIds && input.partIds.length > 0) {
        const partIdSet = new Set(input.partIds)
        contextMessages = msgs
          .map((msg) => ({
            ...msg,
            parts: msg.parts.filter((p) => partIdSet.has(p.id)),
          }))
          .filter((msg) => msg.parts.length > 0)
      }

      // Use custom prompt or default
      const promptText = input.prompt || DEFAULT_PROMPT

      // Build messages for the LLM call
      const llmMessages = [
        ...MessageV2.toModelMessage(contextMessages),
        {
          role: "user" as const,
          content: promptText,
        },
      ]

      // Find a user message for context
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
      const userMsgForLLM: MessageV2.User = lastUserMsg || {
        id: "preview",
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "compaction",
        model: { providerID: input.providerID, modelID: input.modelID },
      }

      // Generate preview using LLM
      const modelMessages = MessageV2.toModelMessage(contextMessages)
      log.info("generating compaction preview", {
        sessionID: input.sessionID,
        messageCount: contextMessages.length,
        modelMessageCount: modelMessages.length,
        promptLength: promptText.length,
      })

      if (modelMessages.length === 0) {
        log.warn("no messages to summarize for compaction preview")
        throw new Error("No messages to summarize - conversation may be empty or all messages filtered out")
      }

      const result = await LLM.stream({
        agent,
        user: userMsgForLLM,
        system: [],
        small: false,
        tools: {},
        model,
        abort: new AbortController().signal,
        sessionID: input.sessionID,
        retries: 2,
        messages: llmMessages,
      })

      const summary = await result.text.catch((err) => {
        log.error("failed to generate compaction preview", { error: err })
        throw new Error("Failed to generate summary: " + (err instanceof Error ? err.message : String(err)))
      })

      log.info("compaction preview raw result", { summaryType: typeof summary, summaryLength: summary?.length ?? 0 })

      if (!summary || typeof summary !== "string" || !summary.trim()) {
        log.error("compaction preview returned empty or invalid summary", { summary, summaryType: typeof summary })
        throw new Error("LLM returned empty summary")
      }

      const tokenEstimate = Token.estimate(summary)
      log.info("compaction preview generated", { tokenEstimate, summaryLength: summary.length })

      return { summary, tokenEstimate }
    },
  )

  // Apply a custom/edited summary as the compaction result
  export const applyCustomSummary = fn(
    z.object({
      sessionID: z.string(),
      providerID: z.string(),
      modelID: z.string(),
      summary: z.string(),
      auto: z.boolean().optional().default(false),
    }),
    async (input) => {
      log.info("applyCustomSummary: starting", {
        sessionID: input.sessionID,
        summaryLength: input.summary.length,
        auto: input.auto,
      })

      const msgs = await Session.messages({ sessionID: input.sessionID, includeCompacted: false })
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User

      if (!lastUserMsg) {
        log.error("applyCustomSummary: no user message found")
        throw new Error("No user message found in session")
      }

      log.info("applyCustomSummary: found last user message", {
        lastUserMsgID: lastUserMsg.id,
        agent: lastUserMsg.agent,
      })

      // Create the compaction marker (user message with compaction part)
      const userMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: { providerID: input.providerID, modelID: input.modelID },
        sessionID: input.sessionID,
        agent: lastUserMsg.agent || "compaction",
        time: { created: Date.now() },
      })
      log.info("applyCustomSummary: created compaction user message", { userMsgID: userMsg.id })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        type: "compaction",
        auto: input.auto,
      })
      log.info("applyCustomSummary: created compaction part")

      // Create the assistant response with the custom summary
      const model = await Provider.getModel(input.providerID, input.modelID)
      const assistantMsg = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: userMsg.id,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          output: Token.estimate(input.summary),
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: "end-turn",
      })) as MessageV2.Assistant

      log.info("applyCustomSummary: created assistant message", {
        assistantMsgID: assistantMsg.id,
        parentID: userMsg.id,
      })

      // Add the summary as a text part
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantMsg.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.summary,
      })
      log.info("applyCustomSummary: created text part with summary")

      Bus.publish(Event.Compacted, { sessionID: input.sessionID })
      log.info("applyCustomSummary: published Compacted event", { sessionID: input.sessionID })

      return assistantMsg
    },
  )

  // Selective compaction - marks specific parts as excluded and adds summary
  // This does NOT create a compaction boundary - original messages stay visible but excluded from LLM
  export const applySelectiveCompaction = fn(
    z.object({
      sessionID: z.string(),
      providerID: z.string(),
      modelID: z.string(),
      summary: z.string(),
      partIds: z.array(z.string()),
    }),
    async (input) => {
      log.info("applySelectiveCompaction: starting", {
        sessionID: input.sessionID,
        summaryLength: input.summary.length,
        partCount: input.partIds.length,
      })

      if (input.partIds.length === 0) {
        throw new Error("No parts selected for compaction")
      }

      const msgs = await Session.messages({ sessionID: input.sessionID, includeCompacted: true })
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User

      if (!lastUserMsg) {
        throw new Error("No user message found in session")
      }

      // Mark selected parts as excluded
      const partIdSet = new Set(input.partIds)
      let markedCount = 0
      for (const msg of msgs) {
        for (const part of msg.parts) {
          if (partIdSet.has(part.id) && !part.excluded) {
            part.excluded = true
            await Session.updatePart(part)
            markedCount++
          }
        }
      }

      log.info("applySelectiveCompaction: marked parts as excluded", { markedCount })

      // Create a user message to hold the summary request
      const userMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: { providerID: input.providerID, modelID: input.modelID },
        sessionID: input.sessionID,
        agent: lastUserMsg.agent || "compaction",
        time: { created: Date.now() },
      })

      // Add a synthetic text part explaining this is a compaction summary
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: `[Summarized ${input.partIds.length} parts]`,
        time: { start: Date.now(), end: Date.now() },
      })

      // Create the assistant response with the summary
      const model = await Provider.getModel(input.providerID, input.modelID)
      const assistantMsg = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: userMsg.id,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        // NOTE: NOT setting summary: true - this is NOT a compaction boundary
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          output: Token.estimate(input.summary),
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: "end-turn",
      })) as MessageV2.Assistant

      // Add the summary as a text part
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantMsg.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.summary,
      })

      log.info("applySelectiveCompaction: completed", {
        assistantMsgID: assistantMsg.id,
        markedCount,
      })

      Bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return { assistantMsg, markedCount }
    },
  )

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    customPrompt?: string
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    // Use custom prompt if provided, otherwise check plugin, then use default
    const promptText = input.customPrompt ?? compacting.prompt ?? [DEFAULT_PROMPT, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessage(input.messages),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
