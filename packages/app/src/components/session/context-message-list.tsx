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
  const messageCount = createMemo(() => props.messages().length)

  const userCount = createMemo(() => props.messages().filter((m) => m.role === "user").length)

  const assistantCount = createMemo(() => props.messages().filter((m) => m.role === "assistant").length)

  return (
    <div data-component="context-message-list">
      <div data-slot="context-list-header">
        <span data-slot="context-list-title">Messages</span>
        <span data-slot="context-list-count">
          {messageCount()} total ({userCount()} user, {assistantCount()} assistant)
        </span>
      </div>
      <For each={props.messages()}>
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
