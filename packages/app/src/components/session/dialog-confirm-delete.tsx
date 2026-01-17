import { createSignal, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"

export interface DialogConfirmDeleteProps {
  title: string
  description: string
  itemType: "part" | "message"
  onConfirm: () => Promise<void>
  onCancel?: () => void
}

export function DialogConfirmDelete(props: DialogConfirmDeleteProps) {
  const dialog = useDialog()
  const [deleting, setDeleting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const handleConfirm = async () => {
    setDeleting(true)
    setError(null)

    try {
      await props.onConfirm()
      dialog.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  const handleCancel = () => {
    props.onCancel?.()
    dialog.close()
  }

  return (
    <Dialog title={props.title}>
      <div data-component="confirm-delete-dialog">
        <div data-slot="confirm-delete-icon">
          <Icon name="circle-ban-sign" size="large" />
        </div>

        <div data-slot="confirm-delete-content">
          <p data-slot="confirm-delete-description">{props.description}</p>
          <p data-slot="confirm-delete-warning">This action cannot be undone.</p>
        </div>

        <Show when={error()}>
          <div data-slot="confirm-delete-error">{error()}</div>
        </Show>

        <div data-slot="confirm-delete-actions">
          <button data-slot="confirm-delete-cancel" onClick={handleCancel} disabled={deleting()}>
            Cancel
          </button>
          <button
            data-slot="confirm-delete-confirm"
            onClick={handleConfirm}
            disabled={deleting()}
          >
            {deleting() ? "Deleting..." : `Delete ${props.itemType}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
