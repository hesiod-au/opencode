import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { persisted, Persist } from "@/utils/persist"

export interface Snippet {
  id: string
  name: string
  description?: string
  template: string
  category?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  isBuiltIn: boolean
}

export interface SnippetsExport {
  version: 1
  exportedAt: string
  snippets: Snippet[]
}

interface SnippetsStore {
  snippets: Snippet[]
}

function generateId(): string {
  return `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

const BUILT_IN_SNIPPETS: Snippet[] = [
  {
    id: "builtin_focus_task",
    name: "Focus on Current Task",
    description: "Guidance to avoid scope creep",
    template:
      "Please focus only on the current task. Do not refactor unrelated code, add extra features, or make changes beyond what was explicitly requested.",
    category: "guidance",
    tags: ["focus", "scope"],
    createdAt: 0,
    updatedAt: 0,
    isBuiltIn: true,
  },
  {
    id: "builtin_explain_reasoning",
    name: "Explain Reasoning",
    description: "Request step-by-step explanation",
    template:
      "Please explain your reasoning step by step before making any changes. Walk me through your thought process and the decisions you're making.",
    category: "guidance",
    tags: ["explain", "reasoning"],
    createdAt: 0,
    updatedAt: 0,
    isBuiltIn: true,
  },
  {
    id: "builtin_list_assumptions",
    name: "List Assumptions",
    description: "Request assumptions before proceeding",
    template:
      "Before proceeding, please list all the assumptions you are making about this task. If any assumptions are incorrect, I will clarify them.",
    category: "guidance",
    tags: ["assumptions", "clarify"],
    createdAt: 0,
    updatedAt: 0,
    isBuiltIn: true,
  },
  {
    id: "builtin_summarize_changes",
    name: "Summarize Changes",
    description: "Request change summary",
    template:
      "Please provide a summary of all the changes you made, including:\n- Files modified\n- What was changed in each file\n- Any side effects or considerations to be aware of",
    category: "review",
    tags: ["summary", "changes"],
    createdAt: 0,
    updatedAt: 0,
    isBuiltIn: true,
  },
]

export interface SubstituteContext {
  date?: string
  time?: string
  session?: string
}

export function substituteVariables(template: string, context: SubstituteContext): string {
  const now = new Date()
  const defaults: Record<string, string> = {
    date: now.toLocaleDateString(),
    time: now.toLocaleTimeString(),
    session: context.session ?? "",
  }

  const merged: Record<string, string> = { ...defaults }
  if (context.date) merged.date = context.date
  if (context.time) merged.time = context.time
  if (context.session) merged.session = context.session

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => merged[key] ?? `{{${key}}}`)
}

export function useSnippets() {
  const [store, setStore, , ready] = persisted<SnippetsStore>(
    Persist.global("snippets"),
    createStore<SnippetsStore>({ snippets: [] }),
  )

  const snippets = createMemo(() => {
    const custom = [...store.snippets].sort((a, b) => b.updatedAt - a.updatedAt)
    return [...BUILT_IN_SNIPPETS, ...custom]
  })

  const customSnippets = createMemo(() => {
    return [...store.snippets].sort((a, b) => b.updatedAt - a.updatedAt)
  })

  const builtInSnippets = createMemo(() => BUILT_IN_SNIPPETS)

  const snippetsByCategory = createMemo(() => {
    const byCategory: Record<string, Snippet[]> = {}
    for (const snippet of snippets()) {
      const category = snippet.category ?? "uncategorized"
      if (!byCategory[category]) {
        byCategory[category] = []
      }
      byCategory[category].push(snippet)
    }
    return byCategory
  })

  const saveSnippet = (input: {
    name: string
    description?: string
    template: string
    category?: string
    tags?: string[]
  }): Snippet => {
    const snippet: Snippet = {
      id: generateId(),
      name: input.name,
      description: input.description,
      template: input.template,
      category: input.category,
      tags: input.tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isBuiltIn: false,
    }

    setStore("snippets", (prev) => [...prev, snippet])
    return snippet
  }

  const updateSnippet = (
    id: string,
    updates: Partial<Pick<Snippet, "name" | "description" | "template" | "category" | "tags">>,
  ) => {
    if (BUILT_IN_SNIPPETS.some((s) => s.id === id)) {
      return
    }

    setStore("snippets", (prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              ...updates,
              updatedAt: Date.now(),
            }
          : s,
      ),
    )
  }

  const deleteSnippet = (snippetId: string) => {
    if (BUILT_IN_SNIPPETS.some((s) => s.id === snippetId)) {
      return
    }
    setStore("snippets", (prev) => prev.filter((s) => s.id !== snippetId))
  }

  const getSnippet = (snippetId: string): Snippet | undefined => {
    return snippets().find((s) => s.id === snippetId)
  }

  const exportSnippets = (): void => {
    const data: SnippetsExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      snippets: customSnippets(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `snippets-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const importSnippets = async (file: File): Promise<number> => {
    try {
      const text = await file.text()
      const data = JSON.parse(text) as SnippetsExport

      if (data.version !== 1) {
        throw new Error("Unsupported snippets version")
      }

      const importedSnippets = data.snippets.map((snippet) => ({
        ...snippet,
        id: generateId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isBuiltIn: false,
      }))

      setStore("snippets", (prev) => [...prev, ...importedSnippets])
      return importedSnippets.length
    } catch {
      return 0
    }
  }

  const searchSnippets = (query: string): Snippet[] => {
    if (!query.trim()) return snippets()
    const lowerQuery = query.toLowerCase()
    return snippets().filter(
      (s) =>
        s.name.toLowerCase().includes(lowerQuery) ||
        s.description?.toLowerCase().includes(lowerQuery) ||
        s.template.toLowerCase().includes(lowerQuery) ||
        s.tags?.some((t) => t.toLowerCase().includes(lowerQuery)),
    )
  }

  return {
    snippets,
    customSnippets,
    builtInSnippets,
    snippetsByCategory,
    ready,
    saveSnippet,
    updateSnippet,
    deleteSnippet,
    getSnippet,
    exportSnippets,
    importSnippets,
    searchSnippets,
  }
}
