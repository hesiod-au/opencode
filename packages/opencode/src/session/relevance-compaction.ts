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

    const tokens = estimateMessages(input.messages)
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
    const firstResult = applyDecisions({
      messages: input.messages,
      pinned,
      recentStart: firstStart,
      decisions: firstPass,
    })
    const firstTokens = estimateMessages(firstResult)
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
    return applyDecisions({
      messages: input.messages,
      pinned,
      recentStart: secondStart,
      decisions: secondPass,
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

  function estimateMessages(messages: MessageV2.WithParts[]) {
    const modelMessages = MessageV2.toModelMessage(messages)
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
    const modelMessages = MessageV2.toModelMessage(input.input.messages)
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
    const payload = formatMessage(input.message)
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

  function formatMessage(message: MessageV2.WithParts) {
    const modelMessages = MessageV2.toModelMessage([message])
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

  function applyDecisions(input: {
    messages: MessageV2.WithParts[]
    pinned: Set<string>
    recentStart: number
    decisions: Map<string, Decision>
  }) {
    return input.messages.filter((msg, index) => {
      if (input.pinned.has(msg.info.id)) return true
      if (index >= input.recentStart) return true
      const decision = input.decisions.get(msg.info.id)
      if (!decision) return true
      if (decision.confidence < CONFIDENCE_MIN) return true
      return decision.decision === "keep"
    })
  }
}
