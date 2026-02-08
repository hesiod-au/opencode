# E2E Testing Guide with agent-browser

## Overview

This guide documents lessons learned and best practices for end-to-end testing web applications using `agent-browser` from Vercel Labs.

## Requirements

### agent-browser Version

```bash
npm install -g agent-browser@0.6.0
```

**Critical**: The `screenshot` command is broken in versions 0.7.x with error:
```
Validation error: selector: Expected string, received null
```

Use version 0.6.0 until this is fixed upstream.

## Core Concepts

### Sessions

agent-browser uses named sessions to maintain browser state:

```bash
agent-browser --session my-test open http://localhost:8080
agent-browser --session my-test click @e1
agent-browser --session my-test close
```

Each test should use a unique session name to avoid state bleeding between tests.

### Element References

agent-browser assigns refs (`@e1`, `@e2`, etc.) to interactive elements. Use `snapshot -i` to see only interactive elements:

```bash
agent-browser --session test snapshot -i
# Output:
# - button [ref=e1]
# - button "Submit" [ref=e2]
# - textbox [ref=e3]
```

**Warning**: Refs are assigned dynamically and can change between snapshots if the page updates. Always get a fresh snapshot before clicking.

### Snapshot Types

| Command | Output |
|---------|--------|
| `snapshot` | Full accessibility tree with all elements |
| `snapshot -i` | Interactive elements only (buttons, inputs, links) |
| `snapshot -c` | Compact format |

## Common Pitfalls

### 1. Dynamic Element Refs

**Problem**: Element refs change when page content updates (e.g., during AI responses, animations, or data loading).

```typescript
// BAD: Ref may be stale
const snapshot = await ctx.run("snapshot -i")
// ... time passes, page updates ...
await ctx.run("click @e5")  // May click wrong element or fail
```

**Solution**: Get fresh snapshot immediately before interacting:

```typescript
// GOOD: Fresh snapshot before each interaction
await ctx.run("snapshot -i")  // Updates refs
await ctx.run("click @e5")    // Refs are current
```

### 2. Command String Parsing

**Problem**: Commands with quoted strings or special characters fail when passed through shell.

```typescript
// BAD: Quotes get mangled
await run(`click "[data-component='button']"`, session)
```

**Solution**: Use proper argument arrays with Bun.spawn:

```typescript
// GOOD: Arguments passed correctly
const proc = Bun.spawn(["agent-browser", "--session", session, "click", selector], {
  stdout: "pipe",
  stderr: "pipe",
})
```

### 3. False Positive Assertions

**Problem**: Tests pass when expected content is absent because assertions are too lenient.

```typescript
// BAD: Passes even if task list doesn't exist
const hasTable = snapshot.includes("ID") || snapshot.includes("No task list")
if (hasTable) console.log("PASS")  // Always passes!
```

**Solution**: Strict assertions that fail when expected content is missing:

```typescript
// GOOD: Fails if expected content not found
if (!snapshot.includes("Task ID") || !snapshot.includes("Status")) {
  throw new Error("Task table not found")
}
```

### 4. Testing in Production Directories

**Problem**: Tests create real sessions/files in the project being tested, causing pollution and potentially triggering real actions.

**Solution**:
- Create a temporary directory for each test
- Navigate to the temp directory before testing
- Clean up after tests complete

```typescript
const tempDir = `/tmp/e2e-test-${Date.now()}`
await fs.mkdir(tempDir)
// Navigate browser to temp project
// ... run tests ...
await fs.rm(tempDir, { recursive: true })
```

### 5. Dialogs Intercepting Clicks

**Problem**: Clicking a button opens an unexpected dialog, and subsequent clicks hit dialog elements instead of intended targets.

```typescript
// Clicked button e3, but Snippets dialog opened
// Now e3 refers to dialog's dismiss button, not the original target
```

**Solution**: Check for dialogs and close them before continuing:

```typescript
async function closeDialogs(ctx) {
  const snapshot = await ctx.run("snapshot")
  if (snapshot.includes("dialog")) {
    await ctx.run("press Escape")
    await Bun.sleep(300)
  }
}
```

### 6. Timing and Race Conditions

**Problem**: Elements not ready when test tries to interact.

**Solution**: Wait for specific content, not arbitrary timeouts:

```typescript
// BAD: Arbitrary sleep
await Bun.sleep(5000)

// GOOD: Wait for specific content
async function waitForText(ctx, text, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const snapshot = await ctx.run("snapshot")
    if (snapshot.includes(text)) return
    await Bun.sleep(500)
  }
  throw new Error(`Timeout waiting for: ${text}`)
}
```

## Screenshot Policy

### During Test Development

1. **Always capture screenshots** when a test passes for the first time
2. **Visually inspect** the screenshot to confirm the test validated the correct behavior
3. **Fix false positives** before considering the test complete - a passing test with wrong screenshot is worse than a failing test

### After Initial Validation

- Screenshots are captured automatically on each run
- Manual review only needed when fixing regressions
- Store baseline screenshots for visual regression testing (future improvement)

### Screenshot Location

Screenshots are saved to `/tmp/e2e-screenshots/` by default. Include:
- Test name in filename for traceability
- Timestamp or test index for ordering
- Sanitize filenames (remove special characters)

```typescript
const safeName = testName.replace(/[^a-zA-Z0-9-_]/g, "-")
const path = `/tmp/e2e-screenshots/${safeName}.png`
```

## Test Structure Template

```typescript
import { test } from "./runner"

test("Feature X displays correctly", async (ctx) => {
  // 1. Setup - navigate to starting point
  await ctx.run(`open ${ctx.baseUrl}`)
  await Bun.sleep(1000)

  // 2. Navigate to feature
  await closeDialogs(ctx)
  let snapshot = await ctx.run("snapshot -i")
  // Find and click the element that leads to Feature X

  // 3. Strict assertion - fail if expected content missing
  snapshot = await ctx.run("snapshot")
  if (!snapshot.includes("Expected Feature X Content")) {
    throw new Error("Feature X not displayed correctly")
  }

  // 4. Screenshot captured automatically on pass
  console.log("    Feature X verified")
})
```

## Debugging Tips

### View Full Snapshot
```bash
agent-browser --session test snapshot
```

### View Interactive Elements Only
```bash
agent-browser --session test snapshot -i
```

### Get HTML of Specific Element
```bash
agent-browser --session test get html "body"
```

### Check Element Visibility
```bash
agent-browser --session test is visible "#my-element"
```

### List Active Sessions
```bash
agent-browser session list
```

### Close All Sessions
```bash
agent-browser session list | xargs -I {} agent-browser --session {} close
```

## Known agent-browser Issues (v0.7.x)

| Issue | Version | Status |
|-------|---------|--------|
| `screenshot` command fails with "selector: Expected string, received null" | 0.7.x | Use 0.6.0 |

## Checklist for New Tests

- [ ] Unique session name per test
- [ ] Fresh snapshot before each click
- [ ] Dialogs closed before navigation
- [ ] Strict assertions (fail when expected content missing)
- [ ] Screenshot captured on pass
- [ ] Screenshot visually inspected during development
- [ ] Temp directory used (not production project)
- [ ] Cleanup in finally block
- [ ] Meaningful error messages on failure
