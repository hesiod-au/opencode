import { createSignal, Show, For } from "solid-js"
import { DateTime } from "luxon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useSnippets, type Snippet } from "./use-snippets"
import { DialogSnippetEditor } from "./dialog-snippet-editor"
import { showToast } from "@opencode-ai/ui/toast"

export function DialogSnippetsList() {
  const dialog = useDialog()
  const snippets = useSnippets()
  const [deletingId, setDeletingId] = createSignal<string | null>(null)
  const [importError, setImportError] = createSignal<string | null>(null)

  const formatDate = (timestamp: number) => {
    if (timestamp === 0) return "Built-in"
    return DateTime.fromMillis(timestamp).toLocaleString(DateTime.DATETIME_MED)
  }

  const handleEdit = (snippet: Snippet) => {
    dialog.show(() => <DialogSnippetEditor snippet={snippet} />)
  }

  const handleStartDelete = (snippetId: string) => {
    setDeletingId(snippetId)
  }

  const handleConfirmDelete = () => {
    const id = deletingId()
    if (!id) return

    snippets.deleteSnippet(id)
    setDeletingId(null)
    showToast({
      title: "Snippet deleted",
      description: "The snippet has been removed.",
    })
  }

  const handleCancelDelete = () => {
    setDeletingId(null)
  }

  const handleExport = () => {
    snippets.exportSnippets()
    showToast({
      title: "Snippets exported",
      description: "Your custom snippets have been downloaded.",
    })
  }

  const handleImport = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    setImportError(null)
    const count = await snippets.importSnippets(file)
    if (count === 0) {
      setImportError("Failed to import snippets. Please check the file format.")
    } else {
      showToast({
        title: "Snippets imported",
        description: `Successfully imported ${count} snippet${count > 1 ? "s" : ""}.`,
      })
    }

    input.value = ""
  }

  const handleCreateNew = () => {
    dialog.show(() => <DialogSnippetEditor />)
  }

  return (
    <Dialog title="Manage Snippets">
      <div data-component="snippets-list-dialog">
        <Show when={importError()}>
          <div data-slot="snippets-import-error">{importError()}</div>
        </Show>

        <div data-slot="snippets-toolbar">
          <button data-slot="snippets-toolbar-btn" onClick={handleCreateNew}>
            <Icon name="plus-small" size="small" />
            New Snippet
          </button>
          <label data-slot="snippets-toolbar-btn">
            <Icon name="folder" size="small" />
            Import
            <input type="file" accept=".json" onChange={handleImport} hidden />
          </label>
          <Show when={snippets.customSnippets().length > 0}>
            <button data-slot="snippets-toolbar-btn" onClick={handleExport}>
              <Icon name="download" size="small" />
              Export All
            </button>
          </Show>
        </div>

        <Show when={snippets.customSnippets().length > 0}>
          <div data-slot="snippets-section">
            <div data-slot="snippets-section-header">Custom Snippets</div>
            <div data-slot="snippets-list">
              <For each={snippets.customSnippets()}>
                {(snippet) => (
                  <div data-slot="snippet-item" data-deleting={deletingId() === snippet.id}>
                    <Show
                      when={deletingId() === snippet.id}
                      fallback={
                        <>
                          <div data-slot="snippet-item-content">
                            <div data-slot="snippet-item-name">{snippet.name}</div>
                            <div data-slot="snippet-item-meta">
                              <span>{formatDate(snippet.updatedAt)}</span>
                              <Show when={snippet.category}>
                                <span>{snippet.category}</span>
                              </Show>
                            </div>
                          </div>

                          <div data-slot="snippet-item-actions">
                            <button
                              data-slot="snippet-action"
                              data-action="edit"
                              onClick={() => handleEdit(snippet)}
                              title="Edit snippet"
                            >
                              <Icon name="edit" size="small" />
                            </button>
                            <button
                              data-slot="snippet-action"
                              data-action="delete"
                              onClick={() => handleStartDelete(snippet.id)}
                              title="Delete snippet"
                            >
                              <Icon name="circle-x" size="small" />
                            </button>
                          </div>
                        </>
                      }
                    >
                      <div data-slot="snippet-delete-confirm">
                        <span>Delete "{snippet.name}"?</span>
                        <div data-slot="snippet-delete-actions">
                          <button data-slot="snippet-delete-cancel" onClick={handleCancelDelete}>
                            Cancel
                          </button>
                          <button data-slot="snippet-delete-confirm-btn" onClick={handleConfirmDelete}>
                            Delete
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div data-slot="snippets-section">
          <div data-slot="snippets-section-header">Built-in Snippets</div>
          <div data-slot="snippets-list">
            <For each={snippets.builtInSnippets()}>
              {(snippet) => (
                <div data-slot="snippet-item" data-builtin>
                  <div data-slot="snippet-item-content">
                    <div data-slot="snippet-item-header">
                      <span data-slot="snippet-item-name">{snippet.name}</span>
                      <span data-slot="snippet-builtin-badge">read-only</span>
                    </div>
                    <Show when={snippet.description}>
                      <div data-slot="snippet-item-description">{snippet.description}</div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>

        <Show when={snippets.customSnippets().length === 0}>
          <div data-slot="snippets-empty">
            <Icon name="code" size="large" />
            <p>No custom snippets yet</p>
            <p data-slot="empty-hint">Create a snippet or import from a file</p>
          </div>
        </Show>

        <div data-slot="snippets-footer">
          <button data-slot="snippets-close" onClick={() => dialog.close()}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
