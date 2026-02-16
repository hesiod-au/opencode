import { spawn } from "child_process"
import { Log } from "../util/log"

export namespace ClaudeCli {
  const log = Log.create({ service: "claude-cli" })

  const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

  export interface InvokeOptions {
    onProgress?: (info: { totalChars: number; elapsedMs: number; lastChunkAgoMs: number }) => void
    progressIntervalMs?: number
  }

  export async function invokeClaude(prompt: string, cwd: string, options?: InvokeOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      log.info("invoking claude CLI", { cwd, promptLength: prompt.length })

      const env = { ...process.env }
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRYPOINT

      const child = spawn("claude", ["--print", "--model", "opus", "--permission-mode", "plan", "--no-session-persistence"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      })

      let stdout = ""
      let stderr = ""
      let lastChunkTime = Date.now()
      const startTime = Date.now()

      // Progress reporting
      const progressInterval =
        options?.onProgress && options?.progressIntervalMs
          ? setInterval(() => {
              options.onProgress!({
                totalChars: stdout.length,
                elapsedMs: Date.now() - startTime,
                lastChunkAgoMs: Date.now() - lastChunkTime,
              })
            }, options.progressIntervalMs)
          : null

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString()
        lastChunkTime = Date.now()
      })

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString()
        lastChunkTime = Date.now()
      })

      const cleanup = () => {
        if (progressInterval) clearInterval(progressInterval)
      }

      const timer = setTimeout(() => {
        log.warn("claude CLI timed out, killing process")
        child.kill("SIGKILL")
        cleanup()
        reject(new Error(`Claude CLI timed out after ${TIMEOUT_MS / 1000}s`))
      }, TIMEOUT_MS)

      child.on("error", (err) => {
        clearTimeout(timer)
        cleanup()
        log.error("claude CLI spawn error", { error: err })
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        cleanup()
        if (code !== 0) {
          log.error("claude CLI exited with non-zero code", { code, stderr: stderr.slice(0, 500) })
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
          return
        }
        log.info("claude CLI completed", { responseLength: stdout.length })
        resolve(stdout)
      })

      // Pipe prompt via stdin to avoid shell escaping issues
      child.stdin.write(prompt)
      child.stdin.end()
    })
  }
}
