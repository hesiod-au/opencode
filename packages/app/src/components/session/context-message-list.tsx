import { createMemo, For, Show } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { ContextMessageItem } from "./context-message-item"
import type { SelectionState } from "./session-context-tab"

export interface ContextMessageListProps {
  messages: () => Message[]
  getParts: (messageId: string) => Part[]
  onJumpToMessage?: (messageId: string) => void
  selection?: SelectionState
  onPartUpdated?: () => void
}

export function ContextMessageList(props: ContextMessageListProps) {
  // Filter messages to only show those with visible parts
  const visibleMessages = createMemo(() => {
    const hidden = props.selection?.hidden() ?? new Set()
    const showHidden = props.selection?.showHidden() ?? false

    return props.messages().filter((msg) => {
      const parts = props.getParts(msg.id)
      // If showHidden is true, show all messages that have any parts
      if (showHidden) return parts.length > 0
      // Otherwise, only show messages that have at least one non-hidden part
      return parts.some((part) => !hidden.has(part.id))
    })
  })

  const messageCount = createMemo(() => visibleMessages().length)

  const userCount = createMemo(() => visibleMessages().filter((m) => m.role === "user").length)

  const assistantCount = createMemo(() => visibleMessages().filter((m) => m.role === "assistant").length)

  return (
    <div data-component="context-message-list">
      <div data-slot="context-list-header">
        <span data-slot="context-list-title">Messages</span>
        <span data-slot="context-list-count">
          {messageCount()} total ({userCount()} user, {assistantCount()} assistant)
        </span>
      </div>
      <For each={visibleMessages()}>
        {(message) => (
          <ContextMessageItem
            message={message}
            parts={() => props.getParts(message.id)}
            onJumpToMessage={props.onJumpToMessage}
            selection={props.selection}
            onPartUpdated={props.onPartUpdated}
          />
        )}
      </For>
      <Show when={messageCount() === 0}>
        <div class="text-12-regular text-text-weak py-4 text-center">No messages in this session</div>
      </Show>
    </div>
  )
}
