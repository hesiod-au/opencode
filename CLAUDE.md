# CLAUDE.md

## Project Context

- **Project**: OpenCode
- **Description**: Open source AI coding agent - terminal-first, provider-agnostic
- **Primary Stack**: TypeScript monorepo (Bun, Turbo), SolidJS frontend
- **Repo**: https://github.com/anomalyco/opencode

### Monorepo Structure

```
packages/
├── opencode/     # Main CLI application
├── console/      # Web console
├── desktop/      # Desktop app
├── web/          # Marketing site
├── sdk/          # JavaScript SDK
├── plugin/       # Plugin system
├── ui/           # Shared UI components (SolidJS)
├── docs/         # Documentation
└── ...
```

---

## Core Rules

### Code Standards

- **TypeScript**: Strict mode, no `any` types
- **Formatting**: Prettier (no semicolons, 120 char width)
- **Package manager**: Bun (`bun install`, `bun run`)
- **Build**: Turbo (`bun turbo typecheck`)
- **File length**: Maximum 300 lines (refactor if approaching limit)
- **Default branch**: `master` (not main)

### Common Commands

```bash
bun install                    # Install dependencies
bun run dev                    # Run dev server (main opencode package)
bun turbo typecheck            # Typecheck all packages
```

### Commit Messages

Short, informative messages. Examples:
- `Add user authentication endpoint`
- `Fix pagination off-by-one error`
- `Refactor order service into separate modules`

### Test-Driven Development (Mandatory)

1. **Tests are contracts** - They define expected behavior
2. **Write tests FIRST** - Before any implementation
3. **NEVER modify tests to make them pass** - Fix the implementation instead
4. **If a test seems wrong** - Stop and ask before changing it

---

## Workflow

When given a feature or task:

### 1. Clarify & Spec
- Ask questions if there's genuine ambiguity
- Generate a spec document for confirmation
- Wait for approval before proceeding

### 2. Plan
- Break the feature into discrete items
- Create a todo list tracking each item

### 3. Implement (for each item)

```typescript
function implementItem(item: Item) {
    writeTests(item)
    writeImplementation(item)

    while (!testsPass()) {
        fixImplementation()
    }

    while (!lintClean()) {
        fixLintIssues()
    }

    markComplete(item)
}
```

### 4. Complete
- Summarize what was implemented
- List any follow-up items or known limitations

---

## CLI Tools

Custom CLI tools are available. Use `--help` on the tool and subcommands to discover usage.

| Tool | Purpose | Discovery |
|------|---------|-----------|
| `aws-read` | Read AWS environment/resources | `aws-read --help` |
| `confluence-cli` | Read from Confluence | `confluence-cli --help` |
| `ncli` | Read/write Notion | `ncli --help` |

---

## Sub-agents

Use these agents for isolated task execution:

| Agent | When to Use |
|-------|-------------|
| `spec-writer` | Generate feature specifications from requirements |
| `test-writer` | Write tests for a specific feature or function |
| `implementer` | Write code to make tests pass |
| `test-runner` | Run tests and fix failures (loop until green) |
| `precommit-runner` | Run pre-commit and fix issues (loop until clean) |

---

## Skills

Domain knowledge loaded automatically when relevant:

| Skill | Provides |
|-------|----------|
| `react-standards` | React/TypeScript/SolidJS conventions |
| `tdd-policy` | Test-driven development rules and examples |
| `precommit-setup` | Pre-commit configuration (creates if missing) |

---

## Asking Questions

**Do ask** when:
- Requirements are ambiguous
- Multiple valid approaches exist
- A test seems incorrect
- Unsure about architectural decisions

**Don't ask** when:
- The path forward is clear
- It's a minor implementation detail
- You can make a reasonable assumption and note it

---

## Project-Specific Notes

- Uses **SolidJS** (not React) for UI components - similar API but different reactivity model
- **Husky** is configured for git hooks
- SST for infrastructure (`sst.config.ts`)
- Check `CONTRIBUTING.md` for contribution guidelines
- Check `STYLE_GUIDE.md` for additional style conventions
