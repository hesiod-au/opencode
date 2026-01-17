import { createSignal, Show, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useSnippets, type Snippet } from "./use-snippets"
import { showToast } from "@opencode-ai/ui/toast"

export interface DialogSnippetEditorProps {
  snippet?: Snippet
  onSave?: () => void
}

export function DialogSnippetEditor(props: DialogSnippetEditorProps) {
  const dialog = useDialog()
  const snippets = useSnippets()

  const isEditing = () => !!props.snippet && !props.snippet.isBuiltIn

  const [name, setName] = createSignal(props.snippet?.name ?? "")
  const [description, setDescription] = createSignal(props.snippet?.description ?? "")
  const [template, setTemplate] = createSignal(props.snippet?.template ?? "")
  const [category, setCategory] = createSignal(props.snippet?.category ?? "custom")
  const [tags, setTags] = createSignal(props.snippet?.tags?.join(", ") ?? "")

  let nameInputRef!: HTMLInputElement

  onMount(() => {
    nameInputRef?.focus()
  })

  const handleSave = () => {
    const trimmedName = name().trim()
    const trimmedTemplate = template().trim()

    if (!trimmedName) {
      showToast({
        title: "Name required",
        description: "Please enter a name for the snippet.",
      })
      return
    }

    if (!trimmedTemplate) {
      showToast({
        title: "Template required",
        description: "Please enter the snippet content.",
      })
      return
    }

    const tagsList = tags()
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)

    if (isEditing() && props.snippet) {
      snippets.updateSnippet(props.snippet.id, {
        name: trimmedName,
        description: description().trim() || undefined,
        template: trimmedTemplate,
        category: category().trim() || undefined,
        tags: tagsList.length > 0 ? tagsList : undefined,
      })
      showToast({
        title: "Snippet updated",
        description: `"${trimmedName}" has been updated.`,
      })
    } else {
      snippets.saveSnippet({
        name: trimmedName,
        description: description().trim() || undefined,
        template: trimmedTemplate,
        category: category().trim() || undefined,
        tags: tagsList.length > 0 ? tagsList : undefined,
      })
      showToast({
        title: "Snippet created",
        description: `"${trimmedName}" has been saved.`,
      })
    }

    props.onSave?.()
    dialog.close()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      dialog.close()
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <Dialog title={isEditing() ? "Edit Snippet" : "New Snippet"}>
      <div data-component="snippet-editor" onKeyDown={handleKeyDown}>
        <div data-slot="snippet-editor-fields">
          <div data-slot="snippet-editor-field">
            <label data-slot="snippet-editor-label">
              Name <span data-slot="required">*</span>
            </label>
            <input
              ref={nameInputRef}
              data-slot="snippet-editor-input"
              type="text"
              placeholder="e.g., Code Review Request"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>

          <div data-slot="snippet-editor-field">
            <label data-slot="snippet-editor-label">Description</label>
            <input
              data-slot="snippet-editor-input"
              type="text"
              placeholder="Brief description of when to use this snippet"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </div>

          <div data-slot="snippet-editor-field">
            <label data-slot="snippet-editor-label">
              Template <span data-slot="required">*</span>
            </label>
            <textarea
              data-slot="snippet-editor-textarea"
              placeholder="Enter your snippet content here...&#10;&#10;You can use variables like {{date}}, {{time}}, {{session}}"
              value={template()}
              onInput={(e) => setTemplate(e.currentTarget.value)}
              rows={6}
            />
            <div data-slot="snippet-editor-hint">
              Available variables: <code>{"{{date}}"}</code>, <code>{"{{time}}"}</code>, <code>{"{{session}}"}</code>
            </div>
          </div>

          <div data-slot="snippet-editor-row">
            <div data-slot="snippet-editor-field" data-half>
              <label data-slot="snippet-editor-label">Category</label>
              <input
                data-slot="snippet-editor-input"
                type="text"
                placeholder="e.g., guidance, review"
                value={category()}
                onInput={(e) => setCategory(e.currentTarget.value)}
              />
            </div>

            <div data-slot="snippet-editor-field" data-half>
              <label data-slot="snippet-editor-label">Tags</label>
              <input
                data-slot="snippet-editor-input"
                type="text"
                placeholder="tag1, tag2, tag3"
                value={tags()}
                onInput={(e) => setTags(e.currentTarget.value)}
              />
            </div>
          </div>
        </div>

        <div data-slot="snippet-editor-footer">
          <button data-slot="snippet-editor-cancel" onClick={() => dialog.close()}>
            Cancel
          </button>
          <button data-slot="snippet-editor-save" onClick={handleSave}>
            <Icon name="check" size="small" />
            {isEditing() ? "Save Changes" : "Create Snippet"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
