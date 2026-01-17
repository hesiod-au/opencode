import { createSignal, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { persisted, Persist } from "@/utils/persist"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

// Edited part content - stores the modified text/output for a part
export interface PartEdit {
  partId: string
  type: "text" | "tool-output"
  content: string
}

export interface ContextSnapshot {
  id: string
  name: string
  createdAt: number
  sessionID: string
  sessionName?: string // Display name of the session

  // Core data
  messages: Message[]
  parts: Record<string, Part[]>

  // UI state
  exclusions: string[]
  hidden: string[]
  edits: PartEdit[] // Content edits to parts

  // Metadata
  messageCount: number
  tokenEstimate: number
}

export interface SnapshotGroup {
  sessionID: string
  sessionName: string
  snapshots: ContextSnapshot[]
}

export interface ContextExport {
  version: 1
  exportedAt: string
  snapshot: ContextSnapshot
}

interface SnapshotsStore {
  snapshots: ContextSnapshot[]
}

function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function calculateSnapshotTokens(messages: Message[], parts: Record<string, Part[]>): number {
  let total = 0
  for (const msg of messages) {
    const messageParts = parts[msg.id] ?? []
    for (const part of messageParts) {
      if (part.type === "text") {
        total += estimateTokens(part.text)
      }
      if (part.type === "tool" && part.state.status === "completed") {
        total += estimateTokens(JSON.stringify(part.state.input))
        total += estimateTokens(part.state.output)
      }
      if (part.type === "tool" && part.state.status === "error") {
        total += estimateTokens(JSON.stringify(part.state.input))
        total += estimateTokens(part.state.error)
      }
    }
  }
  return total
}

export function useContextSnapshots() {
  const params = useParams()
  const directory = () => params.dir ?? ""

  const [store, setStore, , ready] = persisted<SnapshotsStore>(
    Persist.workspace(directory(), "context-snapshots"),
    createStore<SnapshotsStore>({ snapshots: [] })
  )

  const snapshots = createMemo(() => {
    return [...store.snapshots].sort((a, b) => b.createdAt - a.createdAt)
  })

  // Get snapshots for the current session only
  const snapshotsForSession = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []
    return snapshots().filter((s) => s.sessionID === sessionID)
  })

  // Get all snapshots grouped by session
  const snapshotsBySession = createMemo((): SnapshotGroup[] => {
    const groups: Record<string, SnapshotGroup> = {}

    for (const snapshot of snapshots()) {
      if (!groups[snapshot.sessionID]) {
        groups[snapshot.sessionID] = {
          sessionID: snapshot.sessionID,
          sessionName: snapshot.sessionName ?? snapshot.sessionID.slice(0, 8),
          snapshots: [],
        }
      }
      groups[snapshot.sessionID].snapshots.push(snapshot)
      // Update session name if this snapshot has one (use most recent)
      if (snapshot.sessionName) {
        groups[snapshot.sessionID].sessionName = snapshot.sessionName
      }
    }

    // Sort groups by most recent snapshot
    return Object.values(groups).sort((a, b) => {
      const aLatest = a.snapshots[0]?.createdAt ?? 0
      const bLatest = b.snapshots[0]?.createdAt ?? 0
      return bLatest - aLatest
    })
  })

  const saveSnapshot = (input: {
    name: string
    sessionID: string
    sessionName?: string
    messages: Message[]
    parts: Record<string, Part[]>
    exclusions: string[]
    hidden: string[]
    edits: PartEdit[]
  }): ContextSnapshot => {
    const snapshot: ContextSnapshot = {
      id: generateId(),
      name: input.name,
      createdAt: Date.now(),
      sessionID: input.sessionID,
      sessionName: input.sessionName,
      messages: JSON.parse(JSON.stringify(input.messages)),
      parts: JSON.parse(JSON.stringify(input.parts)),
      exclusions: [...input.exclusions],
      hidden: [...input.hidden],
      edits: [...input.edits],
      messageCount: input.messages.length,
      tokenEstimate: calculateSnapshotTokens(input.messages, input.parts),
    }

    setStore("snapshots", (prev) => [...prev, snapshot])
    return snapshot
  }

  const deleteSnapshot = (snapshotId: string) => {
    setStore("snapshots", (prev) => prev.filter((s) => s.id !== snapshotId))
  }

  const renameSnapshot = (snapshotId: string, newName: string) => {
    setStore("snapshots", (prev) =>
      prev.map((s) => (s.id === snapshotId ? { ...s, name: newName } : s))
    )
  }

  const getSnapshot = (snapshotId: string): ContextSnapshot | undefined => {
    return store.snapshots.find((s) => s.id === snapshotId)
  }

  const exportSnapshot = (snapshot: ContextSnapshot): void => {
    const data: ContextExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      snapshot,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `context-snapshot-${snapshot.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const importSnapshot = async (file: File): Promise<ContextSnapshot | null> => {
    try {
      const text = await file.text()
      const data = JSON.parse(text) as ContextExport

      if (data.version !== 1) {
        throw new Error("Unsupported snapshot version")
      }

      const snapshot: ContextSnapshot = {
        ...data.snapshot,
        id: generateId(),
        createdAt: Date.now(),
      }

      setStore("snapshots", (prev) => [...prev, snapshot])
      return snapshot
    } catch {
      return null
    }
  }

  return {
    snapshots,
    snapshotsForSession,
    snapshotsBySession,
    ready,
    saveSnapshot,
    deleteSnapshot,
    renameSnapshot,
    getSnapshot,
    exportSnapshot,
    importSnapshot,
  }
}
