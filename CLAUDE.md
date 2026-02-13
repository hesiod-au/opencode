# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OpenCode** is an open-source AI coding agent: terminal-first, provider-agnostic. TypeScript monorepo using Bun + Turbo, with SolidJS for all UI (TUI, web, desktop).

## Commands

```bash
bun install                              # Install dependencies
bun dev                                  # Run CLI/TUI (against packages/opencode dir)
bun dev <directory>                      # Run TUI against a specific directory
bun dev .                                # Run TUI in repo root
bun dev serve                            # Start headless API server (port 4096)
bun dev serve --port 8080                # Custom port
bun dev web                              # Start server + web UI
bun run --cwd packages/app dev           # Web UI only (needs server running)
bun dev:desktop                          # Native desktop app (requires Tauri/Rust)
bun typecheck                            # Turbo typecheck across all packages
```

**Tests** (run from specific packages, NOT from root):
```bash
bun test --cwd packages/opencode                         # Core tests
bun run --cwd packages/app test:unit                      # App unit tests (HappyDOM)
bun run --cwd packages/app test:e2e                       # App E2E (Playwright)
```

**Build**:
```bash
./packages/opencode/script/build.ts --single              # Standalone executable
./script/generate.ts                                       # Regenerate SDK after API changes
```

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| `packages/opencode` | Core: CLI, server (Hono), agent logic, tools, providers, sessions |
| `packages/app` | SolidJS web frontend (Vite, Kobalte, Tailwind) |
| `packages/desktop` | Tauri native desktop app wrapping the web UI |
| `packages/ui` | Shared SolidJS component library (used by app + desktop) |
| `packages/sdk/js` | Published JavaScript SDK for programmatic access |
| `packages/plugin` | Plugin SDK and tool definitions (@opencode-ai/plugin) |
| `packages/util` | Shared utilities |
| `packages/web` | Marketing/docs site (Astro + Starlight) |
| `packages/enterprise` | Enterprise deployment features |
| `packages/slack` | Slack bot integration |

## Core Architecture (`packages/opencode/src/`)

### Provider System (`provider/`)
Unified AI provider abstraction using `ai-sdk`. 18+ bundled providers (Anthropic, OpenAI, Google, Azure, Bedrock, Groq, Mistral, etc.). Provider auth via config or environment variables. Custom transforms in `provider/transform.ts`.

### Session System (`session/`)
Sessions are conversation threads with messages. Key files:
- `session/index.ts` — Core session CRUD and state
- `session/system.ts` — System prompt building
- `session/llm.ts` — LLM interaction
- `session/compaction.ts` — Context window optimization via message compaction
- `session/prompt/` — Prompt templates as `.txt` files

### Agent System (`agent/`)
Multiple agents with different permission levels. Defined in `agent/agent.ts` using Zod schemas. Each agent has configurable permissions, model, temperature, topP. Default agents: "build" (full access), "plan" (read-only). Subagent support via "general" agent. Agent-specific prompts in `agent/prompt/`.

### Tool System (`tool/`)
Built-in tools: bash, edit, read, write, glob, grep, webfetch, websearch, task, skill, multiedit, apply_patch, batch, codesearch, lsp, ls, todo, plan, question. Tool registry in `tool/registry.ts`. Permission checks enforced on execution. Output truncation in `tool/truncation.ts`. Extensible via plugins.

### Server (`server/`)
Hono HTTP server with API routes for sessions, config, providers, files, permissions, MCP, PTY, projects. Event streaming for real-time updates. mDNS discovery for local network.

### Other Key Directories
- `config/` — Multi-source config loading (env, file, workspace `opencode.json`)
- `permission/` — Glob-based permission rules engine (`permission/next.ts`)
- `mcp/` — Model Context Protocol server management + OAuth
- `lsp/` — Language Server Protocol client with built-in servers
- `storage/` — SQLite-based session persistence
- `project/` — Workspace management, Git/VCS operations
- `plugin/` — Plugin loading and management
- `skill/` — Skill system for domain knowledge
- `cli/cmd/tui/` — Terminal UI built with SolidJS + [OpenTUI](https://github.com/sst/opentui)

## Web App Architecture (`packages/app/src/`)

SolidJS (NOT React) with `@solidjs/router` for routing. Global state via context providers in `src/context/` (Server, Settings, Terminal, Prompt, File, Models, Command, Language, Permission, Layout). Communicates with backend via WebSocket + REST using `@opencode-ai/sdk`. Styled with Tailwind CSS + Kobalte components.

## Code Standards

- **TypeScript strict mode**, no `any` types
- **Prettier**: no semicolons, 120 char width (config in root `package.json`)
- **No ESLint** — Prettier only
- **Bun** for package management and runtime (version 1.3.8)
- **File length**: max 300 lines, refactor if approaching
- **Default branch**: `dev`
- Pre-push hook runs `bun typecheck`

## Style Guide

- Keep logic in one function unless reusable/composable
- Avoid `try`/`catch` — prefer `.catch()`
- Avoid `else` — use early returns
- Prefer `const` over `let` — use ternaries
- Avoid unnecessary destructuring — use dot notation
- Prefer single-word variable names
- Use Bun APIs (`Bun.file()`, etc.)
- Rely on type inference — avoid explicit annotations unless needed for exports
- Prefer functional array methods (`flatMap`, `filter`, `map`) over `for` loops
- Drizzle schemas: `snake_case` field names (no string column name args)
- Inline values used only once — reduce variable count

## Testing

- Avoid mocks — test actual implementations
- Tests are contracts — NEVER modify tests to make them pass
- Write tests FIRST, then implementation

## PR/Commit Conventions

Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
Optional scope: `feat(app):`, `fix(desktop):`, `chore(opencode):`

## Key Notes

- After changing API/server code, run `./script/generate.ts` to regenerate SDK
- To regenerate the JS SDK alone: `./packages/sdk/js/script/build.ts`
- `bun dev` is the local equivalent of the built `opencode` command
- Local `main` ref may not exist — use `dev` or `origin/dev` for diffs
