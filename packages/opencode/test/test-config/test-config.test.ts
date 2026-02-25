import { describe, expect, test } from "bun:test"
import { TestConfigWorkflow } from "../../src/test-config/test-config"

describe("TestConfigWorkflow.getValidationPlan", () => {
  test("uses structured test methods and reports missing required commands", () => {
    const plan = TestConfigWorkflow.getValidationPlan({
      test_methods: {
        unit: { command: "bun test", required: true },
        endpoint: { command: "bun test test/api", required: true },
        e2e: { required: true },
      },
      commands: { test: "bun test legacy" },
    })

    expect(plan.mode).toBe("structured")
    expect(plan.runnable).toEqual([
      { name: "unit", command: "bun test", required: true },
      { name: "endpoint", command: "bun test test/api", required: true },
    ])
    expect(plan.missingRequired).toEqual(["e2e"])
  })

  test("falls back to legacy command when structured methods are absent", () => {
    const plan = TestConfigWorkflow.getValidationPlan({
      commands: { test: "bun test" },
    })

    expect(plan.mode).toBe("legacy")
    expect(plan.runnable).toEqual([{ name: "default", command: "bun test", required: true }])
    expect(plan.missingRequired).toEqual([])
  })

  test("returns none when no runnable commands are available", () => {
    const plan = TestConfigWorkflow.getValidationPlan({
      test_methods: {
        unit: { required: false },
      },
    })

    expect(plan.mode).toBe("none")
    expect(plan.runnable).toEqual([])
    expect(plan.missingRequired).toEqual([])
  })
})
