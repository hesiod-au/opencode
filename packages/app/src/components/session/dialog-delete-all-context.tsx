import { createSignal, createMemo, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"

type Step = "confirm" | "verify"

export interface DialogDeleteAllContextProps {
  sessionName: string
  messageCount: number
  onConfirm: () => Promise<void>
  onSaveSnapshot?: () => void
}

export function DialogDeleteAllContext(props: DialogDeleteAllContextProps) {
  const dialog = useDialog()
  const [step, setStep] = createSignal<Step>("confirm")
  const [confirmText, setConfirmText] = createSignal("")
  const [deleting, setDeleting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const expectedText = createMemo(() => props.sessionName.slice(0, 20))

  const isConfirmValid = createMemo(() => {
    return confirmText().toLowerCase() === expectedText().toLowerCase()
  })

  const handleProceed = () => {
    setStep("verify")
  }

  const handleDelete = async () => {
    if (!isConfirmValid()) return

    setDeleting(true)
    setError(null)

    try {
      await props.onConfirm()
      dialog.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete context")
    } finally {
      setDeleting(false)
    }
  }

  const handleSaveSnapshot = () => {
    props.onSaveSnapshot?.()
  }

  const handleCancel = () => {
    if (step() === "verify") {
      setStep("confirm")
      setConfirmText("")
      return
    }
    dialog.close()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && isConfirmValid() && !deleting()) {
      handleDelete()
    }
  }

  return (
    <Dialog title="Delete All Context">
      <div data-component="delete-all-context-dialog">
        <div data-slot="delete-all-icon">
          <Icon name="circle-ban-sign" size="large" />
        </div>

        <Show when={step() === "confirm"}>
          <div data-slot="delete-all-content">
            <p data-slot="delete-all-title">Are you sure you want to delete all context?</p>
            <p data-slot="delete-all-description">
              This will permanently remove {props.messageCount} messages from this session.
            </p>
            <p data-slot="delete-all-warning">This action cannot be undone.</p>
          </div>

          <Show when={props.onSaveSnapshot}>
            <div data-slot="delete-all-save-option">
              <Icon name="archive" size="small" />
              <span>Consider saving a snapshot before deleting</span>
              <button data-slot="save-snapshot-link" onClick={handleSaveSnapshot}>
                Save Snapshot
              </button>
            </div>
          </Show>

          <div data-slot="delete-all-actions">
            <button data-slot="delete-all-cancel" onClick={handleCancel}>
              Cancel
            </button>
            <button data-slot="delete-all-proceed" onClick={handleProceed}>
              Continue
            </button>
          </div>
        </Show>

        <Show when={step() === "verify"}>
          <div data-slot="delete-all-content">
            <p data-slot="delete-all-title">Final Confirmation</p>
            <p data-slot="delete-all-description">
              Type <strong>{expectedText()}</strong> to confirm deletion.
            </p>
          </div>

          <Show when={error()}>
            <div data-slot="delete-all-error">{error()}</div>
          </Show>

          <div data-slot="delete-all-field">
            <input
              data-slot="delete-all-input"
              type="text"
              value={confirmText()}
              onInput={(e) => setConfirmText(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Type "${expectedText()}" to confirm`}
              autofocus
            />
          </div>

          <div data-slot="delete-all-actions">
            <button data-slot="delete-all-cancel" onClick={handleCancel} disabled={deleting()}>
              Go Back
            </button>
            <button data-slot="delete-all-confirm" onClick={handleDelete} disabled={deleting() || !isConfirmValid()}>
              {deleting() ? "Deleting..." : "Delete All Context"}
            </button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
