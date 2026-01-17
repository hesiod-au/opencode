import { createSignal, createMemo, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useSDK } from "@/context/sdk"

// Compaction prompt templates (mirrored from backend)
const TEMPLATES = {
  default: `Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation.`,
  "code-changes": `List only the code changes made:
- Files created/modified/deleted
- Key functions or components changed
- No conversation summary needed`,
  decisions: `Summarize the decisions made:
- What approaches were chosen and why
- What was rejected and why
- Key constraints or requirements identified`,
  technical: `Keep technical details, minimize conversation:
- API endpoints, data structures, algorithms
- Configuration changes
- Dependencies added/removed
- Error messages and solutions`,
} as const

type TemplateKey = keyof typeof TEMPLATES
type CompactionStep = "prompt" | "preview" | "edit"

export interface DialogCustomCompactionProps {
  sessionID: string
  model: { providerID: string; modelID: string }
  selectedPartIds?: string[]
  onCompacted?: () => void
}

export function DialogCustomCompaction(props: DialogCustomCompactionProps) {
  const dialog = useDialog()
  const sdk = useSDK()

  // State
  const [step, setStep] = createSignal<CompactionStep>("prompt")
  const [selectedTemplate, setSelectedTemplate] = createSignal<TemplateKey>("default")
  const [customPrompt, setCustomPrompt] = createSignal<string>(TEMPLATES.default)
  const [preview, setPreview] = createSignal<{ summary: string; tokenEstimate: number } | null>(null)
  const [editedSummary, setEditedSummary] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const templateEntries = createMemo(() =>
    Object.entries(TEMPLATES).map(([key, value]) => ({
      key: key as TemplateKey,
      label: key === "default" ? "Default (Full Summary)" : key.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      preview: value.slice(0, 80) + (value.length > 80 ? "..." : ""),
    })),
  )

  const handleTemplateChange = (key: TemplateKey) => {
    setSelectedTemplate(key)
    setCustomPrompt(TEMPLATES[key])
  }

  const handleGeneratePreview = async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await sdk.client.session.compactPreview({
        sessionID: props.sessionID,
        providerID: props.model.providerID,
        modelID: props.model.modelID,
        prompt: customPrompt(),
        partIds: props.selectedPartIds,
      })

      if (result.error) {
        const errorMsg = typeof result.error === "object" && result.error !== null && "message" in result.error
          ? String((result.error as { message?: unknown }).message)
          : "Failed to generate preview"
        throw new Error(errorMsg)
      }

      if (result.data) {
        const summary = result.data.summary ?? ""
        setPreview({ summary, tokenEstimate: result.data.tokenEstimate ?? 0 })
        setEditedSummary(summary)
        setStep("preview")
      } else {
        throw new Error("No data returned from preview")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate preview")
    } finally {
      setLoading(false)
    }
  }

  const handleApply = async () => {
    setLoading(true)
    setError(null)

    const summary = editedSummary() ?? ""
    if (!summary.trim()) {
      setError("Summary cannot be empty")
      setLoading(false)
      return
    }

    try {
      // Use selective compaction when parts are selected, otherwise use regular compaction
      if (props.selectedPartIds && props.selectedPartIds.length > 0) {
        const result = await sdk.client.session.compactSelective({
          sessionID: props.sessionID,
          providerID: props.model.providerID,
          modelID: props.model.modelID,
          summary,
          partIds: props.selectedPartIds,
        })

        if (result.error) {
          const errorMsg = typeof result.error === "object" && result.error !== null && "message" in result.error
            ? String((result.error as { message?: unknown }).message)
            : "Failed to apply selective compaction"
          throw new Error(errorMsg)
        }
      } else {
        const result = await sdk.client.session.compactApply({
          sessionID: props.sessionID,
          providerID: props.model.providerID,
          modelID: props.model.modelID,
          summary,
        })

        if (result.error) {
          const errorMsg = typeof result.error === "object" && result.error !== null && "message" in result.error
            ? String((result.error as { message?: unknown }).message)
            : "Failed to apply compaction"
          throw new Error(errorMsg)
        }
      }

      props.onCompacted?.()
      dialog.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply compaction")
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    dialog.close()
  }

  const handleBack = () => {
    if (step() === "preview") {
      setStep("prompt")
    } else if (step() === "edit") {
      setStep("preview")
    }
  }

  const isSelectiveCompaction = createMemo(() => (props.selectedPartIds?.length ?? 0) > 0)

  return (
    <Dialog title={isSelectiveCompaction() ? "Compact Selected" : "Custom Compaction"}>
      <div data-component="custom-compaction-dialog">
        <Show when={isSelectiveCompaction()}>
          <div data-slot="compaction-info">
            <Icon name="checklist" size="small" />
            <span>Compacting {props.selectedPartIds?.length} selected parts</span>
          </div>
        </Show>

        <Show when={error()}>
          <div data-slot="compaction-error">{error()}</div>
        </Show>

        {/* Step 1: Prompt Selection */}
        <Show when={step() === "prompt"}>
          <div data-slot="compaction-section">
            <label data-slot="compaction-label">Template</label>
            <div data-slot="compaction-templates">
              <For each={templateEntries()}>
                {(template) => (
                  <button
                    data-slot="compaction-template"
                    data-active={selectedTemplate() === template.key}
                    onClick={() => handleTemplateChange(template.key)}
                  >
                    <span data-slot="template-label">{template.label}</span>
                    <span data-slot="template-preview">{template.preview}</span>
                  </button>
                )}
              </For>
            </div>
          </div>

          <div data-slot="compaction-section">
            <label data-slot="compaction-label">Compaction Prompt</label>
            <textarea
              data-slot="compaction-textarea"
              value={customPrompt()}
              onInput={(e) => setCustomPrompt(e.currentTarget.value)}
              rows={6}
              placeholder="Enter your compaction prompt..."
            />
            <div data-slot="compaction-hint">
              Customize what the LLM should focus on when summarizing the conversation.
            </div>
          </div>
        </Show>

        {/* Step 2: Preview */}
        <Show when={step() === "preview"}>
          <div data-slot="compaction-section">
            <div data-slot="compaction-preview-header">
              <label data-slot="compaction-label">Generated Summary</label>
              <Show when={preview()?.tokenEstimate != null}>
                <span data-slot="compaction-tokens">~{(preview()?.tokenEstimate ?? 0).toLocaleString()} tokens</span>
              </Show>
            </div>
            <div data-slot="compaction-preview">
              {preview()?.summary ?? "No preview available"}
            </div>
            <div data-slot="compaction-hint">
              Review the generated summary. Click "Edit" to modify it before applying.
            </div>
          </div>
        </Show>

        {/* Step 3: Edit */}
        <Show when={step() === "edit"}>
          <div data-slot="compaction-section">
            <label data-slot="compaction-label">Edit Summary</label>
            <textarea
              data-slot="compaction-textarea"
              data-large
              value={editedSummary()}
              onInput={(e) => setEditedSummary(e.currentTarget.value)}
              rows={12}
            />
            <div data-slot="compaction-hint">
              Modify the summary as needed. This will be used as the new context starting point.
            </div>
          </div>
        </Show>

        {/* Actions */}
        <div data-slot="compaction-actions">
          <Show when={step() !== "prompt"}>
            <button data-slot="compaction-btn" data-variant="secondary" onClick={handleBack} disabled={loading()}>
              <Icon name="arrow-left" size="small" />
              Back
            </button>
          </Show>

          <div data-slot="compaction-actions-right">
            <button data-slot="compaction-btn" data-variant="cancel" onClick={handleCancel} disabled={loading()}>
              Cancel
            </button>

            <Show when={step() === "prompt"}>
              <button
                data-slot="compaction-btn"
                data-variant="primary"
                onClick={handleGeneratePreview}
                disabled={loading() || !customPrompt().trim()}
              >
                {loading() ? (
                  <>
                    <Icon name="dot-grid" size="small" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Icon name="plus" size="small" />
                    Generate Preview
                  </>
                )}
              </button>
            </Show>

            <Show when={step() === "preview"}>
              <button
                data-slot="compaction-btn"
                data-variant="secondary"
                onClick={() => setStep("edit")}
                disabled={loading()}
              >
                <Icon name="pencil-line" size="small" />
                Edit
              </button>
              <button
                data-slot="compaction-btn"
                data-variant="primary"
                onClick={handleApply}
                disabled={loading()}
              >
                {loading() ? (
                  <>
                    <Icon name="dot-grid" size="small" />
                    Applying...
                  </>
                ) : (
                  <>
                    <Icon name="check" size="small" />
                    Apply
                  </>
                )}
              </button>
            </Show>

            <Show when={step() === "edit"}>
              <button
                data-slot="compaction-btn"
                data-variant="primary"
                onClick={handleApply}
                disabled={loading() || !(editedSummary() ?? "").trim()}
              >
                {loading() ? (
                  <>
                    <Icon name="dot-grid" size="small" />
                    Applying...
                  </>
                ) : (
                  <>
                    <Icon name="check" size="small" />
                    Apply Edited Summary
                  </>
                )}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
