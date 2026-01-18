import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { persisted, Persist } from "@/utils/persist"
import type { Message, Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2/client"

export interface ArchivedItem {
  id: string
  partId: string
  sessionId: string
  sessionName?: string
  type: "text" | "tool" | "reasoning" | "file"
  content: string
  archivedAt: number
  metadata: {
    messageId: string
    messageRole: "user" | "assistant"
    toolName?: string
    toolStatus?: "completed" | "error"
  }
}

interface ArchiveStore {
  items: ArchivedItem[]
}

function generateId(): string {
  return `archive_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function extractPartContent(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text
    case "reasoning":
      return part.text
    case "tool": {
      const toolPart = part as ToolPart
      if (toolPart.state.status === "completed") {
        return (toolPart.state as ToolStateCompleted).output ?? ""
      }
      if (toolPart.state.status === "error") {
        return toolPart.state.error ?? ""
      }
      return ""
    }
    case "file":
      return `File: ${part.filename ?? part.url}`
    default:
      return ""
  }
}

function getPartType(part: Part): ArchivedItem["type"] {
  switch (part.type) {
    case "text":
      return "text"
    case "reasoning":
      return "reasoning"
    case "tool":
      return "tool"
    case "file":
      return "file"
    default:
      return "text"
  }
}

export interface ArchiveInput {
  part: Part
  message: Message
  sessionId: string
  sessionName?: string
}

export function useArchive(workspaceDir: string) {
  const [store, setStore, , ready] = persisted<ArchiveStore>(
    Persist.workspace(workspaceDir, "archive"),
    createStore<ArchiveStore>({ items: [] }),
  )

  const items = createMemo(() => {
    return [...store.items].sort((a, b) => b.archivedAt - a.archivedAt)
  })

  const addManyToArchive = (inputs: ArchiveInput[]) => {
    const newItems: ArchivedItem[] = inputs.map((input) => {
      const toolPart = input.part.type === "tool" ? (input.part as ToolPart) : undefined
      return {
        id: generateId(),
        partId: input.part.id,
        sessionId: input.sessionId,
        sessionName: input.sessionName,
        type: getPartType(input.part),
        content: extractPartContent(input.part),
        archivedAt: Date.now(),
        metadata: {
          messageId: input.part.messageID,
          messageRole: input.message.role,
          toolName: toolPart?.tool,
          toolStatus: toolPart?.state.status === "completed" ? "completed" : toolPart?.state.status === "error" ? "error" : undefined,
        },
      }
    })

    setStore("items", (prev) => [...prev, ...newItems])
    return newItems
  }

  const removeFromArchive = (id: string) => {
    setStore("items", (prev) => prev.filter((item) => item.id !== id))
  }

  const clearArchive = () => {
    setStore("items", [])
  }

  const searchArchive = (query: string): ArchivedItem[] => {
    if (!query.trim()) return items()
    const lowerQuery = query.toLowerCase()
    return items().filter(
      (item) =>
        item.content.toLowerCase().includes(lowerQuery) ||
        item.type.toLowerCase().includes(lowerQuery) ||
        item.metadata.toolName?.toLowerCase().includes(lowerQuery) ||
        item.sessionName?.toLowerCase().includes(lowerQuery),
    )
  }

  return {
    items,
    ready,
    addManyToArchive,
    removeFromArchive,
    clearArchive,
    searchArchive,
  }
}
