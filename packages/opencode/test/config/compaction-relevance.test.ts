import { test, expect } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("relevance compaction defaults target to 0.6", async () => {
  await using tmp = await tmpdir({
    config: {
      compaction: {
        relevance: {},
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.relevance?.target).toBe(0.6)
    },
  })
})

test("relevance compaction accepts model target overrides", async () => {
  await using tmp = await tmpdir({
    config: {
      compaction: {
        relevance: {
          model: {
            "openai/gpt-5.2-codex": {
              target: 0.3,
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.relevance?.model?.["openai/gpt-5.2-codex"]?.target).toBe(0.3)
    },
  })
})
