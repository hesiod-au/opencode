#!/usr/bin/env bun
/**
 * E2E Test Runner using agent-browser
 *
 * This runner executes browser-based E2E tests against the OpenCode web app.
 * It manages server lifecycle and provides utilities for test execution.
 *
 * Requirements:
 * - agent-browser 0.6.0 (screenshot is broken in 0.7.x)
 *   Install with: npm install -g agent-browser@0.6.0
 */

import { $ } from "bun"
import { mkdir, rm, writeFile } from "fs/promises"
import { existsSync } from "fs"

interface TestResult {
  name: string
  passed: boolean
  error?: string
  duration: number
}

interface TestContext {
  baseUrl: string
  session: string
  tempProject: string
  run: (cmd: string) => Promise<string>
  screenshot: (name: string) => Promise<void>
  waitForSelector: (selector: string, timeout?: number) => Promise<void>
  waitForText: (text: string, timeout?: number) => Promise<void>
}

// Temp project directory base
const TEMP_PROJECT_BASE = "/tmp/opencode-e2e"

// Create a temp project directory with git init
async function createTempProject(testIndex: number): Promise<string> {
  const tempDir = `${TEMP_PROJECT_BASE}-${testIndex}-${Date.now()}`
  await mkdir(tempDir, { recursive: true })

  // Initialize git repo so opencode recognizes it as a project
  const gitInit = Bun.spawn(["git", "init"], {
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  await gitInit.exited

  // Create a minimal file so the project isn't empty
  await writeFile(`${tempDir}/README.md`, "# E2E Test Project\n\nThis is a temporary project for E2E testing.\n")

  // Add and commit the file
  const gitAdd = Bun.spawn(["git", "add", "."], { cwd: tempDir, stdout: "pipe", stderr: "pipe" })
  await gitAdd.exited

  const gitCommit = Bun.spawn(["git", "commit", "-m", "Initial commit"], {
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "E2E Test",
      GIT_AUTHOR_EMAIL: "e2e@test.local",
      GIT_COMMITTER_NAME: "E2E Test",
      GIT_COMMITTER_EMAIL: "e2e@test.local",
    },
  })
  await gitCommit.exited

  return tempDir
}

// Clean up temp project
async function cleanupTempProject(tempDir: string) {
  try {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true })
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Clean up all old temp projects
async function cleanupOldTempProjects() {
  try {
    const glob = new Bun.Glob(`${TEMP_PROJECT_BASE}-*`)
    for await (const path of glob.scan({ cwd: "/tmp", absolute: true })) {
      try {
        await rm(path, { recursive: true, force: true })
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }
}

type TestFn = (ctx: TestContext) => Promise<void>

interface Test {
  name: string
  fn: TestFn
}

const tests: Test[] = []
const results: TestResult[] = []

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn })
}

// Parse command string into arguments, respecting quotes
function parseCommand(cmd: string): string[] {
  const args: string[] = []
  let current = ""
  let inQuote: string | null = null

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      inQuote = char
    } else if (char === " ") {
      if (current) {
        args.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }

  if (current) {
    args.push(current)
  }

  return args
}

async function run(cmd: string, session: string): Promise<string> {
  // Use Bun.spawn for more control over command execution
  const cmdArgs = parseCommand(cmd)
  const args = ["--session", session, ...cmdArgs]

  const proc = Bun.spawn(["agent-browser", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const output = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: agent-browser ${args.join(" ")}\n${stderr || output}`)
  }

  return output.trim()
}

async function createTestContext(session: string, testIndex: number): Promise<TestContext> {
  const baseUrl = process.env.E2E_BASE_URL || "http://localhost:8888"

  // Create temp project for this test
  const tempProject = await createTempProject(testIndex)

  return {
    baseUrl,
    session,
    tempProject,
    run: (cmd: string) => run(cmd, session),
    screenshot: async (name: string) => {
      const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-")
      const path = `/tmp/e2e-screenshots/${safeName}.png`
      const proc = Bun.spawn(["agent-browser", "--session", session, "screenshot", path], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode === 0) {
        console.log(`      [Screenshot: ${path}]`)
      }
    },
    waitForSelector: async (selector: string, timeout = 10000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        try {
          const result = await run(`is visible "${selector}"`, session)
          if (result.includes("true")) return
        } catch {
          // Selector not found yet
        }
        await Bun.sleep(500)
      }
      throw new Error(`Timeout waiting for selector: ${selector}`)
    },
    waitForText: async (text: string, timeout = 10000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        try {
          const snapshot = await run("snapshot", session)
          if (snapshot.includes(text)) return
        } catch {
          // Text not found yet
        }
        await Bun.sleep(500)
      }
      throw new Error(`Timeout waiting for text: ${text}`)
    },
  }
}

async function runTests() {
  console.log("\n=== OpenCode E2E Tests ===\n")

  // Clean up old temp projects
  console.log("Cleaning up old temp projects...")
  await cleanupOldTempProjects()

  // Create screenshots directory
  await $`mkdir -p /tmp/e2e-screenshots`.quiet()

  // Import all test files
  const testFiles = await Array.fromAsync(new Bun.Glob("**/*.e2e.ts").scan({ cwd: import.meta.dir, absolute: true }))

  for (const file of testFiles) {
    console.log(`Loading tests from: ${file}`)
    await import(file)
  }

  console.log(`\nFound ${tests.length} tests\n`)

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]
    const session = `e2e-test-${i}-${Date.now()}`
    const ctx = await createTestContext(session, i)

    console.log(`[${i + 1}/${tests.length}] Running: ${test.name}`)
    console.log(`    Temp project: ${ctx.tempProject}`)
    const start = Date.now()

    try {
      await test.fn(ctx)
      const duration = Date.now() - start
      results.push({ name: test.name, passed: true, duration })
      console.log(`  PASS (${duration}ms)`)
      // Take success screenshot as proof
      try {
        await ctx.screenshot(`pass-${i}-${test.name.replace(/[^a-zA-Z0-9]/g, "-")}`)
      } catch {
        // Ignore screenshot errors
      }
    } catch (error) {
      const duration = Date.now() - start
      const errorMsg = error instanceof Error ? error.message : String(error)
      results.push({ name: test.name, passed: false, error: errorMsg, duration })
      console.log(`  FAIL (${duration}ms): ${errorMsg}`)
      // Take failure screenshot
      try {
        await ctx.screenshot(`failure-${i}`)
      } catch {
        // Ignore screenshot errors
      }
    } finally {
      // Clean up browser session
      try {
        await run("close", session)
      } catch {
        // Ignore close errors
      }
      // Clean up temp project
      try {
        await cleanupTempProject(ctx.tempProject)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // Print summary
  console.log("\n=== Test Results ===\n")
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length

  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL"
    console.log(`  [${status}] ${result.name} (${result.duration}ms)`)
    if (result.error) {
      console.log(`         Error: ${result.error}`)
    }
  }

  console.log(`\nTotal: ${tests.length} | Passed: ${passed} | Failed: ${failed}\n`)

  return failed === 0
}

// Run if executed directly
if (import.meta.main) {
  const success = await runTests()
  process.exit(success ? 0 : 1)
}
