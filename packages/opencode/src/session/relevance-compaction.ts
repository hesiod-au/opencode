import PROMPT_RELEVANCE from "@/agent/prompt/compaction-relevance.txt"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { SessionPrompt } from "./prompt"
import { MessageV2 } from "./message-v2"
import { Provider } from "../provider/provider"
import { Token } from "../util/token"
import { LLM } from "./llm"

export namespace SessionRelevanceCompaction {
  const CONFIDENCE_MIN = 0.7
  const DEFAULT_RECENT = 4
  const USER_MSG_SHORT_TOKENS = 200

  type Decision = {
    decision: "keep" | "drop"
    confidence: number
  }

  type Prompts = {
    setup: string
    judge: string
  }

  type Input = {
    sessionID: string
    messages: MessageV2.WithParts[]
    model: Provider.Model
    agent: string
    mode: string
    abort: AbortSignal
  }

  const prompts = parsePrompts(PROMPT_RELEVANCE)

  export async function compact(input: Input): Promise<MessageV2.WithParts[]> {
    const config = await Config.get()
    const relevance = config.compaction?.relevance ?? {}
    const agentEnabled = relevance.agent?.[input.agent] ?? false
    const modeEnabled = relevance.mode ? (relevance.mode[input.mode] ?? false) : true
    if (!agentEnabled || !modeEnabled) return input.messages

    const target = resolveTarget({ relevance, model: input.model })
    const reserve = relevance.reserve ?? resolveReserve(input.model)
    const usable = resolveUsable({ model: input.model, reserve })
    if (usable <= 0) return input.messages

    const tokens = estimateMessages(input.messages, input.model)
    const pressure = tokens / usable
    const trigger = relevance.trigger ?? target
    if (pressure < trigger) return input.messages

    const recent = relevance.recent ?? DEFAULT_RECENT
    const user = resolveUser(input)
    if (!user) return input.messages

    const agent = await Agent.get("compaction")
    const judgeAgent = { ...agent, temperature: 0, prompt: "" }

    const anchor = await setupAnchor({ input, user, agent: judgeAgent })
    const pinned = new Set(input.messages.filter(isPinned).map((msg) => msg.info.id))

    const firstStart = recentStart(input.messages, recent)
    const firstPass = await judgePass({
      input,
      anchor,
      user,
      agent: judgeAgent,
      pinned,
      recentStart: firstStart,
      decisions: new Map(),
      recheck: false,
    })
    const firstResult = await applyDecisions({
      messages: input.messages,
      pinned,
      recentStart: firstStart,
      decisions: firstPass,
      llmInput: input,
      agent: judgeAgent,
    })
    const firstTokens = estimateMessages(firstResult, input.model)
    if (firstTokens <= usable * target) return firstResult

    const reducedRecent = Math.max(1, recent - 1)
    const secondStart = recentStart(input.messages, reducedRecent)
    const secondPass = await judgePass({
      input,
      anchor,
      user,
      agent: judgeAgent,
      pinned,
      recentStart: secondStart,
      decisions: firstPass,
      recheck: true,
    })
    return await applyDecisions({
      messages: input.messages,
      pinned,
      recentStart: secondStart,
      decisions: secondPass,
      llmInput: input,
      agent: judgeAgent,
    })
  }

  function parsePrompts(content: string): Prompts {
    const parts = content.split("\n---\n")
    const setup = parts[0]?.trim() ?? ""
    const judge = parts[1]?.trim() ?? ""
    return { setup, judge }
  }

  function resolveTarget(input: { relevance: Config.Info["compaction"]["relevance"]; model: Provider.Model }) {
    const override = input.relevance.model?.[`${input.model.providerID}/${input.model.id}`]
    if (override !== undefined) return override
    const modelOverride = input.relevance.model?.[input.model.id]
    if (modelOverride !== undefined) return modelOverride
    return input.relevance.target ?? 0.6
  }

  function resolveReserve(model: Provider.Model) {
    const output = Math.min(model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    return output
  }

  function resolveUsable(input: { model: Provider.Model; reserve: number }) {
    const context = input.model.limit.context
    if (context === 0) return 0
    return input.model.limit.input || context - input.reserve
  }

  function resolveUser(input: Input) {
    return input.messages.findLast((msg) => msg.info.role === "user")?.info as MessageV2.User | undefined
  }

  function estimateMessages(messages: MessageV2.WithParts[], model: Provider.Model) {
    const modelMessages = MessageV2.toModelMessages(messages, model)
    return Token.estimate(JSON.stringify(modelMessages))
  }

  function recentStart(messages: MessageV2.WithParts[], recent: number) {
    const indexes = messages.flatMap((msg, index) => (msg.info.role === "user" ? [index] : []))
    if (indexes.length === 0) return messages.length
    if (indexes.length <= recent) return 0
    return indexes[indexes.length - recent]
  }

  function isPinned(msg: MessageV2.WithParts) {
    if (msg.info.role === "assistant" && msg.info.error) return true
    if (msg.parts.some((part) => part.type === "compaction")) return true
    if (msg.parts.some((part) => part.type === "tool" && part.state.status === "error")) return true
    if (msg.info.role !== "user") return false
    if (msg.info.system) return true
    return msg.parts.some((part) => part.type === "text" && isConstraint(part.text))
  }

  function isConstraint(text: string) {
    return /\b(must|should|require|required|avoid|don't|do not|never|always|constraint|important)\b/i.test(text)
  }

  async function setupAnchor(input: { input: Input; user: MessageV2.User; agent: Agent.Info }) {
    const modelMessages = MessageV2.toModelMessages(input.input.messages, input.input.model)
    if (modelMessages.length === 0) return ""
    const result = await LLM.stream({
      agent: input.agent,
      user: input.user,
      system: [],
      small: false,
      tools: {},
      model: input.input.model,
      abort: input.input.abort,
      sessionID: input.input.sessionID,
      retries: 1,
      messages: [
        ...modelMessages,
        {
          role: "user",
          content: prompts.setup,
        },
      ],
    })
    const anchor = (await result.text).trim()
    return anchor
  }

  async function judgePass(input: {
    input: Input
    anchor: string
    user: MessageV2.User
    agent: Agent.Info
    pinned: Set<string>
    recentStart: number
    decisions: Map<string, Decision>
    recheck: boolean
  }) {
    for (const [index, msg] of input.input.messages.entries()) {
      if (index >= input.recentStart) continue
      if (input.pinned.has(msg.info.id)) continue

      const existing = input.decisions.get(msg.info.id)
      const needsJudge = !existing || (input.recheck && existing.confidence < CONFIDENCE_MIN)
      if (!needsJudge) continue

      const verdict = await judgeMessage({
        input: input.input,
        anchor: input.anchor,
        user: input.user,
        agent: input.agent,
        message: msg,
      })
      input.decisions.set(msg.info.id, verdict)
    }
    return input.decisions
  }

  async function judgeMessage(input: {
    input: Input
    anchor: string
    user: MessageV2.User
    agent: Agent.Info
    message: MessageV2.WithParts
  }): Promise<Decision> {
    const payload = formatMessage(input.message, input.input.model)
    const prompt = [prompts.judge, "SCOPE ANCHOR:", input.anchor || "(none)", "MESSAGE:", payload].join("\n\n")

    const result = await LLM.stream({
      agent: input.agent,
      user: input.user,
      system: [],
      small: false,
      tools: {},
      model: input.input.model,
      abort: input.input.abort,
      sessionID: input.input.sessionID,
      retries: 1,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    })

    const text = (await result.text).trim()
    const parsed = parseDecision(text)
    if (!parsed) return { decision: "keep", confidence: 0 }
    const confidence = Math.max(0, Math.min(1, parsed.confidence))
    return { decision: parsed.decision, confidence }
  }

  function formatMessage(message: MessageV2.WithParts, model: Provider.Model) {
    const modelMessages = MessageV2.toModelMessages([message], model)
    return JSON.stringify(modelMessages[0] ?? {}, null, 2)
  }

  function parseDecision(text: string): Decision | null {
    const decisionMatch = text.match(/DECISION:\s*(KEEP|DROP)/i)
    const confidenceMatch = text.match(/CONFIDENCE:\s*([01](?:\.\d+)?)/i)
    if (!decisionMatch || !confidenceMatch) return null
    const decision = decisionMatch[1].toLowerCase() as Decision["decision"]
    const confidence = Number.parseFloat(confidenceMatch[1])
    if (!Number.isFinite(confidence)) return null
    return { decision, confidence }
  }

  async function applyDecisions(input: {
    messages: MessageV2.WithParts[]
    pinned: Set<string>
    recentStart: number
    decisions: Map<string, Decision>
    llmInput: Input
    agent: Agent.Info
  }): Promise<MessageV2.WithParts[]> {
    // Phase 1: classify each message as kept or dropped
    const kept = new Set<string>()
    const dropped = new Set<string>()
    for (const [index, msg] of input.messages.entries()) {
      const dominated =
        !input.pinned.has(msg.info.id) &&
        index < input.recentStart &&
        (() => {
          const d = input.decisions.get(msg.info.id)
          return d && d.confidence >= CONFIDENCE_MIN && d.decision === "drop"
        })()
      if (dominated) {
        dropped.add(msg.info.id)
      } else {
        kept.add(msg.info.id)
      }
    }

    // Phase 2: rescue dropped user messages whose assistant
    // reply is kept (preserves turn pairing)
    const msgById = new Map(input.messages.map((m) => [m.info.id, m]))
    const substitutions = new Map<string, MessageV2.WithParts>()

    for (const msg of input.messages) {
      if (msg.info.role !== "assistant") continue
      if (!kept.has(msg.info.id)) continue
      const parentID = (msg.info as MessageV2.Assistant).parentID
      if (!dropped.has(parentID)) continue
      const parentMsg = msgById.get(parentID)
      if (!parentMsg) continue

      const tokens = Token.estimate(JSON.stringify(MessageV2.toModelMessages([parentMsg], input.llmInput.model)))
      if (tokens <= USER_MSG_SHORT_TOKENS) {
        kept.add(parentID)
        dropped.delete(parentID)
      } else {
        const summarised = await summariseUserMessage(parentMsg, input.llmInput, input.agent)
        substitutions.set(parentID, summarised)
        kept.add(parentID)
        dropped.delete(parentID)
      }
    }

    // Phase 3: build result with substitutions
    return input.messages.filter((msg) => kept.has(msg.info.id)).map((msg) => substitutions.get(msg.info.id) ?? msg)
  }

  async function summariseUserMessage(
    msg: MessageV2.WithParts,
    input: Input,
    agent: Agent.Info,
  ): Promise<MessageV2.WithParts> {
    const text = msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")

    if (!text.trim()) return msg

    const result = await LLM.stream({
      agent,
      user: msg.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model: input.model,
      abort: input.abort,
      sessionID: input.sessionID,
      retries: 1,
      messages: [
        {
          role: "user",
          content:
            "Summarise the following user message in 1-2 concise " +
            "sentences, preserving the key intent and any specific " +
            "requirements:\n\n" +
            text,
        },
      ],
    })

    const summary = (await result.text).trim()
    if (!summary) return msg

    return {
      info: msg.info,
      parts: msg.parts.map((p) => (p.type === "text" ? { ...p, text: "[Summarised] " + summary } : p)),
    }
  }
}
