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
  // Optional forceInclusions parameter for three-state canonical context
  // Optional additionalExclusions parameter for canonical context exclusions
  // Optional forceOverride to always return override (e.g., when re-including previously excluded content)
  getMessagesForPrompt: (
    liveMessages: Message[],
    liveParts: Record<string, Part[]>,
    forceInclusions?: Set<string>,
    additionalExclusions?: Set<string>,
    forceOverride?: boolean,
  ) => MessageWithParts[] | undefined
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
  // forceInclusions: Set of part IDs that should always be included (even if not in server messages)
  // additionalExclusions: Set of part IDs to exclude (from canonical context)
  // forceOverride: Always return override even if no changes (e.g., re-including previously excluded content)
  const getMessagesForPrompt = (
    liveMessages: Message[],
    liveParts: Record<string, Part[]>,
    forceInclusions?: Set<string>,
    additionalExclusions?: Set<string>,
    forceOverride?: boolean,
  ): MessageWithParts[] | undefined => {
    const snap = snapshot()
    const excl = excluded()
    const eds = edits()
    const hasForceInclusions = forceInclusions && forceInclusions.size > 0
    const hasAdditionalExclusions = additionalExclusions && additionalExclusions.size > 0

    // If no snapshot loaded and no changes and no force inclusions/exclusions and not forced, let server handle it
    if (
      !snap &&
      excl.size === 0 &&
      eds.size === 0 &&
      !hasForceInclusions &&
      !hasAdditionalExclusions &&
      !forceOverride
    ) {
      return undefined
    }

    // Determine source messages and parts
    const sourceMessages = snap ? snap.messages : liveMessages
    const sourceParts = snap ? snap.parts : liveParts

    // Part types that are not selectable/excludable and should be filtered when
    // a message is effectively excluded (all selectable parts excluded)
    const nonSelectableTypes = new Set(["step-start", "snapshot", "patch", "agent"])

    // Apply exclusions and edits
    return sourceMessages.map((msg) => {
      const msgParts = sourceParts[msg.id] ?? []
      const processedParts = msgParts
        .filter((part) => {
          // If force included, always keep
          if (forceInclusions?.has(part.id)) return true
          // Filter out excluded (from both snapshot exclusions and additional exclusions)
          if (excl.has(part.id)) return false
          if (additionalExclusions?.has(part.id)) return false
          return true
        })
        .map((part) => {
          const edit = eds.get(part.id)
          if (edit) {
            return applyEdit(part, edit)
          }
          return part
        })

      // Check if any content parts remain (non-metadata parts)
      // If only non-selectable metadata parts remain, the message has no real content
      const hasContentParts = processedParts.some((p) => !nonSelectableTypes.has(p.type))
      // If no content parts remain, filter out metadata parts too (they're meaningless without content)
      const finalParts = hasContentParts ? processedParts : []

      return {
        info: msg,
        parts: finalParts,
      }
    })
    // Don't filter out messages with 0 parts - server needs them to mark their parts as excluded
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
