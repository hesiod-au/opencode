import { createSignal, createMemo, Show, For, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useSnippets, substituteVariables, type Snippet } from "./use-snippets"
import { usePrompt, type Prompt } from "@/context/prompt"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogSnippetEditor } from "./dialog-snippet-editor"
import { DialogSnippetsList } from "./dialog-snippets-list"

export interface DialogSnippetsPickerProps {
  sessionID: string
}

export function DialogSnippetsPicker(props: DialogSnippetsPickerProps) {
  const dialog = useDialog()
  const prompt = usePrompt()
  const snippetsHook = useSnippets()

  const [search, setSearch] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [previewSnippet, setPreviewSnippet] = createSignal<Snippet | null>(null)
  let searchInputRef!: HTMLInputElement
  let listRef!: HTMLDivElement

  const filteredSnippets = createMemo(() => {
    return snippetsHook.searchSnippets(search())
  })

  const groupedSnippets = createMemo(() => {
    const all = filteredSnippets()
    const groups: Record<string, Snippet[]> = {}
    for (const snippet of all) {
      const category = snippet.category ?? "uncategorized"
      if (!groups[category]) groups[category] = []
      groups[category].push(snippet)
    }
    return groups
  })

  const flatSnippets = createMemo(() => filteredSnippets())

  onMount(() => {
    searchInputRef?.focus()
  })

  const scrollSelectedIntoView = () => {
    if (!listRef) return
    const selected = listRef.querySelector("[data-selected='true']")
    selected?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const snippets = flatSnippets()
    if (snippets.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % snippets.length)
      requestAnimationFrame(scrollSelectedIntoView)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + snippets.length) % snippets.length)
      requestAnimationFrame(scrollSelectedIntoView)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const snippet = snippets[selectedIndex()]
      if (snippet) handleInsertSnippet(snippet)
    } else if (e.key === "Escape") {
      e.preventDefault()
      dialog.close()
    }
  }

  const getSnippetText = (snippet: Snippet): string => {
    const context = {
      date: new Date().toLocaleDateString(),
      time: new Date().toLocaleTimeString(),
      session: props.sessionID,
    }
    return substituteVariables(snippet.template, context)
  }

  const handleInsertSnippet = (snippet: Snippet) => {
    const text = getSnippetText(snippet)

    // Get current prompt and append the snippet text
    const currentPrompt = prompt.current()
    const currentText = currentPrompt
      .filter((p) => p.type === "text")
      .map((p) => ("content" in p ? p.content : ""))
      .join("")

    // Create new text content with snippet appended
    const newText = currentText.trim() ? `${currentText}\n\n${text}` : text
    const newPrompt: Prompt = [
      { type: "text", content: newText, start: 0, end: newText.length },
      ...currentPrompt.filter((p) => p.type !== "text"),
    ]

    prompt.set(newPrompt, newText.length)

    showToast({
      title: "Snippet inserted",
      description: `"${snippet.name}" added to prompt`,
    })
    dialog.close()
  }

  const handleCopySnippet = async (snippet: Snippet) => {
    const text = getSnippetText(snippet)

    try {
      await navigator.clipboard.writeText(text)
      showToast({
        title: "Copied to clipboard",
        description: `"${snippet.name}" copied`,
      })
    } catch {
      showToast({
        title: "Failed to copy",
        description: "Could not access clipboard",
      })
    }
  }

  const handleOpenEditor = () => {
    dialog.show(() => <DialogSnippetEditor onSave={() => dialog.close()} />)
  }

  const handleOpenManage = () => {
    dialog.show(() => <DialogSnippetsList />)
  }

  return (
    <Dialog title="Snippets">
      <div data-component="snippets-picker">
        <div data-slot="snippets-search-bar">
          <Icon name="magnifying-glass" size="small" class="text-icon-weak" />
          <input
            ref={searchInputRef}
            data-slot="snippets-search-input"
            type="text"
            placeholder="Search snippets..."
            value={search()}
            onInput={(e) => {
              setSearch(e.currentTarget.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div data-slot="snippets-toolbar">
          <button data-slot="snippets-toolbar-btn" onClick={handleOpenEditor}>
            <Icon name="plus-small" size="small" />
            New Snippet
          </button>
          <button data-slot="snippets-toolbar-btn" onClick={handleOpenManage}>
            <Icon name="settings-gear" size="small" />
            Manage
          </button>
        </div>

        <Show
          when={flatSnippets().length > 0}
          fallback={
            <div data-slot="snippets-empty">
              <Icon name="code" size="large" />
              <p>No snippets found</p>
              <Show when={search()}>
                <p data-slot="empty-hint">Try a different search term</p>
              </Show>
            </div>
          }
        >
          <div data-slot="snippets-list" ref={listRef}>
            <For each={Object.entries(groupedSnippets())}>
              {([category, snippets]) => (
                <div data-slot="snippets-category">
                  <div data-slot="snippets-category-header">{category}</div>
                  <For each={snippets}>
                    {(snippet) => {
                      const index = () => flatSnippets().findIndex((s) => s.id === snippet.id)
                      const isSelected = () => selectedIndex() === index()
                      return (
                        <div
                          data-slot="snippet-item"
                          data-selected={isSelected()}
                          data-builtin={snippet.isBuiltIn}
                          onMouseEnter={() => setSelectedIndex(index())}
                        >
                          <div data-slot="snippet-item-content">
                            <div data-slot="snippet-item-header">
                              <span data-slot="snippet-item-name">{snippet.name}</span>
                              <Show when={snippet.isBuiltIn}>
                                <span data-slot="snippet-builtin-badge">built-in</span>
                              </Show>
                            </div>
                            <Show when={snippet.description}>
                              <div data-slot="snippet-item-description">{snippet.description}</div>
                            </Show>
                          </div>
                          <div data-slot="snippet-item-actions">
                            <button
                              data-slot="snippet-action-btn"
                              data-action="insert"
                              onClick={() => handleInsertSnippet(snippet)}
                              title="Insert into prompt"
                            >
                              <Icon name="enter" size="small" />
                              Insert
                            </button>
                            <button
                              data-slot="snippet-action-btn"
                              data-action="copy"
                              onClick={() => handleCopySnippet(snippet)}
                              title="Copy to clipboard"
                            >
                              <Icon name="copy" size="small" />
                              Copy
                            </button>
                            <button
                              data-slot="snippet-preview-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPreviewSnippet(previewSnippet()?.id === snippet.id ? null : snippet)
                              }}
                              title="Preview snippet"
                            >
                              <Icon name="chevron-down" size="small" />
                            </button>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={previewSnippet()}>
          {(snippet) => (
            <div data-slot="snippets-preview">
              <div data-slot="snippets-preview-header">
                <span>Preview: {snippet().name}</span>
                <button onClick={() => setPreviewSnippet(null)}>
                  <Icon name="close" size="small" />
                </button>
              </div>
              <pre data-slot="snippets-preview-content">{snippet().template}</pre>
            </div>
          )}
        </Show>

        <div data-slot="snippets-footer">
          <div data-slot="snippets-hint">
            <span>
              <kbd>↑↓</kbd> navigate
            </span>
            <span>
              <kbd>enter</kbd> insert
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
          <button data-slot="snippets-close" onClick={() => dialog.close()}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
