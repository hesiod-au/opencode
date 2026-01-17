import { createSignal, createContext, useContext, type ParentProps } from "solid-js"
import { showToast, toaster } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import type { Part } from "@opencode-ai/sdk/v2/client"

const UNDO_TIMEOUT_MS = 5000

interface PendingDeletion {
  part: Part
  toastId: number
  timeoutId: ReturnType<typeof setTimeout>
}

interface PendingDeletionsContextValue {
  isPending: (partId: string) => boolean
  deletePart: (part: Part, sessionID: string) => void
  cancelDeletion: (partId: string) => void
  cancelAllDeletions: () => void
}

const PendingDeletionsContext = createContext<PendingDeletionsContextValue>()

export function PendingDeletionsProvider(props: ParentProps) {
  const sdk = useSDK()
  const [pending, setPending] = createSignal<Map<string, PendingDeletion>>(new Map())

  const isPending = (partId: string) => pending().has(partId)

  const confirmDeletion = async (part: Part, sessionID: string) => {
    try {
      await sdk.client.part.delete({
        sessionID,
        messageID: part.messageID,
        partID: part.id,
      })
    } catch (err) {
      showToast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Failed to delete",
        variant: "error",
      })
    } finally {
      setPending((prev) => {
        const next = new Map(prev)
        next.delete(part.id)
        return next
      })
    }
  }

  const cancelDeletion = (partId: string) => {
    const deletion = pending().get(partId)
    if (!deletion) return

    clearTimeout(deletion.timeoutId)
    toaster.dismiss(deletion.toastId)

    setPending((prev) => {
      const next = new Map(prev)
      next.delete(partId)
      return next
    })

    showToast({
      description: "Deletion cancelled",
      duration: 2000,
    })
  }

  const cancelAllDeletions = () => {
    const current = pending()
    if (current.size === 0) return

    for (const deletion of current.values()) {
      clearTimeout(deletion.timeoutId)
      toaster.dismiss(deletion.toastId)
    }

    setPending(new Map())
  }

  const deletePart = (part: Part, sessionID: string) => {
    // If already pending, don't add again
    if (pending().has(part.id)) return

    // Set up timeout to confirm deletion
    const timeoutId = setTimeout(() => {
      confirmDeletion(part, sessionID)
    }, UNDO_TIMEOUT_MS)

    // Show toast with undo action
    const toastId = showToast({
      title: "Part deleted",
      description: "Click undo to restore",
      duration: UNDO_TIMEOUT_MS,
      actions: [
        {
          label: "Undo",
          onClick: () => cancelDeletion(part.id),
        },
      ],
    })

    // Add to pending deletions
    setPending((prev) => {
      const next = new Map(prev)
      next.set(part.id, { part, toastId, timeoutId })
      return next
    })
  }

  const value: PendingDeletionsContextValue = {
    isPending,
    deletePart,
    cancelDeletion,
    cancelAllDeletions,
  }

  return (
    <PendingDeletionsContext.Provider value={value}>
      {props.children}
    </PendingDeletionsContext.Provider>
  )
}

export function usePendingDeletions() {
  const ctx = useContext(PendingDeletionsContext)
  if (!ctx) {
    throw new Error("usePendingDeletions must be used within PendingDeletionsProvider")
  }
  return ctx
}
