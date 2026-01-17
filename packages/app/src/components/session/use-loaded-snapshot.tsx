import { createSignal, createContext, useContext, type ParentProps, type Accessor, type Setter } from "solid-js"
import type { ContextSnapshot, PartEdit } from "./use-context-snapshots"
import type { Message, Part, TextPart, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2/client"

export interface MessageWithParts {
  info: Message
  parts: Part[]
}

interface LoadedSnapshotContextValue {
  snapshot: Accessor<ContextSnapshot | null>
  setSnapshot: (snapshot: ContextSnapshot | null) => void
  isLoaded: () => boolean
  snapshotName: () => string
  clear: () => void

  // Exclusion management - tracked separately so user can modify after loading
  excluded: Accessor<Set<string>>
  setExcluded: Setter<Set<string>>

  // Content edits - tracked separately so user can modify after loading
  edits: Accessor<Map<string, PartEdit>>
  setEdit: (edit: PartEdit) => void
  removeEdit: (partId: string) => void
  getEdit: (partId: string) => PartEdit | undefined
  getEditsArray: () => PartEdit[]

  // Check if there are any pending changes (exclusions or edits)
  hasChanges: () => boolean

  // Build messages array for prompt submission (applies exclusions and edits)
  getMessagesForPrompt: (liveMessages: Message[], liveParts: Record<string, Part[]>) => MessageWithParts[] | undefined
}

const LoadedSnapshotContext = createContext<LoadedSnapshotContextValue>()

export function LoadedSnapshotProvider(props: ParentProps) {
  const [snapshot, setSnapshot] = createSignal<ContextSnapshot | null>(null)
  const [excluded, setExcluded] = createSignal<Set<string>>(new Set())
  const [edits, setEdits] = createSignal<Map<string, PartEdit>>(new Map())

  const isLoaded = () => snapshot() !== null
  const snapshotName = () => snapshot()?.name ?? ""

  const clear = () => {
    setSnapshot(null)
    setExcluded(new Set<string>())
    setEdits(new Map<string, PartEdit>())
  }

  const setEdit = (edit: PartEdit) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(edit.partId, edit)
      return next
    })
  }

  const removeEdit = (partId: string) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.delete(partId)
      return next
    })
  }

  const getEdit = (partId: string): PartEdit | undefined => {
    return edits().get(partId)
  }

  const getEditsArray = (): PartEdit[] => {
    return Array.from(edits().values())
  }

  const hasChanges = () => {
    return excluded().size > 0 || edits().size > 0
  }

  // Apply an edit to a part, returning the modified part
  const applyEdit = (part: Part, edit: PartEdit): Part => {
    if (edit.type === "text" && part.type === "text") {
      return { ...part, text: edit.content } as TextPart
    }
    if (edit.type === "tool-output" && part.type === "tool") {
      const toolPart = part as ToolPart
      if (toolPart.state.status === "completed") {
        return {
          ...toolPart,
          state: {
            ...(toolPart.state as ToolStateCompleted),
            output: edit.content,
          },
        } as ToolPart
      }
    }
    return part
  }

  // Build messages array for prompt submission
  // Returns undefined if no override is needed (use server's messages)
  const getMessagesForPrompt = (
    liveMessages: Message[],
    liveParts: Record<string, Part[]>,
  ): MessageWithParts[] | undefined => {
    const snap = snapshot()
    const excl = excluded()
    const eds = edits()

    // If no snapshot loaded and no changes, let server handle it
    if (!snap && excl.size === 0 && eds.size === 0) {
      return undefined
    }

    // Determine source messages and parts
    const sourceMessages = snap ? snap.messages : liveMessages
    const sourceParts = snap ? snap.parts : liveParts

    // Apply exclusions and edits
    return sourceMessages.map((msg) => {
      const msgParts = sourceParts[msg.id] ?? []
      const processedParts = msgParts
        .filter((part) => !excl.has(part.id))
        .map((part) => {
          const edit = eds.get(part.id)
          if (edit) {
            return applyEdit(part, edit)
          }
          return part
        })

      return {
        info: msg,
        parts: processedParts,
      }
    })
  }

  const value: LoadedSnapshotContextValue = {
    snapshot,
    setSnapshot,
    isLoaded,
    snapshotName,
    clear,
    excluded,
    setExcluded,
    edits,
    setEdit,
    removeEdit,
    getEdit,
    getEditsArray,
    hasChanges,
    getMessagesForPrompt,
  }

  return <LoadedSnapshotContext.Provider value={value}>{props.children}</LoadedSnapshotContext.Provider>
}

export function useLoadedSnapshot() {
  const ctx = useContext(LoadedSnapshotContext)
  if (!ctx) {
    throw new Error("useLoadedSnapshot must be used within LoadedSnapshotProvider")
  }
  return ctx
}
