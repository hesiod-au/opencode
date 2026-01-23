import { createMemo, For, Match, Show, Switch } from "solid-js"
import { useParams } from "@solidjs/router"
import { DateTime } from "luxon"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import type {
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  StepFinishPart,
  CompactionPart,
  Message,
  AssistantMessage,
} from "@opencode-ai/sdk/v2/client"
import type { SelectionState } from "./session-context-tab"
import { DialogPartEditor } from "./dialog-part-editor"
import { DialogConfirmDelete } from "./dialog-confirm-delete"
import { usePendingDeletions } from "./use-pending-deletions"
import { useLoadedSnapshot } from "./use-loaded-snapshot"

export interface ContextMessageItemProps {
  message: Message
  parts: () => Part[]
  onJumpToMessage?: (messageId: string) => void
  selection?: SelectionState
  onPartUpdated?: () => void
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

function getToolCategory(tool: string): string {
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
    case "question":
      return "question"
    default:
      return "other"
  }
}

function formatTime(timestamp: number): string {
  return DateTime.fromMillis(timestamp).toLocaleString(DateTime.TIME_WITH_SECONDS)
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return tokens.toString()
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + "..."
}

function TextPartItem(props: {
  part: TextPart
  message: Message
  selection?: SelectionState
  sessionID: string
  isPendingDeletion?: boolean
  onPartUpdated?: () => void
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const pendingDeletions = usePendingDeletions()
  const loadedSnapshotCtx = useLoadedSnapshot()
  // Check both local UI exclusion and backend excluded field
  const isExcluded = () => props.part.excluded || (props.selection?.isForceExcluded?.(props.part.id) ?? props.selection?.excluded().has(props.part.id) ?? false)
  const isForceIncluded = () => props.selection?.isForceIncluded?.(props.part.id) ?? false
  const isForceExcluded = () => props.selection?.isForceExcluded?.(props.part.id) ?? false
  const isHidden = () => props.selection?.hidden().has(props.part.id) ?? false
  const isCompactSelected = () => props.selection?.compactSelection().has(props.part.id) ?? false

  // Get displayed text - use edit if available, otherwise original
  const displayText = createMemo(() => {
    const edit = loadedSnapshotCtx.getEdit(props.part.id)
    if (edit && edit.type === "text") {
      return edit.content
    }
    return props.part.text
  })
  const isEdited = () => loadedSnapshotCtx.getEdit(props.part.id) !== undefined

  const handleIncludeClick = async (e: MouseEvent) => {
    e.stopPropagation()
    // If part has backend exclusion, update via API first
    if (props.part.excluded) {
      await sdk.client.part.update({
        sessionID: props.part.sessionID,
        messageID: props.part.messageID,
        partID: props.part.id,
        part: {
          ...props.part,
          excluded: false,
        },
      })
      props.onPartUpdated?.()
    }
    props.selection?.setInclude?.(props.part.id)
  }

  const handleExcludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (isForceExcluded()) {
      // Already excluded - trigger archive flow
      props.selection?.onDoubleExclude?.(props.part.id)
    } else {
      props.selection?.setExclude?.(props.part.id)
    }
  }

  const handleHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleHidden(props.part.id)
  }

  const handleCompactToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleCompactSelection(props.part.id)
  }

  const handleEdit = (e: MouseEvent) => {
    e.stopPropagation()
    dialog.show(() => <DialogPartEditor part={props.part} sessionID={props.sessionID} />)
  }

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation()
    pendingDeletions.deletePart(props.part, props.sessionID)
  }

  return (
    <Show when={!props.part.synthetic && !props.part.ignored && !props.isPendingDeletion}>
      <div
        data-component="context-part-item"
        data-type="text"
        data-role={props.message.role}
        data-excluded={isExcluded()}
        data-force-include={isForceIncluded()}
        data-force-exclude={isForceExcluded()}
        data-hidden={isHidden()}
        data-compact-selected={isCompactSelected()}
      >
        <Show when={props.selection}>
          <div data-slot="context-part-controls">
            <button
              data-slot="context-control-include"
              data-active={isForceIncluded()}
              onClick={handleIncludeClick}
              title="Always include"
            >
              <Icon name="plus" size="small" />
            </button>
            <button
              data-slot="context-control-exclude"
              data-active={isForceExcluded()}
              onClick={handleExcludeClick}
              title={isForceExcluded() ? "Click again to archive" : "Exclude from context"}
            >
              <Icon name="dash" size="small" />
            </button>
          </div>
        </Show>
        <div data-slot="context-part-icon">
          <Icon name={props.message.role === "user" ? "speech-bubble" : "code"} size="small" />
        </div>
        <div data-slot="context-part-content">
          <span data-slot="context-part-label">
            {props.message.role === "user" ? "User" : "Assistant"}
            <Show when={isEdited()}>
              <span data-slot="context-part-edited">(edited)</span>
            </Show>
          </span>
          <span data-slot="context-part-preview">{truncateText(displayText().trim(), 100)}</span>
        </div>
        <div data-slot="context-part-actions">
          <button data-slot="context-part-edit" onClick={handleEdit} title="Edit text">
            <Icon name="edit" size="small" />
          </button>
          <button data-slot="context-part-delete" onClick={handleDelete} title="Delete text">
            <Icon name="close" size="small" />
          </button>
          <Show when={props.selection}>
            <button data-slot="context-part-hide" onClick={handleHideToggle} title={isHidden() ? "Unhide" : "Hide"}>
              <Icon name="eye" size="small" />
            </button>
            <button
              data-slot="context-part-compact"
              data-selected={isCompactSelected()}
              onClick={handleCompactToggle}
              title={isCompactSelected() ? "Deselect for compaction" : "Select for compaction"}
            >
              <Icon name="collapse" size="small" />
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function ReasoningPartItem(props: { part: ReasoningPart; selection?: SelectionState; onPartUpdated?: () => void }) {
  const sdk = useSDK()
  // Check both local UI exclusion and backend excluded field
  const isExcluded = () => props.part.excluded || (props.selection?.isForceExcluded?.(props.part.id) ?? props.selection?.excluded().has(props.part.id) ?? false)
  const isForceIncluded = () => props.selection?.isForceIncluded?.(props.part.id) ?? false
  const isForceExcluded = () => props.selection?.isForceExcluded?.(props.part.id) ?? false
  const isHidden = () => props.selection?.hidden().has(props.part.id) ?? false
  const isCompactSelected = () => props.selection?.compactSelection().has(props.part.id) ?? false

  const handleIncludeClick = async (e: MouseEvent) => {
    e.stopPropagation()
    // If part has backend exclusion, update via API first
    if (props.part.excluded) {
      await sdk.client.part.update({
        sessionID: props.part.sessionID,
        messageID: props.part.messageID,
        partID: props.part.id,
        part: {
          ...props.part,
          excluded: false,
        },
      })
      props.onPartUpdated?.()
    }
    props.selection?.setInclude?.(props.part.id)
  }

  const handleExcludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (isForceExcluded()) {
      // Already excluded - trigger archive flow
      props.selection?.onDoubleExclude?.(props.part.id)
    } else {
      props.selection?.setExclude?.(props.part.id)
    }
  }

  const handleHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleHidden(props.part.id)
  }

  const handleCompactToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleCompactSelection(props.part.id)
  }

  return (
    <div
      data-component="context-part-item"
      data-type="reasoning"
      data-excluded={isExcluded()}
      data-force-include={isForceIncluded()}
      data-force-exclude={isForceExcluded()}
      data-hidden={isHidden()}
      data-compact-selected={isCompactSelected()}
    >
      <Show when={props.selection}>
        <div data-slot="context-part-controls">
          <button
            data-slot="context-control-include"
            data-active={isForceIncluded()}
            onClick={handleIncludeClick}
            title="Always include"
          >
            <Icon name="plus" size="small" />
          </button>
          <button
            data-slot="context-control-exclude"
            data-active={isForceExcluded()}
            onClick={handleExcludeClick}
            title={isForceExcluded() ? "Click again to archive" : "Exclude from context"}
          >
            <Icon name="dash" size="small" />
          </button>
        </div>
      </Show>
      <div data-slot="context-part-icon">
        <Icon name="brain" size="small" />
      </div>
      <div data-slot="context-part-content">
        <span data-slot="context-part-label">Thinking</span>
        <span data-slot="context-part-preview">{truncateText(props.part.text.trim(), 80)}</span>
      </div>
      <Show when={props.selection}>
        <div data-slot="context-part-actions">
          <button data-slot="context-part-hide" onClick={handleHideToggle} title={isHidden() ? "Unhide" : "Hide"}>
            <Icon name="eye" size="small" />
          </button>
          <button
            data-slot="context-part-compact"
            data-selected={isCompactSelected()}
            onClick={handleCompactToggle}
            title={isCompactSelected() ? "Deselect for compaction" : "Select for compaction"}
          >
            <Icon name="collapse" size="small" />
          </button>
        </div>
      </Show>
    </div>
  )
}

function ToolPartItem(props: {
  part: ToolPart
  selection?: SelectionState
  sessionID: string
  isPendingDeletion?: boolean
  onPartUpdated?: () => void
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const pendingDeletions = usePendingDeletions()
  const loadedSnapshotCtx = useLoadedSnapshot()
  const icon = () => getToolIcon(props.part.tool)
  const status = () => props.part.state.status
  const title = () =>
    props.part.state.status === "completed" || props.part.state.status === "running" ? props.part.state.title : undefined
  // Check both local UI exclusion and backend excluded field
  const isExcluded = () => props.part.excluded || (props.selection?.isForceExcluded?.(props.part.id) ?? props.selection?.excluded().has(props.part.id) ?? false)
  const isForceIncluded = () => props.selection?.isForceIncluded?.(props.part.id) ?? false
  const isForceExcluded = () => props.selection?.isForceExcluded?.(props.part.id) ?? false
  const isHidden = () => props.selection?.hidden().has(props.part.id) ?? false
  const isCompactSelected = () => props.selection?.compactSelection().has(props.part.id) ?? false
  const canEditOutput = () => props.part.state.status === "completed"
  const isEdited = () => loadedSnapshotCtx.getEdit(props.part.id) !== undefined

  const handleIncludeClick = async (e: MouseEvent) => {
    e.stopPropagation()
    // If part has backend exclusion, update via API first
    if (props.part.excluded) {
      await sdk.client.part.update({
        sessionID: props.part.sessionID,
        messageID: props.part.messageID,
        partID: props.part.id,
        part: {
          ...props.part,
          excluded: false,
        },
      })
      props.onPartUpdated?.()
    }
    props.selection?.setInclude?.(props.part.id)
  }

  const handleExcludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (isForceExcluded()) {
      // Already excluded - trigger archive flow
      props.selection?.onDoubleExclude?.(props.part.id)
    } else {
      props.selection?.setExclude?.(props.part.id)
    }
  }

  const handleHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleHidden(props.part.id)
  }

  const handleCompactToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleCompactSelection(props.part.id)
  }

  const handleEdit = (e: MouseEvent) => {
    e.stopPropagation()
    if (!canEditOutput()) return
    dialog.show(() => <DialogPartEditor part={props.part} sessionID={props.sessionID} />)
  }

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation()
    pendingDeletions.deletePart(props.part, props.sessionID)
  }

  return (
    <Show when={!props.isPendingDeletion}>
      <div
        data-component="context-part-item"
        data-type="tool"
        data-category={getToolCategory(props.part.tool)}
        data-status={status()}
        data-excluded={isExcluded()}
        data-force-include={isForceIncluded()}
        data-force-exclude={isForceExcluded()}
        data-hidden={isHidden()}
        data-compact-selected={isCompactSelected()}
      >
        <Show when={props.selection}>
          <div data-slot="context-part-controls">
            <button
              data-slot="context-control-include"
              data-active={isForceIncluded()}
              onClick={handleIncludeClick}
              title="Always include"
            >
              <Icon name="plus" size="small" />
            </button>
            <button
              data-slot="context-control-exclude"
              data-active={isForceExcluded()}
              onClick={handleExcludeClick}
              title={isForceExcluded() ? "Click again to archive" : "Exclude from context"}
            >
              <Icon name="dash" size="small" />
            </button>
          </div>
        </Show>
        <div data-slot="context-part-icon">
          <Icon name={icon()} size="small" />
        </div>
        <div data-slot="context-part-content">
          <span data-slot="context-part-label">
            {props.part.tool}
            <Show when={isEdited()}>
              <span data-slot="context-part-edited">(edited)</span>
            </Show>
          </span>
          <Show when={title()}>
            <span data-slot="context-part-subtitle">{title()}</span>
          </Show>
          <Show when={status() === "error"}>
            <span data-slot="context-part-error">Error</span>
          </Show>
        </div>
        <div data-slot="context-part-actions">
          <Show when={canEditOutput()}>
            <button data-slot="context-part-edit" onClick={handleEdit} title="Edit output">
              <Icon name="edit" size="small" />
            </button>
          </Show>
          <button data-slot="context-part-delete" onClick={handleDelete} title="Delete tool call">
            <Icon name="close" size="small" />
          </button>
          <Show when={props.selection}>
            <button data-slot="context-part-hide" onClick={handleHideToggle} title={isHidden() ? "Unhide" : "Hide"}>
              <Icon name="eye" size="small" />
            </button>
            <button
              data-slot="context-part-compact"
              data-selected={isCompactSelected()}
              onClick={handleCompactToggle}
              title={isCompactSelected() ? "Deselect for compaction" : "Select for compaction"}
            >
              <Icon name="collapse" size="small" />
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function FilePartItem(props: {
  part: FilePart
  selection?: SelectionState
  sessionID: string
  isPendingDeletion?: boolean
  onPartUpdated?: () => void
}) {
  const sdk = useSDK()
  const pendingDeletions = usePendingDeletions()
  const isImage = () => props.part.mime.startsWith("image/")
  // Check both local UI exclusion and backend excluded field
  const isExcluded = () => props.part.excluded || (props.selection?.isForceExcluded?.(props.part.id) ?? props.selection?.excluded().has(props.part.id) ?? false)
  const isForceIncluded = () => props.selection?.isForceIncluded?.(props.part.id) ?? false
  const isForceExcluded = () => props.selection?.isForceExcluded?.(props.part.id) ?? false
  const isHidden = () => props.selection?.hidden().has(props.part.id) ?? false
  const isCompactSelected = () => props.selection?.compactSelection().has(props.part.id) ?? false

  const handleIncludeClick = async (e: MouseEvent) => {
    e.stopPropagation()
    // If part has backend exclusion, update via API first
    if (props.part.excluded) {
      await sdk.client.part.update({
        sessionID: props.part.sessionID,
        messageID: props.part.messageID,
        partID: props.part.id,
        part: {
          ...props.part,
          excluded: false,
        },
      })
      props.onPartUpdated?.()
    }
    props.selection?.setInclude?.(props.part.id)
  }

  const handleExcludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (isForceExcluded()) {
      // Already excluded - trigger archive flow
      props.selection?.onDoubleExclude?.(props.part.id)
    } else {
      props.selection?.setExclude?.(props.part.id)
    }
  }

  const handleHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleHidden(props.part.id)
  }

  const handleCompactToggle = (e: MouseEvent) => {
    e.stopPropagation()
    props.selection?.toggleCompactSelection(props.part.id)
  }

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation()
    pendingDeletions.deletePart(props.part, props.sessionID)
  }

  return (
    <Show when={!props.isPendingDeletion}>
      <div
        data-component="context-part-item"
        data-type="file"
        data-excluded={isExcluded()}
        data-force-include={isForceIncluded()}
        data-force-exclude={isForceExcluded()}
        data-hidden={isHidden()}
        data-compact-selected={isCompactSelected()}
      >
        <Show when={props.selection}>
          <div data-slot="context-part-controls">
            <button
              data-slot="context-control-include"
              data-active={isForceIncluded()}
              onClick={handleIncludeClick}
              title="Always include"
            >
              <Icon name="plus" size="small" />
            </button>
            <button
              data-slot="context-control-exclude"
              data-active={isForceExcluded()}
              onClick={handleExcludeClick}
              title={isForceExcluded() ? "Click again to archive" : "Exclude from context"}
            >
              <Icon name="dash" size="small" />
            </button>
          </div>
        </Show>
        <div data-slot="context-part-icon">
          <Icon name={isImage() ? "photo" : "folder"} size="small" />
        </div>
        <div data-slot="context-part-content">
          <span data-slot="context-part-label">File</span>
          <span data-slot="context-part-subtitle">{props.part.filename ?? "attachment"}</span>
        </div>
        <div data-slot="context-part-actions">
          <button data-slot="context-part-delete" onClick={handleDelete} title="Delete file">
            <Icon name="close" size="small" />
          </button>
          <Show when={props.selection}>
            <button data-slot="context-part-hide" onClick={handleHideToggle} title={isHidden() ? "Unhide" : "Hide"}>
              <Icon name="eye" size="small" />
            </button>
            <button
              data-slot="context-part-compact"
              data-selected={isCompactSelected()}
              onClick={handleCompactToggle}
              title={isCompactSelected() ? "Deselect for compaction" : "Select for compaction"}
            >
              <Icon name="collapse" size="small" />
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function StepFinishPartItem(props: { part: StepFinishPart }) {
  const totalTokens = () => props.part.tokens.input + props.part.tokens.output + props.part.tokens.reasoning

  return (
    <div data-component="context-part-item" data-type="step">
      <div data-slot="context-part-divider" />
      <div data-slot="context-step-info">
        <span data-slot="context-step-tokens">{formatTokens(totalTokens())} tokens</span>
        <Show when={props.part.cost > 0}>
          <span data-slot="context-step-cost">${props.part.cost.toFixed(4)}</span>
        </Show>
      </div>
    </div>
  )
}

function CompactionPartItem(props: { part: CompactionPart }) {
  return (
    <div data-component="context-part-item" data-type="compaction">
      <div data-slot="context-compaction-banner">
        <Icon name="edit" size="small" />
        <span>Context Boundary</span>
        <Show when={props.part.auto}>
          <span data-slot="context-compaction-auto">(auto)</span>
        </Show>
      </div>
    </div>
  )
}

function PartItem(props: {
  part: Part
  message: Message
  selection?: SelectionState
  sessionID: string
  isPendingDeletion?: boolean
  onPartUpdated?: () => void
}) {
  return (
    <Switch>
      <Match when={props.part.type === "text"}>
        <TextPartItem
          part={props.part as TextPart}
          message={props.message}
          selection={props.selection}
          sessionID={props.sessionID}
          isPendingDeletion={props.isPendingDeletion}
          onPartUpdated={props.onPartUpdated}
        />
      </Match>
      <Match when={props.part.type === "reasoning"}>
        <ReasoningPartItem part={props.part as ReasoningPart} selection={props.selection} onPartUpdated={props.onPartUpdated} />
      </Match>
      <Match when={props.part.type === "tool"}>
        <ToolPartItem
          part={props.part as ToolPart}
          selection={props.selection}
          sessionID={props.sessionID}
          isPendingDeletion={props.isPendingDeletion}
          onPartUpdated={props.onPartUpdated}
        />
      </Match>
      <Match when={props.part.type === "file"}>
        <FilePartItem
          part={props.part as FilePart}
          selection={props.selection}
          sessionID={props.sessionID}
          isPendingDeletion={props.isPendingDeletion}
          onPartUpdated={props.onPartUpdated}
        />
      </Match>
      <Match when={props.part.type === "step-finish"}>
        <StepFinishPartItem part={props.part as StepFinishPart} />
      </Match>
      <Match when={props.part.type === "compaction"}>
        <CompactionPartItem part={props.part as CompactionPart} />
      </Match>
    </Switch>
  )
}

export function ContextMessageItem(props: ContextMessageItemProps) {
  const params = useParams()
  const sdk = useSDK()
  const dialog = useDialog()
  const pendingDeletions = usePendingDeletions()
  const sessionID = () => params.id ?? ""
  const timestamp = createMemo(() => props.message.time.created)
  const isAssistant = createMemo(() => props.message.role === "assistant")

  const tokens = createMemo(() => {
    if (!isAssistant()) return null
    const msg = props.message as AssistantMessage
    return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning
  })

  const hasCompaction = createMemo(() => props.parts().some((p) => p.type === "compaction"))

  // Get selectable parts (parts that can be excluded/hidden)
  const selectableParts = createMemo(() =>
    props.parts().filter((p) => {
      if (p.type === "step-start") return false
      if (p.type === "snapshot") return false
      if (p.type === "patch") return false
      if (p.type === "agent") return false
      if (p.type === "retry") return false
      if (p.type === "subtask") return false
      if (p.type === "step-finish") return false
      if (p.type === "compaction") return false
      if (p.type === "text" && (p as TextPart).synthetic) return false
      if (p.type === "text" && (p as TextPart).ignored) return false
      return true
    }),
  )

  const visibleParts = createMemo(() =>
    props.parts().filter((p) => {
      if (p.type === "step-start") return false
      if (p.type === "snapshot") return false
      if (p.type === "patch") return false
      if (p.type === "agent") return false
      if (p.type === "retry") return false
      if (p.type === "subtask") return false
      if (p.type === "text" && (p as TextPart).synthetic) return false
      if (p.type === "text" && (p as TextPart).ignored) return false
      // Filter hidden parts unless showHidden is true
      if (props.selection && !props.selection.showHidden() && props.selection.hidden().has(p.id)) return false
      return true
    }),
  )

  // Helper to check if a part is excluded (either by backend or local UI)
  const isPartExcluded = (p: Part) => p.excluded || (props.selection?.isForceExcluded?.(p.id) ?? props.selection?.excluded().has(p.id) ?? false)

  // Helper to check if a part is force included
  const isPartForceIncluded = (p: Part) => props.selection?.isForceIncluded?.(p.id) ?? false

  const excludedCount = createMemo(() => {
    return visibleParts().filter((p) => isPartExcluded(p)).length
  })

  // Check if all selectable parts are excluded
  const isMessageExcluded = createMemo(() => {
    const parts = selectableParts()
    if (parts.length === 0) return false
    return parts.every((p) => isPartExcluded(p))
  })

  // Check if all selectable parts are hidden
  const isMessageHidden = createMemo(() => {
    if (!props.selection) return false
    const parts = selectableParts()
    if (parts.length === 0) return false
    return parts.every((p) => props.selection!.hidden().has(p.id))
  })

  // Check if all selectable parts are selected for compaction
  const isMessageCompactSelected = createMemo(() => {
    if (!props.selection) return false
    const parts = selectableParts()
    if (parts.length === 0) return false
    return parts.every((p) => props.selection!.compactSelection().has(p.id))
  })

  // Count how many parts are selected for compaction
  const compactSelectedCount = createMemo(() => {
    if (!props.selection) return 0
    return visibleParts().filter((p) => props.selection!.compactSelection().has(p.id)).length
  })

  const handleMessageIncludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (!props.selection) return
    const parts = selectableParts()
    if (parts.length === 0) return

    // Include all parts (remove from excluded)
    for (const p of parts) {
      props.selection.setInclude?.(p.id)
    }
  }

  const handleMessageExcludeClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (!props.selection) return
    const parts = selectableParts()
    if (parts.length === 0) return

    if (isMessageExcluded()) {
      // Already excluded - this is a double-minus, trigger archive for all
      for (const p of parts) {
        props.selection.onDoubleExclude?.(p.id)
      }
    } else {
      // Exclude all parts
      for (const p of parts) {
        props.selection.setExclude?.(p.id)
      }
    }
  }

  const handleMessageHideToggle = (e: MouseEvent) => {
    e.stopPropagation()
    if (!props.selection) return
    const parts = selectableParts()
    if (parts.length === 0) return

    if (isMessageHidden()) {
      // Show all parts
      props.selection.setHidden((prev) => {
        const next = new Set(prev)
        for (const p of parts) next.delete(p.id)
        return next
      })
    } else {
      // Hide all parts
      props.selection.setHidden((prev) => {
        const next = new Set(prev)
        for (const p of parts) next.add(p.id)
        return next
      })
    }
  }

  const handleMessageCompactToggle = (e: MouseEvent) => {
    e.stopPropagation()
    if (!props.selection) return
    const parts = selectableParts()
    if (parts.length === 0) return

    if (isMessageCompactSelected()) {
      // Deselect all parts from compaction
      for (const p of parts) {
        if (props.selection.compactSelection().has(p.id)) {
          props.selection.toggleCompactSelection(p.id)
        }
      }
    } else {
      // Select all parts for compaction
      for (const p of parts) {
        if (!props.selection.compactSelection().has(p.id)) {
          props.selection.toggleCompactSelection(p.id)
        }
      }
    }
  }

  const handleDeleteMessage = (e: MouseEvent) => {
    e.stopPropagation()
    dialog.show(() => (
      <DialogConfirmDelete
        title="Delete Message"
        description={`Are you sure you want to delete this ${props.message.role} message and all its parts?`}
        itemType="message"
        onConfirm={async () => {
          // Soft delete all parts in the message
          const parts = selectableParts()
          for (const part of parts) {
            pendingDeletions.deletePart(part, sessionID())
          }
        }}
      />
    ))
  }

  return (
    <div
      data-component="context-message-item"
      data-role={props.message.role}
      data-compaction={hasCompaction()}
      data-excluded={isMessageExcluded()}
      data-hidden={isMessageHidden()}
      data-compact-selected={isMessageCompactSelected()}
    >
      <Collapsible defaultOpen={false}>
        <Collapsible.Trigger>
          <div data-slot="context-message-header">
            <Show when={props.selection && selectableParts().length > 0}>
              <div data-slot="context-message-controls">
                <button
                  data-slot="context-control-include"
                  data-active={false}
                  onClick={handleMessageIncludeClick}
                  title="Include all parts"
                >
                  <Icon name="plus" size="small" />
                </button>
                <button
                  data-slot="context-control-exclude"
                  data-active={isMessageExcluded()}
                  onClick={handleMessageExcludeClick}
                  title={isMessageExcluded() ? "Click again to archive all" : "Exclude all parts"}
                >
                  <Icon name="dash" size="small" />
                </button>
              </div>
            </Show>
            <div data-slot="context-message-role">
              <Icon name={props.message.role === "user" ? "speech-bubble" : "code"} size="small" />
              <span>{props.message.role === "user" ? "User" : "Assistant"}</span>
            </div>
            <div data-slot="context-message-meta">
              <span data-slot="context-message-time">{formatTime(timestamp())}</span>
              <Show when={tokens()}>
                <span data-slot="context-message-tokens">{formatTokens(tokens()!)} tokens</span>
              </Show>
              <span data-slot="context-message-parts">{visibleParts().length} parts</span>
              <Show when={excludedCount() > 0}>
                <span data-slot="context-message-excluded">{excludedCount()} excluded</span>
              </Show>
              <Show when={compactSelectedCount() > 0}>
                <span data-slot="context-message-compact-count">{compactSelectedCount()} for compaction</span>
              </Show>
            </div>
            <div data-slot="context-message-actions">
              <button
                data-slot="context-message-delete"
                onClick={handleDeleteMessage}
                title="Delete message"
              >
                <Icon name="close" size="small" />
              </button>
              <Show when={props.selection && selectableParts().length > 0}>
                <button
                  data-slot="context-message-hide"
                  onClick={handleMessageHideToggle}
                  title={isMessageHidden() ? "Show message" : "Hide message"}
                >
                  <Icon name="eye" size="small" />
                </button>
                <button
                  data-slot="context-message-compact"
                  data-selected={isMessageCompactSelected()}
                  onClick={handleMessageCompactToggle}
                  title={isMessageCompactSelected() ? "Deselect for compaction" : "Select for compaction"}
                >
                  <Icon name="collapse" size="small" />
                </button>
              </Show>
            </div>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="context-message-parts">
            <For each={visibleParts()}>
              {(part) => (
                <PartItem
                  part={part}
                  message={props.message}
                  selection={props.selection}
                  sessionID={sessionID()}
                  isPendingDeletion={pendingDeletions.isPending(part.id)}
                  onPartUpdated={props.onPartUpdated}
                />
              )}
            </For>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
