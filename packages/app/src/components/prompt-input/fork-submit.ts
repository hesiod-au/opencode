import { useNavigate } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSync } from "@/context/sync"
import { useLoadedSnapshot } from "@/components/session/use-loaded-snapshot"
import { useCanonicalContextMaybe } from "@/components/session/use-canonical-context"
import { useArchive } from "@/components/session/use-archive"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { PromptOverrides, PromptOverridesInput } from "./submit"

/**
 * Creates the fork-specific prompt override callback that handles
 * snapshot context, canonical context exclusions, archive of
 * excluded parts, and child session creation when context overrides
 * are needed.
 *
 * Returns undefined when no overrides are needed (normal flow).
 * Returns PromptOverrides when a child session should be created
 * with a modified message history.
 */
export function createForkPromptOverrides(
    workspaceDir: string,
) {
    const navigate = useNavigate()
    const sync = useSync()
    const loadedSnapshotCtx = useLoadedSnapshot()
    const canonicalContext = useCanonicalContextMaybe()
    const archive = useArchive(workspaceDir)

    return async (
        input: PromptOverridesInput,
    ): Promise<PromptOverrides | undefined> => {
        const { session, sessionDirectory, client } = input

        // Gather server-side messages and parts
        const serverMessages = sync.data.message[session.id] ?? []
        const serverParts = sync.data.part

        // Merge excluded content back (items excluded locally
        // but still needed for the override payload)
        const excludedContent =
            canonicalContext?.getExcludedContent()
        let liveMessages: Message[] = serverMessages
        let liveParts: Record<string, Part[]> = serverParts

        if (
            excludedContent &&
            Object.keys(excludedContent.messages).length > 0
        ) {
            const serverMsgIds = new Set(
                serverMessages.map((m) => m.id),
            )
            const excludedMsgs = Object.values(
                excludedContent.messages,
            ).filter((m) => !serverMsgIds.has(m.id))

            if (excludedMsgs.length > 0) {
                liveMessages = [
                    ...serverMessages,
                    ...excludedMsgs,
                ].sort((a, b) => (a.id > b.id ? 1 : -1))
            }

            const mergedParts = { ...serverParts }
            for (const [msgId, parts] of Object.entries(
                excludedContent.parts,
            )) {
                const existing = serverParts[msgId] ?? []
                const existingIds = new Set(
                    existing.map((p) => p.id),
                )
                const missing = parts.filter(
                    (p) => !existingIds.has(p.id),
                )
                if (missing.length > 0) {
                    mergedParts[msgId] = [
                        ...existing,
                        ...missing,
                    ].sort((a, b) => (a.id > b.id ? 1 : -1))
                }
            }
            liveParts = mergedParts
        }

        const canonicalExclusions =
            canonicalContext?.getEffectiveExclusions()
        const hasExcludedContent =
            excludedContent &&
            Object.keys(excludedContent.messages).length > 0

        const messagesOverride =
            loadedSnapshotCtx.getMessagesForPrompt(
                liveMessages,
                liveParts,
                undefined,
                canonicalExclusions,
                hasExcludedContent,
            )

        if (!messagesOverride) return undefined

        // Create child session for the override
        const newSession = await client.session
            .create({ parentID: session.id })
            .then((x) => x.data ?? undefined)
            .catch(() => {
                showToast({
                    title: "Failed to create session",
                    description:
                        "Could not create a new session for the snapshot",
                })
                return undefined
            })

        if (!newSession) return undefined

        // Archive excluded parts before clearing
        const excludedIds = loadedSnapshotCtx.excluded()
        if (excludedIds.size > 0) {
            const sessionInfo = sync.data.session.find(
                (s) => s.id === session.id,
            )
            const toArchive: Array<{
                part: Part
                message: Message
                sessionId: string
                sessionName?: string
            }> = []

            for (const msg of liveMessages) {
                const msgParts = liveParts[msg.id] ?? []
                for (const part of msgParts) {
                    if (excludedIds.has(part.id)) {
                        toArchive.push({
                            part,
                            message: msg,
                            sessionId: session.id,
                            sessionName: sessionInfo?.title,
                        })
                    }
                }
            }

            if (toArchive.length > 0) {
                archive.addManyToArchive(toArchive)
            }
        }

        // Persist excluded content and copy canonical
        // context to the new session
        canonicalContext?.storeExcludedContent(
            liveMessages,
            liveParts,
        )
        canonicalContext?.copyToSession(newSession.id)

        // Clear snapshot state and navigate to the child
        loadedSnapshotCtx.clear()
        navigate(
            `/${base64Encode(sessionDirectory)}/session/${newSession.id}`,
        )

        return {
            sessionID: newSession.id,
            messages: messagesOverride,
            onSent: () => {
                sync.session.refresh(newSession.id)
            },
        }
    }
}
