import { createSignal, createMemo, Show, For } from "solid-js"
import { DateTime } from "luxon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { useContextSnapshots, type ContextSnapshot } from "./use-context-snapshots"

export interface DialogSnapshotsListProps {
  sessionID?: string
  onLoad?: (snapshot: ContextSnapshot) => void
}

export function DialogSnapshotsList(props: DialogSnapshotsListProps) {
  const dialog = useDialog()
  const snapshots = useContextSnapshots()
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editingName, setEditingName] = createSignal("")
  const [deletingId, setDeletingId] = createSignal<string | null>(null)
  const [importError, setImportError] = createSignal<string | null>(null)

  // Get all snapshots grouped by session
  const groupedSnapshots = createMemo(() => snapshots.snapshotsBySession())

  // Sort groups so current session is first
  const sortedGroups = createMemo(() => {
    const groups = groupedSnapshots()
    if (!props.sessionID) return groups
    const currentSessionGroup = groups.find((g) => g.sessionID === props.sessionID)
    const otherGroups = groups.filter((g) => g.sessionID !== props.sessionID)
    return currentSessionGroup ? [currentSessionGroup, ...otherGroups] : otherGroups
  })

  const hasSnapshots = createMemo(() => sortedGroups().length > 0)

  const formatDate = (timestamp: number) => {
    return DateTime.fromMillis(timestamp).toLocaleString(DateTime.DATETIME_MED)
  }

  const handleStartEdit = (snapshot: ContextSnapshot) => {
    setEditingId(snapshot.id)
    setEditingName(snapshot.name)
  }

  const handleSaveEdit = () => {
    const id = editingId()
    if (!id) return

    snapshots.renameSnapshot(id, editingName().trim())
    setEditingId(null)
    setEditingName("")
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingName("")
  }

  const handleStartDelete = (snapshotId: string) => {
    setDeletingId(snapshotId)
  }

  const handleConfirmDelete = () => {
    const id = deletingId()
    if (!id) return

    snapshots.deleteSnapshot(id)
    setDeletingId(null)
  }

  const handleCancelDelete = () => {
    setDeletingId(null)
  }

  const handleExport = (snapshot: ContextSnapshot) => {
    snapshots.exportSnapshot(snapshot)
  }

  const handleLoad = (snapshot: ContextSnapshot) => {
    props.onLoad?.(snapshot)
    dialog.close()
  }

  const handleImport = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    setImportError(null)
    const result = await snapshots.importSnapshot(file)
    if (!result) {
      setImportError("Failed to import snapshot. Please check the file format.")
    }

    // Reset input
    input.value = ""
  }

  const handleEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit()
    } else if (e.key === "Escape") {
      handleCancelEdit()
    }
  }

  // Default open groups - current session if provided
  const defaultOpen = createMemo(() => {
    return props.sessionID ? [props.sessionID] : sortedGroups().slice(0, 1).map((g) => g.sessionID)
  })

  return (
    <Dialog title="Context Snapshots">
      <div data-component="snapshots-list-dialog">
        <Show when={importError()}>
          <div data-slot="snapshots-import-error">{importError()}</div>
        </Show>

        <div data-slot="snapshots-toolbar">
          <label data-slot="snapshots-import-btn">
            <Icon name="folder" size="small" />
            Import Snapshot
            <input type="file" accept=".json" onChange={handleImport} hidden />
          </label>
        </div>

        <Show
          when={hasSnapshots()}
          fallback={
            <div data-slot="snapshots-empty">
              <Icon name="archive" size="large" />
              <p>No snapshots saved yet</p>
              <p data-slot="empty-hint">Save a context snapshot to see it here</p>
            </div>
          }
        >
          <div data-slot="snapshot-groups">
            <Accordion multiple defaultValue={defaultOpen()}>
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
                      <div data-slot="snapshots-list">
                        <For each={group.snapshots}>
                          {(snapshot) => (
                            <div data-slot="snapshot-item" data-deleting={deletingId() === snapshot.id}>
                              <Show
                                when={deletingId() === snapshot.id}
                                fallback={
                                  <>
                                    <div data-slot="snapshot-item-content">
                                      <Show
                                        when={editingId() === snapshot.id}
                                        fallback={
                                          <div data-slot="snapshot-item-name">{snapshot.name}</div>
                                        }
                                      >
                                        <input
                                          data-slot="snapshot-item-name-input"
                                          type="text"
                                          value={editingName()}
                                          onInput={(e) => setEditingName(e.currentTarget.value)}
                                          onKeyDown={handleEditKeyDown}
                                          onBlur={handleSaveEdit}
                                          autofocus
                                        />
                                      </Show>
                                      <div data-slot="snapshot-item-meta">
                                        <span>{formatDate(snapshot.createdAt)}</span>
                                        <span>{snapshot.messageCount} messages</span>
                                        <span>~{snapshot.tokenEstimate.toLocaleString()} tokens</span>
                                      </div>
                                    </div>

                                    <div data-slot="snapshot-item-actions">
                                      <Show when={editingId() !== snapshot.id}>
                                        <Show when={props.onLoad}>
                                          <button
                                            data-slot="snapshot-action"
                                            data-action="load"
                                            onClick={() => handleLoad(snapshot)}
                                            title="Load snapshot"
                                          >
                                            <Icon name="enter" size="small" />
                                          </button>
                                        </Show>
                                        <button
                                          data-slot="snapshot-action"
                                          data-action="rename"
                                          onClick={() => handleStartEdit(snapshot)}
                                          title="Rename snapshot"
                                        >
                                          <Icon name="edit" size="small" />
                                        </button>
                                        <button
                                          data-slot="snapshot-action"
                                          data-action="export"
                                          onClick={() => handleExport(snapshot)}
                                          title="Export snapshot"
                                        >
                                          <Icon name="download" size="small" />
                                        </button>
                                        <button
                                          data-slot="snapshot-action"
                                          data-action="delete"
                                          onClick={() => handleStartDelete(snapshot.id)}
                                          title="Delete snapshot"
                                        >
                                          <Icon name="circle-x" size="small" />
                                        </button>
                                      </Show>
                                      <Show when={editingId() === snapshot.id}>
                                        <button
                                          data-slot="snapshot-action"
                                          data-action="save"
                                          onClick={handleSaveEdit}
                                          title="Save name"
                                        >
                                          <Icon name="check" size="small" />
                                        </button>
                                        <button
                                          data-slot="snapshot-action"
                                          data-action="cancel"
                                          onClick={handleCancelEdit}
                                          title="Cancel edit"
                                        >
                                          <Icon name="close" size="small" />
                                        </button>
                                      </Show>
                                    </div>
                                  </>
                                }
                              >
                                <div data-slot="snapshot-delete-confirm">
                                  <span>Delete "{snapshot.name}"?</span>
                                  <div data-slot="snapshot-delete-actions">
                                    <button data-slot="snapshot-delete-cancel" onClick={handleCancelDelete}>
                                      Cancel
                                    </button>
                                    <button data-slot="snapshot-delete-confirm-btn" onClick={handleConfirmDelete}>
                                      Delete
                                    </button>
                                  </div>
                                </div>
                              </Show>
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

        <div data-slot="snapshots-footer">
          <button data-slot="snapshots-close" onClick={() => dialog.close()}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
