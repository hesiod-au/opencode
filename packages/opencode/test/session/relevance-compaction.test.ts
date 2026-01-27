import { describe, expect, mock, test } from "bun:test"

const queue: string[] = []
const llmCalls = { count: 0 }
const processorState = { messages: [] as { role: string; content: unknown }[] }

mock.module("../../src/session/llm", () => ({
  LLM: {
    stream: async () => {
      llmCalls.count += 1
      return {
        text: Promise.resolve(queue.shift() ?? ""),
      }
    },
  },
}))

mock.module("../../src/session/processor", () => ({
  SessionProcessor: {
    create: (input: { assistantMessage: { id: string } }) => ({
      get message() {
        return input.assistantMessage
      },
      partFromToolCall: () => undefined,
      process: async (args: { messages: { role: string; content: unknown }[] }) => {
        processorState.messages = args.messages
        return "stop"
      },
    }),
  },
}))

mock.module("../../src/session/summary", () => ({
  SessionSummary: {
    summarize: async () => {},
  },
}))

import { Instance } from "../../src/project/instance"
import { SessionRelevanceCompaction } from "../../src/session/relevance-compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { Collision } from "../../src/task-mode/collision"
import { SessionPrompt } from "../../src/session/prompt"
import { Token } from "../../src/util/token"
import type { Provider } from "../../src/provider/provider"

function createModel(opts: { context: number; output: number; id?: string; providerID?: string }): Provider.Model {
  return {
    id: opts.id ?? "test-model",
    providerID: opts.providerID ?? "test",
    name: "Test",
    limit: {
      context: opts.context,
      output: opts.output,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

function textPart(messageID: string, id: string, text: string): MessageV2.TextPart {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "text",
    text,
  }
}

function userMessage(id: string, text: string): MessageV2.WithParts {
  const info: MessageV2.User = {
    id,
    sessionID: "session",
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.2-codex" },
    tools: {},
  }
  return { info, parts: [textPart(id, `p-${id}`, text)] }
}

function assistantMessage(id: string, parentID: string, text: string): MessageV2.WithParts {
  const info: MessageV2.Assistant = {
    id,
    sessionID: "session",
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: "gpt-5.2-codex",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
  return { info, parts: [textPart(id, `p-${id}`, text)] }
}

function buildTurns(count: number): MessageV2.WithParts[] {
  const messages: MessageV2.WithParts[] = []
  for (const index of Array.from({ length: count }).keys()) {
    const turn = index + 1
    const userID = `u${turn}`
    const assistantID = `a${turn}`
    messages.push(userMessage(userID, `user-${turn}`))
    messages.push(assistantMessage(assistantID, userID, `assistant-${turn}`))
  }
  return messages
}

function resetQueue(responses: string[]) {
  queue.splice(0, queue.length, ...responses)
  llmCalls.count = 0
}

describe("session.compaction.relevance", () => {
  test("drops candidate messages when judge returns DROP", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          relevance: {
            target: 0.6,
            trigger: 0.1,
            recent: 4,
          },
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue(["anchor", "DECISION: DROP\nCONFIDENCE: 0.9", "DECISION: DROP\nCONFIDENCE: 0.9"])
        const model = createModel({ context: 1000, output: 100 })
        const result = await SessionRelevanceCompaction.compact({
          sessionID: "session",
          messages: buildTurns(5),
          model,
          agent: "task",
          mode: "build",
          abort: new AbortController().signal,
        })
        const ids = result.map((msg) => msg.info.id)
        expect(ids).not.toContain("u1")
        expect(ids).not.toContain("a1")
      },
    })
  })

  test("keeps messages when judge confidence is below threshold", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          relevance: {
            target: 0.6,
            trigger: 0.1,
            recent: 4,
          },
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue(["anchor", "DECISION: DROP\nCONFIDENCE: 0.6", "DECISION: DROP\nCONFIDENCE: 0.6"])
        const model = createModel({ context: 1000, output: 100 })
        const result = await SessionRelevanceCompaction.compact({
          sessionID: "session",
          messages: buildTurns(5),
          model,
          agent: "task",
          mode: "build",
          abort: new AbortController().signal,
        })
        const ids = result.map((msg) => msg.info.id)
        expect(ids).toContain("u1")
        expect(ids).toContain("a1")
      },
    })
  })

  test("defaults target ratio to 0.6", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          relevance: {},
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue([])
        const messages = buildTurns(5)
        const tokens = Token.estimate(JSON.stringify(MessageV2.toModelMessage(messages)))
        const output = 100
        const reserve = Math.min(output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
        const usable = Math.ceil(tokens / 0.55)
        const model = createModel({ context: usable + reserve, output })
        const result = await SessionRelevanceCompaction.compact({
          sessionID: "session",
          messages,
          model,
          agent: "task",
          mode: "build",
          abort: new AbortController().signal,
        })
        expect(result.map((msg) => msg.info.id)).toEqual(messages.map((msg) => msg.info.id))
        expect(llmCalls.count).toBe(0)
      },
    })
  })

  test("uses codex model target override", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          relevance: {},
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue(["anchor", "DECISION: DROP\nCONFIDENCE: 0.9", "DECISION: DROP\nCONFIDENCE: 0.9"])
        const messages = buildTurns(5)
        const tokens = Token.estimate(JSON.stringify(MessageV2.toModelMessage(messages)))
        const output = 100
        const reserve = Math.min(output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
        const usable = Math.ceil(tokens / 0.4)
        const model = createModel({ context: usable + reserve, output, id: "codex", providerID: "openai" })
        const result = await SessionRelevanceCompaction.compact({
          sessionID: "session",
          messages,
          model,
          agent: "task",
          mode: "build",
          abort: new AbortController().signal,
        })
        const ids = result.map((msg) => msg.info.id)
        expect(ids).not.toContain("u1")
        expect(ids).not.toContain("a1")
        expect(llmCalls.count).toBeGreaterThan(0)
      },
    })
  })
})

describe("session.compaction.relevance task integration", () => {
  test("compacts task sessions before processing", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          auto: false,
          prune: false,
          relevance: {
            target: 0.6,
            trigger: 0,
            recent: 1,
            agent: { task: true },
          },
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue([
          "anchor",
          "DECISION: DROP\nCONFIDENCE: 0.9",
          "DECISION: DROP\nCONFIDENCE: 0.9",
          "DECISION: KEEP\nCONFIDENCE: 0.9",
          "DECISION: KEEP\nCONFIDENCE: 0.9",
        ])
        processorState.messages = []

        const session = await Session.create({})
        Collision.registerTaskSession(session.id, {
          taskId: "001",
          taskTitle: "Task",
          paths: {
            taskListPath: "/tmp/task_list.md",
            tasksDir: "/tmp/tasks",
            lockPath: "/tmp/lock",
          },
        })

        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.2-codex" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "old message",
        })
        const assistant1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-5.2-codex",
          providerID: "openai",
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant1.id,
          sessionID: session.id,
          type: "text",
          text: "old reply",
        })

        const user2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.2-codex" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user2.id,
          sessionID: session.id,
          type: "text",
          text: "keep message",
        })
        const assistant2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user2.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-5.2-codex",
          providerID: "openai",
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant2.id,
          sessionID: session.id,
          type: "text",
          text: "keep reply",
        })

        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "openai", modelID: "gpt-5.2-codex" },
          agent: "build",
          parts: [{ type: "text", text: "new message" }],
        })

        const text = JSON.stringify(processorState.messages)
        expect(text).not.toContain("old message")
        expect(text).toContain("keep message")
        expect(text).toContain("new message")

        Collision.unregisterTaskSession(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("skips relevance compaction for non-task sessions", async () => {
    await using tmp = await tmpdir({
      config: {
        compaction: {
          auto: false,
          prune: false,
          relevance: {
            target: 0.6,
            trigger: 0,
            recent: 1,
            agent: { task: true },
          },
        },
      } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        resetQueue(["anchor", "DECISION: DROP\nCONFIDENCE: 0.9"])
        processorState.messages = []

        const session = await Session.create({})
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.2-codex" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "old message",
        })

        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "openai", modelID: "gpt-5.2-codex" },
          agent: "build",
          parts: [{ type: "text", text: "new message" }],
        })

        const text = JSON.stringify(processorState.messages)
        expect(text).toContain("old message")
        expect(text).toContain("new message")
        expect(llmCalls.count).toBe(0)

        await Session.remove(session.id)
      },
    })
  })
})
