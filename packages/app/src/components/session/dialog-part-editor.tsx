import { createSignal, createMemo, Show, Match, Switch } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Part, TextPart, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2/client"
import { useLoadedSnapshot } from "./use-loaded-snapshot"
import type { PartEdit } from "./use-context-snapshots"

export interface DialogPartEditorProps {
  part: Part
  sessionID: string
  onSaved?: () => void
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function DialogPartEditor(props: DialogPartEditorProps) {
  const dialog = useDialog()
  const loadedSnapshotCtx = useLoadedSnapshot()
  const [error, setError] = createSignal<string | null>(null)

  const isTextPart = () => props.part.type === "text"
  const isToolPart = () => props.part.type === "tool"
  const isCompletedTool = () =>
    props.part.type === "tool" && (props.part as ToolPart).state.status === "completed"

  // Check if there's an existing edit for this part
  const existingEdit = createMemo(() => loadedSnapshotCtx.getEdit(props.part.id))

  const initialValue = createMemo(() => {
    // Use existing edit content if available
    const edit = existingEdit()
    if (edit) return edit.content

    if (isTextPart()) {
      return (props.part as TextPart).text
    }
    if (isCompletedTool()) {
      const toolPart = props.part as ToolPart
      const state = toolPart.state as ToolStateCompleted
      return state.output
    }
    return ""
  })

  const [value, setValue] = createSignal(initialValue())

  const charCount = createMemo(() => value().length)
  const tokenCount = createMemo(() => estimateTokens(value()))
  const hasChanges = createMemo(() => value() !== initialValue())

  const canEdit = createMemo(() => {
    if (isTextPart()) return true
    if (isCompletedTool()) return true
    return false
  })

  const title = createMemo(() => {
    if (isTextPart()) {
      const textPart = props.part as TextPart
      return `Edit Text (${textPart.id.slice(0, 8)}...)`
    }
    if (isToolPart()) {
      const toolPart = props.part as ToolPart
      return `Edit Tool Output: ${toolPart.tool}`
    }
    return "Edit Part"
  })

  const handleSave = () => {
    if (!canEdit()) return
    setError(null)

    try {
      const editType: PartEdit["type"] = isTextPart() ? "text" : "tool-output"

      // Save edit to local state (will be applied on submission)
      loadedSnapshotCtx.setEdit({
        partId: props.part.id,
        type: editType,
        content: value(),
      })

      props.onSaved?.()
      dialog.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes")
    }
  }

  const handleRevert = () => {
    // Remove the edit and revert to original
    loadedSnapshotCtx.removeEdit(props.part.id)
    props.onSaved?.()
    dialog.close()
  }

  const handleCancel = () => {
    dialog.close()
  }

  return (
    <Dialog title={title()}>
      <div data-component="part-editor-dialog">
        <Show when={error()}>
          <div data-slot="part-editor-error">{error()}</div>
        </Show>

        <Switch>
          <Match when={isTextPart()}>
            <div data-slot="part-editor-field">
              <label data-slot="part-editor-label">Message Text</label>
              <textarea
                data-slot="part-editor-textarea"
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
                autofocus
                rows={10}
              />
            </div>
          </Match>

          <Match when={isCompletedTool()}>
            <div data-slot="part-editor-field">
              <label data-slot="part-editor-label">Tool Output</label>
              <textarea
                data-slot="part-editor-textarea"
                data-mono="true"
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
                autofocus
                rows={15}
              />
            </div>
          </Match>

          <Match when={!canEdit()}>
            <div data-slot="part-editor-readonly">This part type cannot be edited.</div>
          </Match>
        </Switch>

        <Show when={canEdit()}>
          <div data-slot="part-editor-stats">
            <span>{charCount().toLocaleString()} characters</span>
            <span>~{tokenCount().toLocaleString()} tokens</span>
          </div>
        </Show>

        <div data-slot="part-editor-actions">
          <button data-slot="part-editor-cancel" onClick={handleCancel}>
            Cancel
          </button>
          <Show when={existingEdit()}>
            <button data-slot="part-editor-revert" onClick={handleRevert}>
              Revert to Original
            </button>
          </Show>
          <button
            data-slot="part-editor-save"
            onClick={handleSave}
            disabled={!canEdit()}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  )
}
