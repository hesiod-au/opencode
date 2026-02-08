// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})

const home = os.homedir()
const authSource = path.join(
  process.env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"),
  "opencode",
  "auth.json",
)
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

const dataHome = path.join(dir, "share")
const cacheHome = path.join(dir, "cache")
const configHome = path.join(dir, "config")
const stateHome = path.join(dir, "state")

process.env["XDG_DATA_HOME"] = dataHome
process.env["XDG_CACHE_HOME"] = cacheHome
process.env["XDG_CONFIG_HOME"] = configHome
process.env["XDG_STATE_HOME"] = stateHome
process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")

const authDir = path.join(dataHome, "opencode")
await fs.mkdir(authDir, { recursive: true })
if (fsSync.existsSync(authSource)) {
  const authTarget = path.join(authDir, "auth.json")
  await fs.copyFile(authSource, authTarget)
  await fs.chmod(authTarget, 0o600)
}

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(cacheHome, "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
