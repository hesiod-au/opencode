import { createMemo, createSignal, For, Show } from "solid-js"
import { DateTime } from "luxon"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import type {
  Message,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  CompactionPart,
} from "@opencode-ai/sdk/v2/client"
import type { SelectionState } from "./session-context-tab"
import { useLoadedSnapshot } from "./use-loaded-snapshot"
import { useSDK } from "@/context/sdk"

export interface ContextGroupedViewProps {
  messages: () => Message[]
  getParts: (messageId: string) => Part[]
  onJumpToMessage?: (messageId: string) => void
  selection?: SelectionState
  onPartUpdated?: () => void
}

interface GroupItem {
  messageId: string
  partId: string
  title: string
  subtitle?: string
  time: number
  icon: IconProps["name"]
  excluded?: boolean // Backend excluded field from part
}

interface Group {
  key: string
  title: string
  icon: IconProps["name"]
  items: GroupItem[]
}

function formatTime(timestamp: number): string {
  return DateTime.fromMillis(timestamp).toLocaleString(DateTime.TIME_WITH_SECONDS)
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + "..."
}

function getToolIcon(tool: string): IconProps["name"] {
  switch (tool) {
    case "read":
      return "glasses"
    case "list":
      return "bullet-list"
    case "glob":
    case "grep":
      return "magnifying-glass-menu"
    case "webfetch":
    case "websearch":
      return "window-cursor"
    case "task":
      return "task"
    case "bash":
      return "console"
    case "edit":
    case "write":
    case "multiedit":
    case "patch":
      return "code-lines"
    case "todowrite":
    case "todoread":
      return "checklist"
    case "question":
      return "bubble-5"
    default:
      return "mcp"
  }
}

function getToolGroupKey(tool: string): string {
  switch (tool) {
    case "read":
    case "list":
      return "file-read"
    case "glob":
    case "grep":
      return "search"
    case "edit":
    case "write":
    case "multiedit":
    case "patch":
      return "file-write"
    case "bash":
      return "bash"
    case "webfetch":
    case "websearch":
      return "web"
    case "task":
      return "task"
    default:
      return "other-tools"
  }
}

function getToolGroupTitle(key: string): string {
  switch (key) {
    case "file-read":
      return "File Read"
    case "search":
      return "Search"
    case "file-write":
      return "File Write/Edit"
    case "bash":
      return "Shell Commands"
    case "web":
      return "Web Fetch"
    case "task":
      return "Sub-agents"
    default:
      return "Other Tools"
  }
}

function getToolGroupIcon(key: string): IconProps["name"] {
  switch (key) {
    case "file-read":
      return "glasses"
    case "search":
      return "magnifying-glass-menu"
    case "file-write":
      return "code-lines"
    case "bash":
      return "console"
    case "web":
      return "window-cursor"
    case "task":
      return "task"
    default:
      return "mcp"
  }
}

function GroupSection(props: {
  group: Group
  onJumpToMessage?: (messageId: string) => void
  selection?: SelectionState
  onPartUpdated?: () => void
  getPart: (messageId: string, partId: string) => Part | undefined
}) {
  const [open, setOpen] = createSignal(true)
  const sdk = useSDK()

  const handleExcludeToggle = async (item: GroupItem, e: MouseEvent) => {
    e.stopPropagation()
    // If item has backend exclusion, update via API
    if (item.excluded) {
      const part = props.getPart(item.messageId, item.partId)
      if (part) {
        await sdk.client.part.update({
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          part: {
            ...part,
            excluded: false,
          },
        })
        props.onPartUpdated?.()
      }
    } else {
      props.selection?.toggleExcluded(item.partId)
    }
  }

  const handleHideToggle = (partId: string, e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleHidden(partId)
  }

  // Check if an item is excluded (either by backend excluded field or local UI state)
  const isItemExcluded = (item: GroupItem) => item.excluded || (props.selection?.excluded().has(item.partId) ?? false)

  const excludedCount = createMemo(() => {
    return props.group.items.filter((item) => isItemExcluded(item)).length
  })

  // Check if all items in group are excluded
  const isGroupExcluded = createMemo(() => {
    if (props.group.items.length === 0) return false
    return props.group.items.every((item) => isItemExcluded(item))
  })

  // Check if all items in group are hidden
  const isGroupHidden = createMemo(() => {
    if (!props.selection) return false
    if (props.group.items.length === 0) return false
    return props.group.items.every((item) => props.selection!.hidden().has(item.partId))
  })

  const handleGroupExcludeToggle = async (e: MouseEvent) => {
    e.stopPropagation()
    if (props.group.items.length === 0) return

    if (isGroupExcluded()) {
      // Include all items - need to handle both backend and local exclusions
      const backendExcludedItems = props.group.items.filter((item) => item.excluded)
      const localExcludedItems = props.group.items.filter(
        (item) => !item.excluded && props.selection?.excluded().has(item.partId),
      )

      // Update backend excluded items via API
      for (const item of backendExcludedItems) {
        const part = props.getPart(item.messageId, item.partId)
        if (part) {
          await sdk.client.part.update({
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            part: {
              ...part,
              excluded: false,
            },
          })
        }
      }

      // Refresh if we updated any backend exclusions
      if (backendExcludedItems.length > 0) {
        props.onPartUpdated?.()
      }

      // Update local exclusions
      if (localExcludedItems.length > 0 && props.selection) {
        props.selection.setExcluded((prev) => {
          const next = new Set(prev)
          for (const item of localExcludedItems) next.delete(item.partId)
          return next
        })
      }
    } else {
      // Exclude all items (local state only)
      if (props.selection) {
        props.selection.setExcluded((prev) => {
          const next = new Set(prev)
          for (const item of props.group.items) next.add(item.partId)
          return next
        })
      }
    }
  }

  const handleGroupHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    if (!props.selection) return
    if (props.group.items.length === 0) return

    if (isGroupHidden()) {
      // Show all items
      props.selection.setHidden((prev) => {
        const next = new Set(prev)
        for (const item of props.group.items) next.delete(item.partId)
        return next
      })
    } else {
      // Hide all items
      props.selection.setHidden((prev) => {
        const next = new Set(prev)
        for (const item of props.group.items) next.add(item.partId)
        return next
      })
    }
  }

  return (
    <div data-slot="context-group" data-excluded={isGroupExcluded()} data-hidden={isGroupHidden()}>
      <Collapsible open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger>
          <div data-slot="context-group-header">
            <Show when={props.selection && props.group.items.length > 0}>
              <div data-slot="context-group-checkbox" onClick={handleGroupExcludeToggle}>
                <Icon name={isGroupExcluded() ? "dash" : "check"} size="small" />
              </div>
            </Show>
            <div data-slot="context-group-title">
              <Icon name={props.group.icon} size="small" />
              <span>{props.group.title}</span>
            </div>
            <div class="flex items-center gap-2">
              <Show when={excludedCount() > 0}>
                <span data-slot="context-group-excluded">{excludedCount()} excluded</span>
              </Show>
              <span data-slot="context-group-count">{props.group.items.length}</span>
              <Show when={props.selection && props.group.items.length > 0}>
                <button
                  data-slot="context-group-hide"
                  onClick={handleGroupHideToggle}
                  title={isGroupHidden() ? "Show group" : "Hide group"}
                >
                  <Icon name="eye" size="small" />
                </button>
              </Show>
              <Collapsible.Arrow />
            </div>
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="context-group-items">
            <For each={props.group.items}>
              {(item) => {
                // Check both local UI exclusion and backend excluded field
                const isExcluded = () => isItemExcluded(item)
                const isHidden = () => props.selection?.hidden().has(item.partId) ?? false
                return (
                  <div
                    data-slot="context-group-item"
                    data-excluded={isExcluded()}
                    data-hidden={isHidden()}
                    onClick={() => props.onJumpToMessage?.(item.messageId)}
                  >
                    <Show when={props.selection}>
                      <div data-slot="item-checkbox" onClick={(e) => handleExcludeToggle(item, e)}>
                        <Icon name={isExcluded() ? "dash" : "check"} size="small" />
                      </div>
                    </Show>
                    <div data-slot="item-icon">
                      <Icon name={item.icon} size="small" />
                    </div>
                    <div data-slot="item-content">
                      <span data-slot="item-title">{item.title}</span>
                      <Show when={item.subtitle}>
                        <span data-slot="item-meta">{item.subtitle}</span>
                      </Show>
                    </div>
                    <div data-slot="item-meta">{formatTime(item.time)}</div>
                    <Show when={props.selection}>
                      <button
                        data-slot="item-hide"
                        onClick={(e) => handleHideToggle(item.partId, e)}
                        title={isHidden() ? "Unhide" : "Hide"}
                      >
                        <Icon name="eye" size="small" />
                      </button>
                    </Show>
                    <Show when={props.onJumpToMessage}>
                      <div data-slot="item-jump">
                        <Icon name="square-arrow-top-right" size="small" />
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export function ContextGroupedView(props: ContextGroupedViewProps) {
  const loadedSnapshotCtx = useLoadedSnapshot()

  // Helper to get displayed text for a text part (applies edit if available)
  const getDisplayText = (partId: string, originalText: string): string => {
    const edit = loadedSnapshotCtx.getEdit(partId)
    if (edit && edit.type === "text") {
      return edit.content
    }
    return originalText
  }

  const groups = createMemo(() => {
    const userMessages: GroupItem[] = []
    const assistantText: GroupItem[] = []
    const reasoning: GroupItem[] = []
    const toolGroups: Record<string, GroupItem[]> = {}
    const files: GroupItem[] = []
    const compactions: GroupItem[] = []

    for (const message of props.messages()) {
      const parts = props.getParts(message.id)

      for (const part of parts) {
        const baseItem = {
          messageId: message.id,
          partId: part.id,
          time: message.time.created,
          excluded: part.excluded,
        }

        if (part.type === "text") {
          const textPart = part as TextPart
          if (textPart.synthetic || textPart.ignored) continue

          const displayText = getDisplayText(part.id, textPart.text)
          if (message.role === "user") {
            userMessages.push({
              ...baseItem,
              title: truncateText(displayText.trim(), 60),
              icon: "speech-bubble",
            })
          } else {
            assistantText.push({
              ...baseItem,
              title: truncateText(displayText.trim(), 60),
              icon: "code",
            })
          }
        }

        if (part.type === "reasoning") {
          const reasoningPart = part as ReasoningPart
          reasoning.push({
            ...baseItem,
            title: truncateText(reasoningPart.text.trim(), 60),
            icon: "brain",
          })
        }

        if (part.type === "tool") {
          const toolPart = part as ToolPart
          const groupKey = getToolGroupKey(toolPart.tool)
          if (!toolGroups[groupKey]) {
            toolGroups[groupKey] = []
          }
          const title =
            toolPart.state.status === "completed" || toolPart.state.status === "running"
              ? toolPart.state.title || toolPart.tool
              : toolPart.tool
          toolGroups[groupKey].push({
            ...baseItem,
            title,
            subtitle: toolPart.tool,
            icon: getToolIcon(toolPart.tool),
          })
        }

        if (part.type === "file") {
          const filePart = part as FilePart
          files.push({
            ...baseItem,
            title: filePart.filename ?? "Attachment",
            subtitle: filePart.mime,
            icon: filePart.mime.startsWith("image/") ? "photo" : "folder",
          })
        }

        if (part.type === "compaction") {
          const compactionPart = part as CompactionPart
          compactions.push({
            ...baseItem,
            title: compactionPart.auto ? "Auto Compaction" : "Manual Compaction",
            subtitle: "Context boundary",
            icon: "edit",
          })
        }
      }
    }

    const result: Group[] = []

    if (userMessages.length > 0) {
      result.push({
        key: "user-messages",
        title: "User Messages",
        icon: "speech-bubble",
        items: userMessages,
      })
    }

    if (assistantText.length > 0) {
      result.push({
        key: "assistant-text",
        title: "Assistant Responses",
        icon: "code",
        items: assistantText,
      })
    }

    if (reasoning.length > 0) {
      result.push({
        key: "reasoning",
        title: "Thinking/Reasoning",
        icon: "brain",
        items: reasoning,
      })
    }

    // Add tool groups in a specific order
    const toolGroupOrder = ["file-read", "file-write", "search", "bash", "web", "task", "other-tools"]
    for (const key of toolGroupOrder) {
      const items = toolGroups[key]
      if (items && items.length > 0) {
        result.push({
          key,
          title: getToolGroupTitle(key),
          icon: getToolGroupIcon(key),
          items,
        })
      }
    }

    if (files.length > 0) {
      result.push({
        key: "files",
        title: "File Attachments",
        icon: "folder",
        items: files,
      })
    }

    if (compactions.length > 0) {
      result.push({
        key: "compactions",
        title: "Compaction Summaries",
        icon: "edit",
        items: compactions,
      })
    }

    return result
  })

  // Filter groups based on hidden state
  const filteredGroups = createMemo(() => {
    if (!props.selection || props.selection.showHidden()) return groups()
    return groups()
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !props.selection!.hidden().has(item.partId)),
      }))
      .filter((group) => group.items.length > 0)
  })

  // Helper to get a part by messageId and partId
  const getPart = (messageId: string, partId: string): Part | undefined => {
    const parts = props.getParts(messageId)
    return parts.find((p) => p.id === partId)
  }

  return (
    <div data-component="context-grouped-view">
      <For each={filteredGroups()}>
        {(group) => (
          <GroupSection
            group={group}
            onJumpToMessage={props.onJumpToMessage}
            selection={props.selection}
            onPartUpdated={props.onPartUpdated}
            getPart={getPart}
          />
        )}
      </For>
      <Show when={filteredGroups().length === 0}>
        <div class="text-12-regular text-text-weak py-4 text-center">No content to display</div>
      </Show>
    </div>
  )
}
