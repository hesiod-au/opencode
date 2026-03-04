import { Log } from "../util/log"
import { Session } from "../session"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { WorkflowStore } from "../workflow/store"
import type { TestFix } from "./types"

export namespace TestFixReport {
  const log = Log.create({ service: "test-fix-report" })

  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return `${minutes}m ${remaining}s`
  }

  async function resolveModel(): Promise<{ providerID: string; modelID: string }> {
    const agent = await Agent.get("build")
    return agent?.model ?? { providerID: "openai", modelID: "gpt-5.2-codex" }
  }

  export async function create(
    parentSessionId: string,
    report: TestFix.Report,
    runId?: string,
  ): Promise<string | undefined> {
    try {
      const reportSession = await Session.create({
        parentID: parentSessionId,
        title: "Test Fix Report",
      })
      if (runId) {
        await WorkflowStore.linkSession({
          runId,
          sessionId: reportSession.id,
          role: "report",
          parentSessionId,
        })
      }

      const model = await resolveModel()
      const now = Date.now()

      // Build report content
      const totalFiles = report.groups.flatMap((g) => g.files)
      const passing = totalFiles.filter((f) => f.status === "passing").length
      const failing = totalFiles.filter((f) => f.status === "failing").length
      const erroring = totalFiles.filter((f) => f.status === "erroring").length
      const invalid = totalFiles.filter((f) => f.status === "invalid").length

      const invalidSection =
        report.invalidTests.length > 0
          ? `## Invalid Tests

The following tests appear to be testing incorrect behavior:

${report.invalidTests.map((t) => `- \`${t.file}\`: ${t.reason ?? "Unknown reason"}`).join("\n")}

`
          : ""

      const reportContent = `# Test Fix Report

## Summary

- **All Passing:** ${report.allPassing ? "Yes" : "No"}
- **Total Files Processed:** ${totalFiles.length}
- **Passing:** ${passing}
- **Failing:** ${failing}
- **Erroring:** ${erroring}
- **Invalid:** ${invalid}

${invalidSection}## Statistics

- **Duration:** ${formatDuration(report.stats.duration)}
- **Input Tokens:** ${report.stats.inputTokens.toLocaleString()}
- **Output Tokens:** ${report.stats.outputTokens.toLocaleString()}
- **Cost:** $${report.stats.cost.toFixed(4)}
- **Files Modified:** ${report.stats.modifiedFiles.length}

## Group Details

${report.groups.map((g) => formatGroupDetail(g)).join("\n---\n\n")}

## Modified Files

${
  report.stats.modifiedFiles.length > 0
    ? report.stats.modifiedFiles.map((f) => `- \`${f}\``).join("\n")
    : "No files modified"
}
`

      // Synthetic user message
      const userMsgID = Identifier.ascending("message")
      await Session.updateMessage({
        id: userMsgID,
        sessionID: reportSession.id,
        role: "user",
        time: { created: now },
        agent: "build",
        model,
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: reportSession.id,
        messageID: userMsgID,
        type: "text",
        text: "Generate test fix report",
        synthetic: true,
      })

      // Assistant message with report
      const asstMsgID = Identifier.ascending("message")
      await Session.updateMessage({
        id: asstMsgID,
        sessionID: reportSession.id,
        role: "assistant",
        parentID: userMsgID,
        time: { created: now, completed: now },
        agent: "build",
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "default",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: reportSession.id,
        messageID: asstMsgID,
        type: "text",
        text: reportContent,
      })

      // Summary in parent session
      const summaryText =
        `## Test Fix Complete\n\n` +
        `**${passing}/${totalFiles.length} tests passing**` +
        ` · ${formatDuration(report.stats.duration)}\n\n` +
        `**Cost:** $${report.stats.cost.toFixed(4)}` +
        ` · **Tokens:** ${(report.stats.inputTokens + report.stats.outputTokens).toLocaleString()}` +
        (report.invalidTests.length > 0
          ? `\n\n**${report.invalidTests.length} invalid test(s)** flagged for review`
          : "")

      const parentUserMsgID = Identifier.ascending("message")
      await Session.updateMessage({
        id: parentUserMsgID,
        sessionID: parentSessionId,
        role: "user",
        time: { created: now },
        agent: "build",
        model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: parentSessionId,
        messageID: parentUserMsgID,
        type: "text",
        text: "Test Fix completed",
        synthetic: true,
      })

      const parentAsstMsgID = Identifier.ascending("message")
      await Session.updateMessage({
        id: parentAsstMsgID,
        sessionID: parentSessionId,
        role: "assistant",
        parentID: parentUserMsgID,
        time: { created: now, completed: now },
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "default",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: parentSessionId,
        messageID: parentAsstMsgID,
        type: "text",
        text: summaryText,
      })

      // Per-group tool parts
      for (const group of report.groups) {
        const groupSummary = formatGroupDetail(group)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: parentSessionId,
          messageID: parentAsstMsgID,
          type: "tool",
          callID: Identifier.ascending("tool"),
          tool: "test-fix-report",
          state: {
            status: "completed",
            input: { type: group.type, fileCount: group.files.length },
            output: groupSummary,
            title: `${group.type} tests`,
            metadata: {},
            time: { start: now, end: now },
          },
        })
      }

      log.info("report created", { sessionId: reportSession.id })
      return reportSession.id
    } catch (err) {
      log.error("failed to create report", { error: err })
      return undefined
    }
  }

  function formatGroupDetail(group: TestFix.GroupResult): string {
    const passing = group.files.filter((f) => f.status === "passing").length
    const failing = group.files.filter((f) => f.status === "failing").length
    const erroring = group.files.filter((f) => f.status === "erroring").length
    const invalid = group.files.filter((f) => f.status === "invalid").length

    let detail = `### ${group.type.charAt(0).toUpperCase() + group.type.slice(1)} Tests

- **Files:** ${group.files.length}
- **Passing:** ${passing}
- **Failing:** ${failing}
- **Erroring:** ${erroring}
- **Invalid:** ${invalid}
- **Regression Cycles:** ${group.regressionCycles}
- **Suite Passed:** ${group.suitePassedAfterFixes ? "Yes" : "No"}
`

    if (group.error) {
      detail += `\n**Error:** ${group.error}\n`
    }

    if (group.files.length > 0) {
      detail += `\n| File | Status | Retries |\n|------|--------|---------|`
      for (const f of group.files) {
        const statusIcon =
          f.status === "passing"
            ? "Pass"
            : f.status === "failing"
              ? "Fail"
              : f.status === "erroring"
                ? "Error"
                : "Invalid"
        detail += `\n| \`${f.file}\` | ${statusIcon} | ${f.retries} |`
      }
    }

    return detail
  }
}
