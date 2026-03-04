# Workflow Configuration Guide

OpenCode includes automated workflows for task orchestration, PR reviews, and test setup.

## Available Workflows

- **Task Mode** - Multi-agent orchestration for complex tasks
- **PR Review** - Automated PR feedback loop
- **Test Config** - Test configuration analysis and validation

## Task Mode Configuration

Configure in `opencode.json`:

```json
{
  "taskMode": {
    "enabled": true,
    "listPath": ".opencode/tasks/default/task_list.md",
    "requirePlanConfirmation": true,
    "maxConcurrentTasks": 3,
    "agentLaunchStaggerSeconds": 5,
    "pollIntervalMs": 1000,
    "tddMode": true,
    "maxTestRetries": 10,
    "taskPromptGuardrails": "Use TypeScript strict mode. Follow project conventions."
  }
}
```

### Options

| Option                      | Default                                | Description                       |
| --------------------------- | -------------------------------------- | --------------------------------- |
| `enabled`                   | true                                   | Enable task mode                  |
| `listPath`                  | `.opencode/tasks/default/task_list.md` | Task list file path               |
| `requirePlanConfirmation`   | false                                  | Require approval before execution |
| `maxConcurrentTasks`        | 3                                      | Max parallel task agents          |
| `agentLaunchStaggerSeconds` | 5                                      | Delay between agent launches      |
| `pollIntervalMs`            | 1000                                   | Task list polling interval        |
| `tddMode`                   | false                                  | Enable test-driven development    |
| `maxTestRetries`            | 10                                     | Max test fix attempts per task    |
| `taskPromptGuardrails`      | -                                      | Extra instructions for all tasks  |

### How Task Mode Works

1. **Planning** - Analyzes request, generates task list
2. **Test Writing** (if TDD) - Generates tests for each task
3. **Execution** - Launches task agents in parallel; dependencies are optional and only used when tasks share files or rely on outputs/research/changes from another task
4. **E2E Testing** (if TDD) - Runs end-to-end tests
5. **Completion** - Generates final report

### Starting Task Mode

**Tool invocation:**

```
Implement user authentication using task mode
```

**UI:** Navigate to Task Mode tab, click "Start"

**CLI:**

```bash
opencode workflow start task-mode
```

## PR Review Configuration

```json
{
  "prReview": {
    "enabled": true,
    "prNumber": 123,
    "pollIntervalMinutes": 10,
    "maxCycles": 20,
    "maxRecheckAttempts": 5,
    "testCommand": "bun test",
    "reviewRequestComment": "@reviewer please review"
  }
}
```

### Options

| Option                 | Default         | Description                     |
| ---------------------- | --------------- | ------------------------------- |
| `enabled`              | true            | Enable PR review                |
| `prNumber`             | auto-detect     | PR number to review             |
| `pollIntervalMinutes`  | 10              | Minutes between comment checks  |
| `maxCycles`            | 20              | Max review/fix cycles           |
| `maxRecheckAttempts`   | 5               | Max checks when no new comments |
| `testCommand`          | auto-detect     | Test command to run             |
| `reviewRequestComment` | `@codex review` | Comment after each cycle        |

### How PR Review Works

1. **Fetch** - Get review comments since last commit
2. **Assess** - AI triages comments (fix vs ignore)
3. **Fix** - Runs fix agent per actionable comment
4. **Test** - Runs tests, fixes failures
5. **Commit & Push** - Pushes changes
6. **Request Review** - Posts comment
7. **Wait** - Polls for new comments (orange animation)
8. **Repeat** - Until no comments or max cycles

### Auto-Detection

**PR Number:** Uses `gh pr view --json number` if not configured

**Test Command:** Detects based on project:

- Python → `pytest`
- Go → `go test ./...`
- Bun → `bun test`
- Node → `npm test`
- Make → `make test`

### Starting PR Review

**Tool invocation:**

```
Address the PR review feedback
```

**UI:** Navigate to PR Review tab, click "Start"

**CLI:**

```bash
opencode workflow start pr-review
```

## Session Hierarchy

All workflows create session trees:

### Orchestrator Session

- **Tool-invoked**: Uses calling session as orchestrator
- **UI-started**: Creates "Orchestrator: {Workflow Name}" session

The orchestrator:

- Parents all child sessions
- Aggregates child status
- Receives progress updates
- Shows working (blue) animation when children are busy
- Shows waiting (orange) animation when children are waiting

### Child Sessions

**Task Mode creates:**

- Planning session
- Test writing session (TDD mode)
- One session per task agent
- E2E fix session (if needed)
- Final report session

**PR Review creates:**

- Fix session per actionable comment
- Test fix sessions (if tests fail)

All children automatically use orchestrator as parent.

## Session Status & Animations

### Status Types

- **busy** - Actively processing (blue working animation)
- **waiting** - Passively waiting (orange waiting animation)
- **idle** - Completed (no animation)
- **retry** - Retrying after error (blue animation)

### Status Aggregation

Parent sessions aggregate child status:

- Shows **busy** if ANY child is busy/retry
- Shows **waiting** if children waiting and none busy
- Shows **idle** otherwise

This means:

- Task agents running → orchestrator shows working animation
- PR review polling → orchestrator shows waiting animation
- All tasks complete → orchestrator shows no animation

## Complete Example

```json
{
  "$schema": "https://opencode.ai/config.json",

  "model": "anthropic/claude-sonnet-4-5",

  "taskMode": {
    "enabled": true,
    "requirePlanConfirmation": true,
    "maxConcurrentTasks": 4,
    "tddMode": true,
    "taskPromptGuardrails": "Use TypeScript strict mode. Follow Prettier config."
  },

  "prReview": {
    "enabled": true,
    "pollIntervalMinutes": 10,
    "maxCycles": 25,
    "testCommand": "bun test",
    "reviewRequestComment": "🤖 Ready for re-review @team/reviewers"
  },

  "agent": {
    "build": {
      "model": "anthropic/claude-sonnet-4-5",
      "temperature": 0.3
    }
  },

  "permission": {
    "bash": "allow",
    "edit": "allow"
  }
}
```

## Workflow State

State persisted per-project in:

```
~/.claude/projects/{project-hash}/workflow-state/
```

Each workflow run gets unique `runId` tracking:

- Start/completion timestamps
- Current phase
- Parent session ID
- Progress messages
- Stats (tokens, cost, modified files)

## SDK Usage

```typescript
import { OpencodeClient } from "@opencode-ai/sdk"

const client = new OpencodeClient({ baseURL: "http://localhost:4096" })

// Start task mode
await client.workflow.start({
  workflowId: "task-mode",
  parentSessionId: mySessionId, // optional
  userPrompt: "Implement user authentication",
})

// Check status
const status = await client.workflow.getStatus("task-mode")
console.log(status.running) // true
console.log(status.phase) // "executing"
console.log(status.parentSessionId) // orchestrator session ID

// Task mode specific
console.log(status.extra.activeTaskCount)
console.log(status.extra.taskListPath)

// PR review specific
console.log(status.extra.prNumber)
console.log(status.extra.cycleCount)

// Stop workflow
await client.workflow.stop("task-mode")
```

## Troubleshooting

**Task mode won't start**

- Check `taskMode.enabled` is not false
- Verify task list path exists
- Check agent configuration

**PR review not detecting PR**

- Run `gh pr view` to verify GitHub CLI access
- Set `prReview.prNumber` explicitly
- Check `gh auth status`

**Tests failing repeatedly**

- Verify `testCommand` is correct
- Increase `maxTestRetries`
- Review test fix sessions for issues

**Orchestrator not showing progress**

- Check workflow is running (`getStatus()`)
- Verify WebSocket connection
- Refresh UI to reconnect

## Implementation Details

### Backend Files

- `packages/opencode/src/workflow/orchestrator.ts` - Shared orchestrator utilities
- `packages/opencode/src/task-mode/orchestrator.ts` - Task mode orchestration
- `packages/opencode/src/pr-review/pr-review.ts` - PR review workflow
- `packages/opencode/src/workflow/composable.ts` - Composable workflow base
- `packages/opencode/src/session/status.ts` - Session status schema

### Frontend Files

- `packages/app/src/pages/layout/sidebar-items.tsx` - Status aggregation and animation rendering
- `packages/ui/src/components/spinner.tsx` - Working animation (blue)
- `packages/ui/src/components/waiting-spinner.tsx` - Waiting animation (orange)
- `packages/ui/src/styles/animations.css` - Animation keyframes

### Key Patterns

**Orchestrator Initialization:**

```typescript
const orchestratorSessionId = await WorkflowOrchestrator.initializeOrchestrator(
  "Workflow Name",
  options.parentSessionId,
)
```

**Progress Logging:**

```typescript
await WorkflowOrchestrator.logProgress(orchestratorSessionId, "Progress message")
```

**Status Management:**

```typescript
WorkflowOrchestrator.setBusy(orchestratorSessionId) // Start working
WorkflowOrchestrator.setWaiting(orchestratorSessionId) // Start waiting
WorkflowOrchestrator.setIdle(orchestratorSessionId) // Complete
```

**Child Session Creation:**

```typescript
const session = await Session.create({
  parentID: orchestratorSessionId,
  title: "Child Session Title",
})
SessionStatus.set(session.id, { type: "busy" })
// ... do work ...
SessionStatus.set(session.id, { type: "idle" })
```

## Status Aggregation Logic

```typescript
// Frontend aggregation (sidebar-items.tsx)
const aggregatedStatus = createMemo(() => {
  const ownStatus = sessionStore.session_status[sessionId]
  const childStatuses = childIds.map((id) => sessionStore.session_status[id])

  // Any child busy → parent shows busy
  if (childStatuses.some((s) => s.type === "busy" || s.type === "retry")) {
    return { type: "busy" }
  }

  // Some children waiting, none busy → parent shows waiting
  if (childStatuses.some((s) => s.type === "waiting")) {
    return { type: "waiting" }
  }

  return ownStatus
})
```

This ensures proper status bubbling: busy child sessions make the parent busy, which makes the orchestrator busy, providing accurate visual feedback at all levels.
