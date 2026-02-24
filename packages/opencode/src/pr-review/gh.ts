import { Log } from "../util/log"
import { Instance } from "../project/instance"

const log = Log.create({ service: "pr-review-gh" })

export namespace GH {
  interface PRInfo {
    number: number
    title: string
    headRefName: string
    url: string
    state: string
  }

  interface ReviewComment {
    id: number
    body: string
    path?: string
    line?: number
    user: { login: string }
    createdAt: string
    updatedAt: string
  }

  async function exec(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["gh", ...args], {
      cwd: Instance.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
  }

  async function git(args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: Instance.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trim()
  }

  export async function getPRInfo(prNumber?: number): Promise<PRInfo> {
    const args = ["pr", "view", "--json", "number,title,headRefName,url,state"]
    if (prNumber) args.splice(2, 0, String(prNumber))

    const result = await exec(args)
    if (result.exitCode !== 0) {
      throw new Error(`Failed to get PR info: ${result.stderr}`)
    }

    return JSON.parse(result.stdout)
  }

  export async function getCurrentBranchPR(): Promise<number | undefined> {
    const result = await exec(["pr", "view", "--json", "number"])
    if (result.exitCode !== 0) return undefined
    const data = JSON.parse(result.stdout)
    return data.number
  }

  export async function getCommentsSinceCommit(prNumber: number, commitSha: string): Promise<ReviewComment[]> {
    const commitTimestamp = await getCommitTimestamp(commitSha)
    if (!commitTimestamp) {
      log.warn("could not get commit timestamp", { commitSha })
      return []
    }

    // Only fetch review comments (code-level comments with diff_hunk/path).
    // Issue comments (e.g. "@codex review") are not actionable review feedback
    // and should not trigger fix cycles.
    const reviewResult = await exec(["api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`, "--jq", "."])

    const comments: ReviewComment[] = []

    if (reviewResult.exitCode === 0 && reviewResult.stdout) {
      const reviewComments = JSON.parse(reviewResult.stdout) as any[]
      for (const c of reviewComments) {
        if (new Date(c.updated_at) <= new Date(commitTimestamp)) continue
        // Only include comments that reference a specific file with a code snippet
        if (!c.path || !c.diff_hunk) continue
        comments.push({
          id: c.id,
          body: c.body,
          path: c.path,
          line: c.line ?? c.original_line,
          user: { login: c.user.login },
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        })
      }
    }

    log.info("fetched comments since commit", {
      prNumber,
      commitSha,
      commitTimestamp,
      count: comments.length,
    })

    return comments
  }

  export async function postComment(prNumber: number, body: string): Promise<void> {
    const result = await exec(["pr", "comment", String(prNumber), "--body", body])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to post comment: ${result.stderr}`)
    }
  }

  export async function getLastCommitSha(): Promise<string> {
    return git(["rev-parse", "HEAD"])
  }

  export async function getCommitTimestamp(sha: string): Promise<string | undefined> {
    const result = await git(["show", "-s", "--format=%cI", sha])
    return result || undefined
  }

  export async function addAndCommitAndPush(message: string): Promise<string> {
    await git(["add", "-A"])

    // Check if there are changes to commit
    const status = await git(["status", "--porcelain"])
    if (!status) {
      log.info("no changes to commit")
      return await getLastCommitSha()
    }

    await git(["commit", "-m", message])
    await git(["push"])
    return await getLastCommitSha()
  }

  export async function getDiffSummary(): Promise<string> {
    return git(["diff", "HEAD~1", "--stat"])
  }
}
