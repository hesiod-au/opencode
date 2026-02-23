import { For, onCleanup, onMount, Show, Match, Switch, createMemo, createEffect, on, type ParentProps } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Dynamic } from "solid-js/web"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore, produce } from "solid-js/store"
import { SessionContextUsage } from "@/components/session-context-usage"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Select } from "@opencode-ai/ui/select"
import { useCodeComponent } from "@opencode-ai/ui/context/code"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { Mark } from "@opencode-ai/ui/logo"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Icon } from "@opencode-ai/ui/icon"

import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { checksum, base64Encode, base64Decode } from "@opencode-ai/util/encode"
import { findLast } from "@opencode-ai/util/array"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useData, DataProvider } from "@opencode-ai/ui/context"
import { DialogSelectFile } from "@/components/dialog-select-file"
import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { showToast } from "@opencode-ai/ui/toast"
import {
  SessionHeader,
  SessionContextTab,
  SessionTasksTab,
  SessionPRReviewTab,
  SortableTab,
  FileVisual,
  SortableTerminalTab,
  NewSessionView,
  LoadedSnapshotProvider,
  useLoadedSnapshot,
  CanonicalContextProvider,
  useCanonicalContextMaybe,
} from "@/components/session"
import { usePlatform } from "@/context/platform"
import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import { createOpenReviewFile, focusTerminalById, getTabReorderIndex } from "@/pages/session/helpers"
import { createScrollSpy } from "@/pages/session/scroll-spy"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  SessionReviewTab,
  StickyAddButton,
  type DiffStyle,
  type SessionReviewTabProps,
} from "@/pages/session/review-tab"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { SessionPromptDock } from "@/pages/session/session-prompt-dock"
import { SessionMobileTabs } from "@/pages/session/session-mobile-tabs"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
}

const HANDOFF_MAX = 40

const handoff = {
  session: new Map<string, HandoffSession>(),
  terminal: new Map<string, string[]>(),
}

const touch = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > HANDOFF_MAX) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}

const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = handoff.session.get(key) ?? { prompt: "", files: {} }
  touch(handoff.session, key, { ...prev, ...patch })
}

// Provides snapshot-merged data to child components when a snapshot is loaded
function SnapshotDataProvider(props: ParentProps) {
  const parentData = useData()
  const loadedSnapshotCtx = useLoadedSnapshot()
  const params = useParams()

  // Create a merged data object that uses snapshot data when loaded
  const mergedData = createMemo(() => {
    const snapshot = loadedSnapshotCtx.snapshot()
    const sessionID = params.id

    if (!snapshot || !sessionID) {
      return parentData.store
    }

    // When a snapshot is loaded, show snapshot data in the UI
    // (before submission, user sees the snapshot they loaded)
    return {
      ...parentData.store,
      message: {
        ...parentData.store.message,
        [sessionID]: snapshot.messages,
      },
      part: {
        ...parentData.store.part,
        ...snapshot.parts,
      },
    }
  })

  return (
    <DataProvider
      data={mergedData()}
      directory={parentData.directory}
      onPermissionRespond={parentData.respondToPermission}
      onQuestionReply={parentData.replyToQuestion}
      onQuestionReject={parentData.rejectQuestion}
      onNavigateToSession={parentData.navigateToSession}
    >
      {props.children}
    </DataProvider>
  )
}

function CanonicalContextWrapper(props: ParentProps) {
  const params = useParams()
  const sdk = useSDK()

  // Use Show with keyed to force remount when session ID changes
  // This ensures each session gets its own isolated canonical context store
  return (
    <Show when={params.id} keyed fallback={props.children}>
      {(sessionId) => (
        <CanonicalContextProvider workspaceDir={sdk.directory} sessionId={sessionId}>
          {props.children}
        </CanonicalContextProvider>
      )}
    </Show>
  )
}

export default function Page() {
  return (
    <LoadedSnapshotProvider>
      <CanonicalContextWrapper>
        <SnapshotDataProvider>
          <PageContent />
        </SnapshotDataProvider>
      </CanonicalContextWrapper>
    </LoadedSnapshotProvider>
  )
}

function PageContent() {
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const terminal = useTerminal()
  const dialog = useDialog()
  const codeComponent = useCodeComponent()
  const command = useCommand()
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const prompt = usePrompt()
  const comments = useComments()
  const permission = usePermission()
  const loadedSnapshotCtx = useLoadedSnapshot()
  const canonicalCtx = useCanonicalContextMaybe()

  // Clear snapshot when switching sessions
  createEffect(
    on(
      () => params.id,
      (_currentId, prevId) => {
        // Clear snapshot when navigating to a different session
        if (prevId !== undefined) {
          loadedSnapshotCtx.clear()
        }
      },
    ),
  )

  const permRequest = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    return sync.data.permission[sessionID]?.[0]
  })

  const questionRequest = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    return sync.data.question[sessionID]?.[0]
  })

  const blocked = createMemo(() => !!permRequest() || !!questionRequest())

  const [ui, setUi] = createStore({
    responding: false,
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    autoCreated: false,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  createEffect(
    on(
      () => permRequest()?.id,
      () => setUi("responding", false),
      { defer: true },
    ),
  )

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permRequest()
    if (!perm) return
    if (ui.responding) return

    setUi("responding", true)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setUi("responding", false))
  }

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  if (import.meta.env.DEV) {
    createEffect(
      on(
        () => [params.dir, params.id] as const,
        ([dir, id], prev) => {
          if (!id) return
          navParams({ dir, from: prev?.[1], to: id })
        },
      ),
    )

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!prompt.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:prompt-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!terminal.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:terminal-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!file.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:file-view-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (sync.data.message[id] === undefined) return
      navMark({ dir: params.dir, to: id, name: "session:data-ready" })
    })
  }

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopReviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopSidePanelOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)

    const path = file.pathFromTab(next)
    if (!path) return
    file.load(path)
    openReviewPanel()
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  createEffect(() => {
    const current = tabs().all()
    if (current.length === 0) return

    const next = normalizeTabs(current)
    if (same(current, next)) return

    tabs().setAll(next)

    const active = tabs().active()
    if (!active) return
    if (!active.startsWith("file://")) return

    const normalized = normalizeTab(active)
    if (active === normalized) return
    tabs().setActive(normalized)
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  // Use snapshot messages when loaded, otherwise use live data
  // Merge excluded content from canonical context (for display after cloning)
  const messages = createMemo(() => {
    const snapshot = loadedSnapshotCtx.snapshot()
    if (snapshot) return snapshot.messages

    const serverMessages = params.id ? (sync.data.message[params.id] ?? []) : []

    // Merge excluded messages from canonical context
    const excluded = canonicalCtx?.getExcludedContent()
    if (!excluded || Object.keys(excluded.messages).length === 0) {
      return serverMessages
    }

    // Build a set of server message IDs
    const serverMsgIds = new Set(serverMessages.map((m) => m.id))

    // Add excluded messages that aren't on server
    const excludedMsgs = Object.values(excluded.messages).filter((m) => !serverMsgIds.has(m.id))
    if (excludedMsgs.length === 0) {
      return serverMessages
    }

    // Merge and sort by ID (ascending order preserves chronological order)
    const merged = [...serverMessages, ...excludedMsgs]
    merged.sort((a, b) => (a.id > b.id ? 1 : -1))
    return merged
  })
  const messagesReady = createMemo(() => {
    // If a snapshot is loaded, messages are always ready
    if (loadedSnapshotCtx.isLoaded()) return true
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () => setTitle({ draft: "", editing: false, saving: false, menuOpen: false, pendingRename: false }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!params.id) return
    setTitle({ editing: true, draft: info()?.title ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const saveTitleEditor = async () => {
    const sessionID = params.id
    if (!sessionID) return
    if (title.saving) return

    const next = title.draft.trim()
    if (!next || next === (info()?.title ?? "")) {
      setTitle({ editing: false, saving: false })
      return
    }

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID, title: next })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session[index].title = next
          }),
        )
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  async function archiveSession(sessionID: string) {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )

        if (params.id !== sessionID) return
        if (session.parentID) {
          navigate(`/${params.dir}/session/${session.parentID}`)
          return
        }
        if (nextSession) {
          navigate(`/${params.dir}/session/${nextSession.id}`)
          return
        }
        navigate(`/${params.dir}/session`)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  async function deleteSession(sessionID: string) {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    if (params.id !== sessionID) return true
    if (session.parentID) {
      navigate(`/${params.dir}/session/${session.parentID}`)
      return true
    }
    if (nextSession) {
      navigate(`/${params.dir}/session/${nextSession.id}`)
      return true
    }
    navigate(`/${params.dir}/session`)
    return true
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const title = createMemo(() => sync.session.get(props.sessionID)?.title ?? language.t("command.session.new"))
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: title() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const emptyUserMessages: UserMessage[] = []
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
      },
    ),
  )

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    turnStart: 0,
    mobileTab: "session" as "session" | "changes",
    changes: "session" as "session" | "turn",
    newSessionWorktree: "main",
    promptHeight: 0,
  })

  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])
  const reviewDiffs = createMemo(() => (store.changes === "session" ? diffs() : turnDiffs()))

  const renderedUserMessages = createMemo(
    () => {
      const msgs = visibleUserMessages()
      const start = store.turnStart
      if (start <= 0) return msgs
      if (start >= msgs.length) return emptyUserMessages
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sync.data.path.directory !== project.worktree) return sync.data.path.directory
    return "main"
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  const setActiveMessage = (message: UserMessage | undefined) => {
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = activeMessage()
    const currentIndex = current ? msgs.findIndex((m) => m.id === current.id) : -1
    const targetIndex = currentIndex === -1 ? (offset > 0 ? 0 : msgs.length - 1) : currentIndex + offset
    if (targetIndex < 0 || targetIndex >= msgs.length) return

    if (targetIndex === msgs.length - 1) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })
  const emptyDiffFiles: string[] = []
  const diffFiles = createMemo(() => diffs().map((d) => d.file), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const idle = { type: "idle" as const }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(() => {
    sdk.directory
    const id = params.id
    if (!id) return
    sync.session.sync(id)
  })

  createEffect(() => {
    if (!view().terminal.opened()) {
      setUi("autoCreated", false)
      return
    }
    if (!terminal.ready() || terminal.all().length !== 0 || ui.autoCreated) return
    terminal.new()
    setUi("autoCreated", true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount !== undefined && prevCount > 0 && count === 0) {
          if (view().terminal.opened()) {
            view().terminal.toggle()
          }
        }
      },
    ),
  )

  createEffect(
    on(
      () => terminal.active(),
      (activeId) => {
        if (!activeId || !view().terminal.opened()) return
        // Immediately remove focus
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        focusTerminalById(activeId)
      },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
        setStore("changes", "session")
        setUi("autoCreated", false)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const id = lastUserMessage()?.id
    if (!id) return
    setStore("expanded", id, status().type !== "idle")
  })

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const activeElement = document.activeElement as HTMLElement | undefined
    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(activeElement.tagName) || activeElement.isContentEditable
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Don't autofocus chat if terminal panel is open
    if (view().terminal.opened()) return

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (blocked()) return
      inputRef?.focus()
    }
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const currentTabs = tabs().all()
      const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
      if (toIndex === undefined) return
      tabs().move(draggable.id.toString(), toIndex)
    }
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeTerminalDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const terminals = terminal.all()
      const fromIndex = terminals.findIndex((t: LocalPTY) => t.id === draggable.id.toString())
      const toIndex = terminals.findIndex((t: LocalPTY) => t.id === droppable.id.toString())
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        terminal.move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeTerminalDraggable", undefined)
    const activeId = terminal.active()
    if (!activeId) return
    setTimeout(() => {
      focusTerminalById(activeId)
    }, 0)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const tasksOpen = createMemo(() => tabs().active() === "tasks" || tabs().all().includes("tasks"))
  const prReviewOpen = createMemo(() => tabs().active() === "pr-review" || tabs().all().includes("pr-review"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context" && tab !== "tasks" && tab !== "pr-review" && tab !== "review"),
  )

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const reviewTab = createMemo(() => isDesktop() && (!layout.fileTree.opened() || hasReview()))

  const showTabs = createMemo(
    () =>
      view().reviewPanel.opened() &&
      (hasReview() || tabs().all().length > 0 || contextOpen() || tasksOpen() || prReviewOpen()),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({ reviewScroll: undefined, pendingDiff: undefined, activeDiff: undefined })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    command,
    dialog,
    file,
    language,
    local,
    permission,
    prompt,
    sdk,
    sync,
    terminal,
    layout,
    params,
    navigate,
    tabs,
    view,
    info,
    status,
    userMessages,
    visibleUserMessages,
    activeMessage,
    showAllFiles,
    navigateMessageByOffset,
    setExpanded: (id, fn) => setStore("expanded", id, fn),
    setActiveMessage,
    addSelectionToContext,
    focusInput,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    loadFile: file.load,
  })

  const changesOptions = ["session", "turn"] as const
  const changesOptionsList = [...changesOptions]

  const changesTitle = () => (
    <Select
      options={changesOptionsList}
      current={store.changes}
      label={(option) =>
        option === "session" ? language.t("ui.sessionReview.title") : language.t("ui.sessionReview.title.lastTurn")
      }
      onSelect={(option) => option && setStore("changes", option)}
      variant="ghost"
      size="large"
      triggerStyle={{ "font-size": "var(--font-size-large)" }}
    />
  )

  const emptyTurn = () => (
    <div class="h-full pb-30 flex flex-col items-center justify-center text-center gap-6">
      <Mark class="w-14 opacity-10" />
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Switch>
      <Match when={store.changes === "turn" && !!params.id}>
        <SessionReviewTab
          title={changesTitle()}
          empty={emptyTurn()}
          diffs={reviewDiffs}
          view={view}
          diffStyle={input.diffStyle}
          onDiffStyleChange={input.onDiffStyleChange}
          onScrollRef={(el) => setTree("reviewScroll", el)}
          focusedFile={tree.activeDiff}
          onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
          comments={comments.all()}
          focusedComment={comments.focus()}
          onFocusedCommentChange={comments.setFocus}
          onViewFile={openReviewFile}
          classes={input.classes}
        />
      </Match>
      <Match when={hasReview()}>
        <Show
          when={diffsReady()}
          fallback={<div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>}
        >
          <SessionReviewTab
            title={changesTitle()}
            diffs={reviewDiffs}
            view={view}
            diffStyle={input.diffStyle}
            onDiffStyleChange={input.onDiffStyleChange}
            onScrollRef={(el) => setTree("reviewScroll", el)}
            focusedFile={tree.activeDiff}
            onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
            comments={comments.all()}
            focusedComment={comments.focus()}
            onFocusedCommentChange={comments.setFocus}
            onViewFile={openReviewFile}
            classes={input.classes}
          />
        </Show>
      </Match>
      <Match when={true}>
        <div class={input.emptyClass}>
          <Mark class="w-14 opacity-10" />
          <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.empty")}</div>
        </div>
      </Match>
    </Switch>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full px-6 pb-30 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      () => tabs().active(),
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        if (!file.pathFromTab(active)) return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    setFileTreeTab(value)
  }

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    const current = view().review.open() ?? []
    if (!current.includes(path)) view().review.setOpen([...current, path])
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active === "tasks") return "tasks"
    if (active === "pr-review") return "pr-review"
    if (active === "review" && reviewTab()) return "review"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (tasksOpen()) return "tasks"
    if (prReviewOpen()) return "pr-review"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen() && !tasksOpen() && !prReviewOpen() && !(reviewTab() && hasReview())) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(
    on(
      () => layout.fileTree.opened(),
      (opened, prev) => {
        if (prev === undefined) return
        if (!isDesktop()) return

        if (opened) {
          const active = tabs().active()
          const tab = active === "review" || (!active && hasReview()) ? "changes" : "all"
          layout.fileTree.setTab(tab)
          return
        }

        if (fileTreeTab() !== "changes") return
        tabs().setActive("review")
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (fileTreeTab() !== "all") return

    const active = tabs().active()
    if (active && active !== "review") return

    const first = openedTabs()[0]
    if (first) {
      tabs().setActive(first)
      return
    }

    if (contextOpen()) tabs().setActive("context")
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    const wants = isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes"
    if (!wants) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  const scrollSpy = createScrollSpy({
    onActive: (id) => {
      if (id === store.messageId) return
      setStore("messageId", id)
    },
  })

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const overflow = max > 1
    const bottom = !overflow || el.scrollTop >= max - 2

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) return
    setUi("scroll", { overflow, bottom })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        scrollSpy.clear()
      },
      { defer: true },
    ),
  )

  const anchor = (id: string) => `message-${id}`

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    scrollSpy.setContainer(el)
    if (el) scheduleScrollState(el)
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      scrollSpy.markDirty()
    },
  )

  const turnInit = 20
  const turnBatch = 20
  let turnHandle: number | undefined
  let turnIdle = false

  function cancelTurnBackfill() {
    const handle = turnHandle
    if (handle === undefined) return
    turnHandle = undefined

    if (turnIdle && window.cancelIdleCallback) {
      window.cancelIdleCallback(handle)
      return
    }

    clearTimeout(handle)
  }

  function scheduleTurnBackfill() {
    if (turnHandle !== undefined) return
    if (store.turnStart <= 0) return

    if (window.requestIdleCallback) {
      turnIdle = true
      turnHandle = window.requestIdleCallback(() => {
        turnHandle = undefined
        backfillTurns()
      })
      return
    }

    turnIdle = false
    turnHandle = window.setTimeout(() => {
      turnHandle = undefined
      backfillTurns()
    }, 0)
  }

  function backfillTurns() {
    const start = store.turnStart
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    const el = scroller
    if (!el) {
      setStore("turnStart", nextStart)
      scheduleTurnBackfill()
      return
    }

    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight

    setStore("turnStart", nextStart)

    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })

    scheduleTurnBackfill()
  }

  createEffect(
    on(
      () => [params.id, messagesReady()] as const,
      ([id, ready]) => {
        cancelTurnBackfill()
        setStore("turnStart", 0)
        if (!id || !ready) return

        const len = visibleUserMessages().length
        const start = len > turnInit ? len - turnInit : 0
        setStore("turnStart", start)
        scheduleTurnBackfill()
      },
      { defer: true },
    ),
  )

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === store.promptHeight) return

      const el = scroller
      const stick = el ? el.scrollHeight - el.clientHeight - el.scrollTop < 10 : false

      setStore("promptHeight", next)

      if (stick && el) {
        requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: "auto" })
        })
      }

      if (el) scheduleScrollState(el)
      scrollSpy.markDirty()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    turnStart: () => store.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: (value) => setStore("turnStart", value),
    scheduleTurnBackfill,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPrompt() })
  })

  createEffect(() => {
    if (!terminal.ready()) return
    language.locale()

    touch(
      handoff.terminal,
      params.dir!,
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  createEffect(() => {
    if (!file.ready()) return
    setSessionHandoff(sessionKey(), {
      files: Object.fromEntries(
        tabs()
          .all()
          .flatMap((tab) => {
            const path = file.pathFromTab(tab)
            if (!path) return []
            return [[path, file.selectedLines(path) ?? null] as const]
          }),
      ),
    })
  })

  onCleanup(() => {
    cancelTurnBackfill()
    document.removeEventListener("keydown", handleKeyDown)
    scrollSpy.destroy()
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <SessionMobileTabs
          open={!isDesktop() && !!params.id}
          hasReview={hasReview()}
          reviewCount={reviewCount()}
          onSession={() => setStore("mobileTab", "session")}
          onChanges={() => setStore("mobileTab", "changes")}
          t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
        />

        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            "flex-1 pt-2 md:pt-3": true,
            "md:flex-none": desktopSidePanelOpen(),
          }}
          style={{
            width: sessionPanelWidth(),
            "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show when={activeMessage()}>
                  <MessageTimeline
                    mobileChanges={mobileChanges()}
                    mobileFallback={reviewContent({
                      diffStyle: "unified",
                      classes: {
                        root: "pb-[calc(var(--prompt-height,8rem)+32px)]",
                        header: "px-4",
                        container: "px-4",
                      },
                      loadingClass: "px-4 py-4 text-text-weak",
                      emptyClass: "h-full px-4 pb-30 flex flex-col items-center justify-center text-center gap-6",
                    })}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    isDesktop={isDesktop()}
                    onScrollSpyScroll={scrollSpy.onScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    showHeader={!!(info()?.title || info()?.parentID)}
                    centered={centered()}
                    title={info()?.title}
                    parentID={info()?.parentID}
                    openTitleEditor={openTitleEditor}
                    closeTitleEditor={closeTitleEditor}
                    saveTitleEditor={saveTitleEditor}
                    titleRef={(el) => {
                      titleRef = el
                    }}
                    titleState={title}
                    onTitleDraft={(value) => setTitle("draft", value)}
                    onTitleMenuOpen={(open) => setTitle("menuOpen", open)}
                    onTitlePendingRename={(value) => setTitle("pendingRename", value)}
                    onNavigateParent={() => {
                      navigate(`/${params.dir}/session/${info()?.parentID}`)
                    }}
                    sessionID={params.id!}
                    onArchiveSession={(sessionID) => void archiveSession(sessionID)}
                    onDeleteSession={(sessionID) => dialog.show(() => <DialogDeleteSession sessionID={sessionID} />)}
                    t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    turnStart={store.turnStart}
                    onRenderEarlier={() => setStore("turnStart", 0)}
                    historyMore={historyMore()}
                    historyLoading={historyLoading()}
                    onLoadEarlier={() => {
                      const id = params.id
                      if (!id) return
                      setStore("turnStart", 0)
                      sync.session.history.loadMore(id)
                    }}
                    renderedUserMessages={renderedUserMessages()}
                    anchor={anchor}
                    onRegisterMessage={scrollSpy.register}
                    onUnregisterMessage={scrollSpy.unregister}
                    onFirstTurnMount={() => {
                      const id = params.id
                      if (!id) return
                      navMark({ dir: params.dir, to: id, name: "session:first-turn-mounted" })
                    }}
                    lastUserMessageID={lastUserMessage()?.id}
                    expanded={store.expanded}
                    onToggleExpanded={(id) => setStore("expanded", id, (open: boolean | undefined) => !open)}
                  />
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView
                  worktree={newSessionWorktree()}
                  onWorktreeChange={(value) => {
                    if (value === "create") {
                      setStore("newSessionWorktree", value)
                      return
                    }

                    setStore("newSessionWorktree", "main")

                    const target = value === "main" ? sync.project?.worktree : value
                    if (!target) return
                    if (target === sync.data.path.directory) return
                    layout.projects.open(target)
                    navigate(`/${base64Encode(target)}/session`)
                  }}
                />
              </Match>
            </Switch>
          </div>

          <SessionPromptDock
            centered={centered()}
            questionRequest={questionRequest}
            permissionRequest={permRequest}
            blocked={blocked()}
            promptReady={prompt.ready()}
            handoffPrompt={handoff.session.get(sessionKey())?.prompt}
            t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
            responding={ui.responding}
            onDecide={decide}
            inputRef={(el) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
            setPromptDockRef={(el) => (promptDock = el)}
          />

          <Show when={desktopReviewOpen()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.session.width()}
              min={450}
              max={window.innerWidth * 0.45}
              onResize={layout.session.resize}
            />
          </Show>
        </div>

        {/* Desktop tabs panel (Review + Context + Files) - hidden on mobile */}
        <Show when={isDesktop() && showTabs()}>
          <div class="relative flex-1 min-w-0 h-full border-l border-border-weak-base">
            <DragDropProvider
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragYAxis />
              <Tabs value={activeTab()} onChange={openTab}>
                <div class="sticky top-0 shrink-0 flex">
                  <Tabs.List>
                    <Show when={reviewTab()}>
                      <Tabs.Trigger value="review">
                        <div class="flex items-center gap-3">
                          <Show when={diffs()}>
                            <DiffChanges changes={diffs()} variant="bars" />
                          </Show>
                          <div class="flex items-center gap-1.5">
                            <div>Review</div>
                            <Show when={info()?.summary?.files}>
                              <div class="text-12-medium text-text-strong h-4 px-2 flex flex-col items-center justify-center rounded-full bg-surface-base">
                                {info()?.summary?.files ?? 0}
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <Show when={contextOpen()}>
                      <Tabs.Trigger
                        value="context"
                        closeButton={
                          <Tooltip value="Close tab" placement="bottom">
                            <IconButton icon="close" variant="ghost" onClick={() => tabs().close("context")} />
                          </Tooltip>
                        }
                        hideCloseButton
                        onMiddleClick={() => tabs().close("context")}
                      >
                        <div class="flex items-center gap-2">
                          <SessionContextUsage variant="indicator" />
                          <div>Context</div>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <Show when={tasksOpen()}>
                      <Tabs.Trigger
                        value="tasks"
                        closeButton={
                          <Tooltip value="Close tab" placement="bottom">
                            <IconButton icon="close" variant="ghost" onClick={() => tabs().close("tasks")} />
                          </Tooltip>
                        }
                        hideCloseButton
                        onMiddleClick={() => tabs().close("tasks")}
                      >
                        <div class="flex items-center gap-2">
                          <Icon name="checklist" size="small" />
                          <div>Tasks</div>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <Show when={prReviewOpen()}>
                      <Tabs.Trigger
                        value="pr-review"
                        closeButton={
                          <Tooltip value="Close tab" placement="bottom">
                            <IconButton icon="close" variant="ghost" onClick={() => tabs().close("pr-review")} />
                          </Tooltip>
                        }
                        hideCloseButton
                        onMiddleClick={() => tabs().close("pr-review")}
                      >
                        <div class="flex items-center gap-2">
                          <Icon name="branch" size="small" />
                          <div>PR Review</div>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <SortableProvider ids={openedTabs()}>
                      <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                    </SortableProvider>
                    <div class="bg-background-base h-full flex items-center justify-center border-b border-border-weak-base px-3">
                      <TooltipKeybind
                        title="Open file"
                        keybind={command.keybind("file.open")}
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          onClick={() => dialog.show(() => <DialogSelectFile />)}
                        />
                      </TooltipKeybind>
                    </div>
                  </Tabs.List>
                </div>
                <Show when={reviewTab()}>
                  <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "review"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <Show
                          when={diffsReady()}
                          fallback={<div class="px-6 py-4 text-text-weak">Loading changes...</div>}
                        >
                          <SessionReviewTab
                            diffs={diffs}
                            view={view}
                            diffStyle={layout.review.diffStyle()}
                            onDiffStyleChange={layout.review.setDiffStyle}
                            onViewFile={(path) => {
                              const value = file.tab(path)
                              tabs().open(value)
                              file.load(path)
                            }}
                          />
                        </Show>
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>
                <Show when={contextOpen()}>
                  <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "context"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <SessionContextTab
                          messages={messages}
                          visibleUserMessages={visibleUserMessages}
                          view={view}
                          info={info}
                        />
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>
                <Show when={tasksOpen()}>
                  <Tabs.Content value="tasks" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "tasks"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <SessionTasksTab />
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>
                <Show when={prReviewOpen()}>
                  <Tabs.Content value="pr-review" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "pr-review"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <SessionPRReviewTab />
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>
                <For each={openedTabs()}>
                  {(tab) => {
                    let scroll: HTMLDivElement | undefined
                    let scrollFrame: number | undefined
                    let pending: { x: number; y: number } | undefined

                    const path = createMemo(() => file.pathFromTab(tab))
                    const state = createMemo(() => {
                      const p = path()
                      if (!p) return
                      return file.get(p)
                    })
                    const contents = createMemo(() => state()?.content?.content ?? "")
                    const cacheKey = createMemo(() => checksum(contents()))
                    const isImage = createMemo(() => {
                      const c = state()?.content
                      return (
                        c?.encoding === "base64" && c?.mimeType?.startsWith("image/") && c?.mimeType !== "image/svg+xml"
                      )
                    })
                    const isSvg = createMemo(() => {
                      const c = state()?.content
                      return c?.mimeType === "image/svg+xml"
                    })
                    const svgContent = createMemo(() => {
                      if (!isSvg()) return
                      const c = state()?.content
                      if (!c) return
                      if (c.encoding === "base64") return base64Decode(c.content)
                      return c.content
                    })
                    const svgPreviewUrl = createMemo(() => {
                      if (!isSvg()) return
                      const c = state()?.content
                      if (!c) return
                      if (c.encoding === "base64") return `data:image/svg+xml;base64,${c.content}`
                      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.content)}`
                    })
                    const imageDataUrl = createMemo(() => {
                      if (!isImage()) return
                      const c = state()?.content
                      return `data:${c?.mimeType};base64,${c?.content}`
                    })
                    const selectedLines = createMemo(() => {
                      const p = path()
                      if (!p) return null
                      if (file.ready()) return file.selectedLines(p) ?? null
                      return handoff.session.get(sessionKey())?.files[p] ?? null
                    })
                    const selection = createMemo(() => {
                      const range = selectedLines()
                      if (!range) return
                      return selectionFromLines(range)
                    })
                    const selectionLabel = createMemo(() => {
                      const sel = selection()
                      if (!sel) return
                      if (sel.startLine === sel.endLine) return `L${sel.startLine}`
                      return `L${sel.startLine}-${sel.endLine}`
                    })

                    const restoreScroll = (retries = 0) => {
                      const el = scroll
                      if (!el) return

                      const s = view()?.scroll(tab)
                      if (!s) return

                      // Wait for content to be scrollable - content may not have rendered yet
                      if (el.scrollHeight <= el.clientHeight && retries < 10) {
                        requestAnimationFrame(() => restoreScroll(retries + 1))
                        return
                      }

                      if (el.scrollTop !== s.y) el.scrollTop = s.y
                      if (el.scrollLeft !== s.x) el.scrollLeft = s.x
                    }

                    const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
                      pending = {
                        x: event.currentTarget.scrollLeft,
                        y: event.currentTarget.scrollTop,
                      }
                      if (scrollFrame !== undefined) return

                      scrollFrame = requestAnimationFrame(() => {
                        scrollFrame = undefined

                        const next = pending
                        pending = undefined
                        if (!next) return

                        view().setScroll(tab, next)
                      })
                    }

                    createEffect(
                      on(
                        () => state()?.loaded,
                        (loaded) => {
                          if (!loaded) return
                          requestAnimationFrame(restoreScroll)
                        },
                        { defer: true },
                      ),
                    )

                    createEffect(
                      on(
                        () => file.ready(),
                        (ready) => {
                          if (!ready) return
                          requestAnimationFrame(restoreScroll)
                        },
                        { defer: true },
                      ),
                    )

                    createEffect(
                      on(
                        () => tabs().active() === tab,
                        (active) => {
                          if (!active) return
                          if (!state()?.loaded) return
                          requestAnimationFrame(restoreScroll)
                        },
                      ),
                    )

                    onCleanup(() => {
                      if (scrollFrame === undefined) return
                      cancelAnimationFrame(scrollFrame)
                    })

                    return (
                      <Tabs.Content
                        value={tab}
                        class="mt-3"
                        ref={(el: HTMLDivElement) => {
                          scroll = el
                          restoreScroll()
                        }}
                        onScroll={handleScroll}
                      >
                        <Show when={activeTab() === tab}>
                          <Show when={selection()}>
                            {(sel) => (
                              <div class="hidden sticky top-0 z-10 px-6 py-2 _flex justify-end bg-background-base border-b border-border-weak-base">
                                <button
                                  type="button"
                                  class="flex items-center gap-2 px-2 py-1 rounded-md bg-surface-base border border-border-base text-12-regular text-text-strong hover:bg-surface-raised-base-hover"
                                  onClick={() => {
                                    const p = path()
                                    if (!p) return
                                    prompt.context.add({ type: "file", path: p, selection: sel() })
                                  }}
                                >
                                  <Icon name="plus-small" size="small" />
                                  <span>Add {selectionLabel()} to context</span>
                                </button>
                              </div>
                            )}
                          </Show>
                          <Switch>
                            <Match when={state()?.loaded && isImage()}>
                              <div class="px-6 py-4 pb-40">
                                <img src={imageDataUrl()} alt={path()} class="max-w-full" />
                              </div>
                            </Match>
                            <Match when={state()?.loaded && isSvg()}>
                              <div class="flex flex-col gap-4 px-6 py-4">
                                <Dynamic
                                  component={codeComponent}
                                  file={{
                                    name: path() ?? "",
                                    contents: svgContent() ?? "",
                                    cacheKey: cacheKey(),
                                  }}
                                  enableLineSelection
                                  selectedLines={selectedLines()}
                                  onLineSelected={(range: SelectedLineRange | null) => {
                                    const p = path()
                                    if (!p) return
                                    file.setSelectedLines(p, range)
                                  }}
                                  overflow="scroll"
                                  class="select-text"
                                />
                                <Show when={svgPreviewUrl()}>
                                  <div class="flex justify-center pb-40">
                                    <img src={svgPreviewUrl()} alt={path()} class="max-w-full max-h-96" />
                                  </div>
                                </Show>
                              </div>
                            </Match>
                            <Match when={state()?.loaded}>
                              <Dynamic
                                component={codeComponent}
                                file={{
                                  name: path() ?? "",
                                  contents: contents(),
                                  cacheKey: cacheKey(),
                                }}
                                enableLineSelection
                                selectedLines={selectedLines()}
                                onLineSelected={(range: SelectedLineRange | null) => {
                                  const p = path()
                                  if (!p) return
                                  file.setSelectedLines(p, range)
                                }}
                                overflow="scroll"
                                class="select-text pb-40"
                              />
                            </Match>
                            <Match when={state()?.loading}>
                              <div class="px-6 py-4 text-text-weak">Loading...</div>
                            </Match>
                            <Match when={state()?.error}>
                              {(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}
                            </Match>
                          </Switch>
                        </Show>
                      </Tabs.Content>
                    )
                  }}
                </For>
              </Tabs>
              <DragOverlay>
                <Show when={store.activeDraggable}>
                  {(tab) => {
                    const path = createMemo(() => file.pathFromTab(tab()))
                    return (
                      <div class="relative px-6 h-12 flex items-center bg-background-stronger border-x border-border-weak-base border-b border-b-transparent">
                        <Show when={path()}>{(p) => <FileVisual active path={p()} />}</Show>
                      </div>
                    )
                  }}
                </Show>
              </DragOverlay>
            </DragDropProvider>
          </div>
        </Show>
      </div>

      <TerminalPanel
        open={isDesktop() && view().terminal.opened()}
        height={layout.terminal.height()}
        resize={layout.terminal.resize}
        close={view().terminal.close}
        terminal={terminal}
        language={language}
        command={command}
        handoff={() => handoff.terminal.get(params.dir!) ?? []}
        activeTerminalDraggable={() => store.activeTerminalDraggable}
        handleTerminalDragStart={handleTerminalDragStart}
        handleTerminalDragOver={handleTerminalDragOver}
        handleTerminalDragEnd={handleTerminalDragEnd}
        onCloseTab={() => setUi("autoCreated", false)}
      />
    </div>
  )
}
