import { test, expect, mock } from "bun:test"

mock.module("../../src/session/llm", () => ({
  LLM: {
    stream: async () => ({
      text: Promise.resolve("Auto Title"),
    }),
  },
}))

mock.module("../../src/session/processor", () => ({
  SessionProcessor: {
    create: (input: { assistantMessage: { id: string } }) => ({
      get message() {
        return input.assistantMessage
      },
      partFromToolCall: () => undefined,
      process: async () => "stop",
    }),
  },
}))

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"

const waitForTitle = async (sessionID: string) => {
  for (const _ of Array.from({ length: 20 })) {
    const current = await Session.get(sessionID)
    if (!Session.isDefaultTitle(current.title)) return current.title
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return undefined
}

test("auto-title updates default session title", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const defaultTitle = session.title

      await SessionPrompt.prompt({
        sessionID: session.id,
        model: {
          providerID: "openai",
          modelID: "gpt-4o-mini",
        },
        parts: [
          {
            type: "text",
            text: "Explain how auto-title works.",
          },
        ],
      })

      const title = await waitForTitle(session.id)
      expect(title).toBeDefined()
      expect(title).toBe("Auto Title")
      expect(title).not.toBe(defaultTitle)
      expect(Session.isDefaultTitle(title!)).toBe(false)

      await Session.remove(session.id)
    },
  })
})
