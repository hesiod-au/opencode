import { createSignal, createMemo, Show, For } from "solid-js"
import { DateTime } from "luxon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { useContextSnapshots, type ContextSnapshot, type SnapshotGroup } from "./use-context-snapshots"

export interface DialogLoadSnapshotProps {
  sessionID: string
  hasUnsavedChanges: boolean
  onLoad: (snapshot: ContextSnapshot) => void
  onSaveFirst?: () => void
}

export function DialogLoadSnapshot(props: DialogLoadSnapshotProps) {
  const dialog = useDialog()
  const snapshots = useContextSnapshots()
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [showWarning, setShowWarning] = createSignal(false)

  // Get all snapshots grouped by session
  const groupedSnapshots = createMemo(() => snapshots.snapshotsBySession())

  // Sort groups so current session is first
  const sortedGroups = createMemo(() => {
    const groups = groupedSnapshots()
    const currentSessionGroup = groups.find((g) => g.sessionID === props.sessionID)
    const otherGroups = groups.filter((g) => g.sessionID !== props.sessionID)
    return currentSessionGroup ? [currentSessionGroup, ...otherGroups] : otherGroups
  })

  const selectedSnapshot = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    return snapshots.getSnapshot(id) ?? null
  })

  const formatDate = (timestamp: number) => {
    return DateTime.fromMillis(timestamp).toLocaleString(DateTime.DATETIME_MED)
  }

  const handleSelect = (snapshotId: string) => {
    setSelectedId(snapshotId)
  }

  const handleLoad = () => {
    const snapshot = selectedSnapshot()
    if (!snapshot) return

    if (props.hasUnsavedChanges && !showWarning()) {
      setShowWarning(true)
      return
    }

    props.onLoad(snapshot)
    dialog.close()
  }

  const handleSaveFirst = () => {
    props.onSaveFirst?.()
  }

  const handleCancel = () => {
    if (showWarning()) {
      setShowWarning(false)
      return
    }
    dialog.close()
  }

  const hasSnapshots = createMemo(() => sortedGroups().length > 0)

  return (
    <Dialog title="Load Context Snapshot">
      <div data-component="load-snapshot-dialog">
        <Show when={showWarning()}>
          <div data-slot="snapshot-warning">
            <Icon name="circle-ban-sign" size="normal" />
            <div>
              <p data-slot="warning-title">You have unsaved changes</p>
              <p data-slot="warning-text">
                Loading this snapshot will replace the current context state. Consider saving a snapshot first.
              </p>
            </div>
          </div>
        </Show>

        <Show
          when={hasSnapshots()}
          fallback={
            <div data-slot="snapshot-empty">
              <Icon name="archive" size="large" />
              <p>No snapshots available</p>
              <p data-slot="empty-hint">Save a snapshot first to load it later</p>
            </div>
          }
        >
          <div data-slot="snapshot-groups">
            <Accordion multiple defaultValue={[props.sessionID]}>
              <For each={sortedGroups()}>
                {(group) => (
                  <Accordion.Item value={group.sessionID}>
                    <Accordion.Trigger>
                      <div data-slot="snapshot-group-header">
                        <span data-slot="group-name">
                          {group.sessionName}
                          <Show when={group.sessionID === props.sessionID}>
                            <span data-slot="group-current">(current)</span>
                          </Show>
                        </span>
                        <span data-slot="group-count">{group.snapshots.length}</span>
                      </div>
                    </Accordion.Trigger>
                    <Accordion.Content>
                      <div data-slot="snapshot-list">
                        <For each={group.snapshots}>
                          {(snapshot) => (
                            <div
                              data-slot="snapshot-list-item"
                              data-selected={selectedId() === snapshot.id}
                              onClick={() => handleSelect(snapshot.id)}
                            >
                              <div data-slot="snapshot-item-header">
                                <span data-slot="snapshot-item-name">{snapshot.name}</span>
                                <span data-slot="snapshot-item-date">{formatDate(snapshot.createdAt)}</span>
                              </div>
                              <div data-slot="snapshot-item-meta">
                                <span>{snapshot.messageCount} messages</span>
                                <span>~{snapshot.tokenEstimate.toLocaleString()} tokens</span>
                                <Show when={snapshot.exclusions.length > 0}>
                                  <span>{snapshot.exclusions.length} excluded</span>
                                </Show>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Accordion.Content>
                  </Accordion.Item>
                )}
              </For>
            </Accordion>
          </div>
        </Show>

        <Show when={selectedSnapshot()}>
          {(snapshot) => (
            <div data-slot="snapshot-preview">
              <div data-slot="preview-title">Preview</div>
              <div data-slot="preview-content">
                <div data-slot="preview-row">
                  <span>Name:</span>
                  <span>{snapshot().name}</span>
                </div>
                <Show when={snapshot().sessionID !== props.sessionID}>
                  <div data-slot="preview-row">
                    <span>From Session:</span>
                    <span>{snapshot().sessionName ?? snapshot().sessionID.slice(0, 8)}</span>
                  </div>
                </Show>
                <div data-slot="preview-row">
                  <span>Created:</span>
                  <span>{formatDate(snapshot().createdAt)}</span>
                </div>
                <div data-slot="preview-row">
                  <span>Messages:</span>
                  <span>{snapshot().messageCount}</span>
                </div>
                <div data-slot="preview-row">
                  <span>Token Estimate:</span>
                  <span>~{snapshot().tokenEstimate.toLocaleString()}</span>
                </div>
                <div data-slot="preview-row">
                  <span>Exclusions:</span>
                  <span>{snapshot().exclusions.length}</span>
                </div>
                <div data-slot="preview-row">
                  <span>Hidden:</span>
                  <span>{snapshot().hidden.length}</span>
                </div>
              </div>
            </div>
          )}
        </Show>

        <div data-slot="snapshot-actions">
          <button data-slot="snapshot-cancel" onClick={handleCancel}>
            {showWarning() ? "Go Back" : "Cancel"}
          </button>
          <Show when={showWarning() && props.onSaveFirst}>
            <button data-slot="snapshot-save-first" onClick={handleSaveFirst}>
              Save First
            </button>
          </Show>
          <button data-slot="snapshot-load" onClick={handleLoad} disabled={!selectedSnapshot()}>
            {showWarning() ? "Load Anyway" : "Load Snapshot"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
