import { createSignal, createMemo, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { useContextSnapshots, calculateSnapshotTokens, type PartEdit } from "./use-context-snapshots"

export interface DialogSaveSnapshotProps {
  sessionID: string
  sessionName?: string
  messages: Message[]
  parts: Record<string, Part[]>
  exclusions: string[]
  hidden: string[]
  edits: PartEdit[]
  onSaved?: () => void
}

export function DialogSaveSnapshot(props: DialogSaveSnapshotProps) {
  const dialog = useDialog()
  const snapshots = useContextSnapshots()
  const [name, setName] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const tokenEstimate = createMemo(() => calculateSnapshotTokens(props.messages, props.parts))

  const isValid = createMemo(() => name().trim().length > 0)

  const handleSave = async () => {
    if (!isValid()) return

    setSaving(true)
    setError(null)

    try {
      snapshots.saveSnapshot({
        name: name().trim(),
        sessionID: props.sessionID,
        sessionName: props.sessionName,
        messages: props.messages,
        parts: props.parts,
        exclusions: props.exclusions,
        hidden: props.hidden,
        edits: props.edits,
      })
      props.onSaved?.()
      dialog.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save snapshot")
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    dialog.close()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && isValid() && !saving()) {
      handleSave()
    }
  }

  return (
    <Dialog title="Save Context Snapshot">
      <div data-component="save-snapshot-dialog">
        <div data-slot="snapshot-info">
          <div data-slot="snapshot-info-row">
            <Icon name="bubble-5" size="small" />
            <span>{props.messages.length} messages</span>
          </div>
          <div data-slot="snapshot-info-row">
            <Icon name="code-lines" size="small" />
            <span>~{tokenEstimate().toLocaleString()} tokens</span>
          </div>
          <Show when={props.exclusions.length > 0}>
            <div data-slot="snapshot-info-row">
              <Icon name="circle-ban-sign" size="small" />
              <span>{props.exclusions.length} excluded</span>
            </div>
          </Show>
          <Show when={props.hidden.length > 0}>
            <div data-slot="snapshot-info-row">
              <Icon name="eye" size="small" />
              <span>{props.hidden.length} hidden</span>
            </div>
          </Show>
          <Show when={props.edits.length > 0}>
            <div data-slot="snapshot-info-row">
              <Icon name="pencil-line" size="small" />
              <span>{props.edits.length} edited</span>
            </div>
          </Show>
        </div>

        <Show when={error()}>
          <div data-slot="snapshot-error">{error()}</div>
        </Show>

        <div data-slot="snapshot-field">
          <label data-slot="snapshot-label">Snapshot Name</label>
          <input
            data-slot="snapshot-input"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a name for this snapshot..."
            autofocus
          />
        </div>

        <div data-slot="snapshot-actions">
          <button data-slot="snapshot-cancel" onClick={handleCancel} disabled={saving()}>
            Cancel
          </button>
          <button
            data-slot="snapshot-save"
            onClick={handleSave}
            disabled={saving() || !isValid()}
          >
            {saving() ? "Saving..." : "Save Snapshot"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
