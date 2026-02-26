import { spawn } from "child_process"
import { Log } from "../util/log"

export namespace ClaudeCli {
  const log = Log.create({ service: "claude-cli" })

  const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

  export interface InvokeOptions {
    onProgress?: (info: { totalChars: number; elapsedMs: number; lastChunkAgoMs: number }) => void
    progressIntervalMs?: number
  }

  function extractTextFromEvent(event: any): string[] {
    // Handle: {"type":"assistant","message":{"content":[...]}}
    const content =
      event.type === "assistant"
        ? event.message?.content
        : // Handle: {"type":"message","role":"assistant","content":[...]}
          event.type === "message" && event.role === "assistant"
          ? event.content
          : null
    if (!Array.isArray(content)) return []
    return content.flatMap((part: any) => (part.type === "text" && part.text ? [part.text as string] : []))
  }

  export async function invokeClaude(prompt: string, cwd: string, options?: InvokeOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      log.info("invoking claude CLI", { cwd, promptLength: prompt.length })

      const env = { ...process.env }
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRYPOINT

      // Use stream-json so we capture text from every assistant turn, not just the last.
      // With the default "text" format, --print only emits the final message, which is
      // often a brief "here's what I did" summary while the real analysis lived in earlier
      // tool-interleaved turns.
      const child = spawn(
        "claude",
        [
          "--print",
          "--output-format",
          "stream-json",
          "--model",
          "opus",
          "--permission-mode",
          "plan",
          "--no-session-persistence",
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        },
      )

      const textParts: string[] = []
      let resultFallback = "" // .result field from the final "result" event
      let stderr = ""
      let lineBuffer = ""
      let totalChars = 0
      let lastChunkTime = Date.now()
      const startTime = Date.now()

      // Progress reporting
      const progressInterval =
        options?.onProgress && options?.progressIntervalMs
          ? setInterval(() => {
              options.onProgress!({
                totalChars,
                elapsedMs: Date.now() - startTime,
                lastChunkAgoMs: Date.now() - lastChunkTime,
              })
            }, options.progressIntervalMs)
          : null

      function processLine(line: string) {
        if (!line.trim()) return
        try {
          const event = JSON.parse(line)
          const texts = extractTextFromEvent(event)
          for (const t of texts) {
            textParts.push(t)
            totalChars += t.length
          }
          // Keep the result field as a fallback in case no assistant events were emitted
          if (event.type === "result" && typeof event.result === "string") {
            resultFallback = event.result
          }
        } catch {
          // Not a JSON line — ignore
        }
      }

      child.stdout.on("data", (data: Buffer) => {
        lineBuffer += data.toString()
        lastChunkTime = Date.now()
        const lines = lineBuffer.split("\n")
        lineBuffer = lines.pop() ?? ""
        for (const line of lines) processLine(line)
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

        // Flush any partial line remaining in the buffer
        if (lineBuffer.trim()) processLine(lineBuffer)

        if (code !== 0) {
          log.error("claude CLI exited with non-zero code", { code, stderr: stderr.slice(0, 500) })
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
          return
        }

        const result = textParts.length > 0 ? textParts.join("\n\n") : resultFallback
        log.info("claude CLI completed", { responseLength: result.length, turns: textParts.length })
        resolve(result)
      })

      // Pipe prompt via stdin to avoid shell escaping issues
      child.stdin.write(prompt)
      child.stdin.end()
    })
  }
}
