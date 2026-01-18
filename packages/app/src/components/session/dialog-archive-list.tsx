import { createSignal, Show, For, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useArchive, type ArchivedItem } from "./use-archive"
import { DialogSnippetEditor } from "./dialog-snippet-editor"
import { showToast } from "@opencode-ai/ui/toast"

export interface DialogArchiveListProps {
  workspaceDir: string
}

export function DialogArchiveList(props: DialogArchiveListProps) {
  const dialog = useDialog()
  const archive = useArchive(props.workspaceDir)
  const [deletingId, setDeletingId] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [clearConfirm, setClearConfirm] = createSignal(false)

  const filteredItems = createMemo(() => archive.searchArchive(searchQuery()))

  const formatDate = (timestamp: number) => {
    return DateTime.fromMillis(timestamp).toRelative() ?? DateTime.fromMillis(timestamp).toLocaleString(DateTime.DATETIME_MED)
  }

  const truncateContent = (content: string, maxLength = 100) => {
    if (content.length <= maxLength) return content
    return content.slice(0, maxLength) + "..."
  }

  const getTypeIcon = (type: ArchivedItem["type"]) => {
    switch (type) {
      case "text":
        return "speech-bubble" as const
      case "tool":
        return "console" as const
      case "reasoning":
        return "brain" as const
      case "file":
        return "folder" as const
      default:
        return "code" as const
    }
  }

  const getTypeBadgeClass = (type: ArchivedItem["type"]) => {
    switch (type) {
      case "text":
        return "text"
      case "tool":
        return "tool"
      case "reasoning":
        return "reasoning"
      case "file":
        return "file"
      default:
        return "text"
    }
  }

  const handleSaveAsSnippet = (item: ArchivedItem) => {
    const snippetName = item.type === "tool" && item.metadata.toolName ? `${item.metadata.toolName} output` : `Archived ${item.type}`

    dialog.show(() => (
      <DialogSnippetEditor
        snippet={{
          id: "",
          name: snippetName,
          description: `Archived from session on ${DateTime.fromMillis(item.archivedAt).toLocaleString(DateTime.DATETIME_MED)}`,
          template: item.content,
          category: "archived",
          tags: [item.type, item.metadata.messageRole],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isBuiltIn: false,
        }}
      />
    ))
  }

  const handleStartDelete = (id: string) => {
    setDeletingId(id)
  }

  const handleConfirmDelete = () => {
    const id = deletingId()
    if (!id) return

    archive.removeFromArchive(id)
    setDeletingId(null)
    showToast({
      title: "Item deleted",
      description: "The archived item has been removed.",
    })
  }

  const handleCancelDelete = () => {
    setDeletingId(null)
  }

  const handleStartClearAll = () => {
    setClearConfirm(true)
  }

  const handleConfirmClearAll = () => {
    archive.clearArchive()
    setClearConfirm(false)
    showToast({
      title: "Archive cleared",
      description: "All archived items have been removed.",
    })
  }

  const handleCancelClearAll = () => {
    setClearConfirm(false)
  }

  return (
    <Dialog title="Archived Items">
      <div data-component="archive-list-dialog">
        <div data-slot="archive-search">
          <Icon name="magnifying-glass" size="small" />
          <input
            data-slot="archive-search-input"
            type="text"
            placeholder="Search archived items..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
          <Show when={searchQuery()}>
            <button data-slot="archive-search-clear" onClick={() => setSearchQuery("")}>
              <Icon name="circle-x" size="small" />
            </button>
          </Show>
        </div>

        <div data-slot="archive-toolbar">
          <span data-slot="archive-count">
            {filteredItems().length} item{filteredItems().length !== 1 ? "s" : ""}
            <Show when={searchQuery()}> matching "{searchQuery()}"</Show>
          </span>
          <Show when={archive.items().length > 0}>
            <Show
              when={!clearConfirm()}
              fallback={
                <div data-slot="archive-clear-confirm">
                  <span>Clear all items?</span>
                  <button data-slot="archive-clear-cancel" onClick={handleCancelClearAll}>
                    Cancel
                  </button>
                  <button data-slot="archive-clear-confirm-btn" onClick={handleConfirmClearAll}>
                    Clear All
                  </button>
                </div>
              }
            >
              <button data-slot="archive-toolbar-btn" onClick={handleStartClearAll}>
                <Icon name="circle-x" size="small" />
                Clear All
              </button>
            </Show>
          </Show>
        </div>

        <Show
          when={filteredItems().length > 0}
          fallback={
            <div data-slot="archive-empty">
              <Icon name="archive" size="large" />
              <p>
                <Show when={searchQuery()} fallback="No archived items yet">
                  No items match your search
                </Show>
              </p>
              <p data-slot="empty-hint">
                <Show when={searchQuery()} fallback="Excluded parts will be saved here when you submit a prompt">
                  Try a different search term
                </Show>
              </p>
            </div>
          }
        >
          <div data-slot="archive-list">
            <For each={filteredItems()}>
              {(item) => (
                <div data-slot="archive-item" data-deleting={deletingId() === item.id}>
                  <Show
                    when={deletingId() === item.id}
                    fallback={
                      <>
                        <div data-slot="archive-item-header">
                          <div data-slot="archive-item-badges">
                            <span data-slot="archive-type-badge" data-type={getTypeBadgeClass(item.type)}>
                              <Icon name={getTypeIcon(item.type)} size="small" />
                              {item.type}
                            </span>
                            <span data-slot="archive-role-badge" data-role={item.metadata.messageRole}>
                              {item.metadata.messageRole}
                            </span>
                            <Show when={item.metadata.toolName}>
                              <span data-slot="archive-tool-badge">{item.metadata.toolName}</span>
                            </Show>
                            <Show when={item.metadata.toolStatus === "error"}>
                              <span data-slot="archive-error-badge">error</span>
                            </Show>
                          </div>
                          <span data-slot="archive-item-time">{formatDate(item.archivedAt)}</span>
                        </div>

                        <div data-slot="archive-item-content">
                          <pre data-slot="archive-item-preview">{truncateContent(item.content, 200)}</pre>
                        </div>

                        <Show when={item.sessionName}>
                          <div data-slot="archive-item-session">From: {item.sessionName}</div>
                        </Show>

                        <div data-slot="archive-item-actions">
                          <button
                            data-slot="archive-action"
                            data-action="save"
                            onClick={() => handleSaveAsSnippet(item)}
                            title="Save as snippet"
                          >
                            <Icon name="code" size="small" />
                            Save as Snippet
                          </button>
                          <button
                            data-slot="archive-action"
                            data-action="delete"
                            onClick={() => handleStartDelete(item.id)}
                            title="Delete item"
                          >
                            <Icon name="circle-x" size="small" />
                          </button>
                        </div>
                      </>
                    }
                  >
                    <div data-slot="archive-delete-confirm">
                      <span>Delete this archived item?</span>
                      <div data-slot="archive-delete-actions">
                        <button data-slot="archive-delete-cancel" onClick={handleCancelDelete}>
                          Cancel
                        </button>
                        <button data-slot="archive-delete-confirm-btn" onClick={handleConfirmDelete}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div data-slot="archive-footer">
          <button data-slot="archive-close" onClick={() => dialog.close()}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
