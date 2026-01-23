import { createMemo, createContext, useContext, onCleanup, type ParentProps, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { persisted, Persist } from "@/utils/persist"
import { usePlatform } from "@/context/platform"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type ItemState = "neutral" | "force_include" | "force_exclude"

// Stored content for excluded items (so they can be displayed even though server doesn't have them)
interface ExcludedContent {
  messages: Record<string, Message> // messageId -> Message
  parts: Record<string, Part[]> // messageId -> Part[]
}

interface CanonicalContextStore {
  version: 1
  items: Record<string, ItemState>
  knownIds: string[]
  excludedContent: ExcludedContent
}

interface CanonicalContextValue {
  // State accessors
  getState: (partId: string) => ItemState
  isForceIncluded: (partId: string) => boolean
  isForceExcluded: (partId: string) => boolean

  // Mutations
  setInclude: (partId: string) => void
  setExclude: (partId: string) => void
  resetItem: (partId: string) => void
  resetAll: () => void

  // Sync with server
  mergeServerItems: (serverPartIds: string[]) => void

  // For prompt submission
  getEffectiveExclusions: () => Set<string>
  getForceInclusions: () => Set<string>

  // Store excluded content (for display after cloning)
  storeExcludedContent: (messages: Message[], parts: Record<string, Part[]>) => void
  getExcludedContent: () => ExcludedContent

  // Copy state to a new session (for cloning/forking)
  copyToSession: (newSessionId: string) => void

  // All items
  items: Accessor<Record<string, ItemState>>

  // Ready state
  ready: Accessor<boolean>
}

const CanonicalContextContext = createContext<CanonicalContextValue>()

function createDefaultStore(): CanonicalContextStore {
  return {
    version: 1,
    items: {},
    knownIds: [],
    excludedContent: { messages: {}, parts: {} },
  }
}

/**
 * Merge algorithm:
 * 1. Keep all server items, preserving existing states
 * 2. Handle local-only items:
 *    - force_include items that disappeared: keep them as force_include
 *    - neutral items that disappeared: mark as force_exclude
 *    - force_exclude items that disappeared: keep them as force_exclude
 * 3. Merge known IDs preserving order
 */
function mergeServerItems(serverPartIds: string[], store: CanonicalContextStore): CanonicalContextStore {
  const serverSet = new Set(serverPartIds)
  const newItems: Record<string, ItemState> = {}

  // 1. Keep all server items, preserving existing states
  for (const id of serverPartIds) {
    newItems[id] = store.items[id] ?? "neutral"
  }

  // 2. Handle local-only items
  for (const [id, state] of Object.entries(store.items)) {
    if (serverSet.has(id)) continue

    if (state === "force_include") {
      // User marked + takes precedence
      newItems[id] = "force_include"
    } else if (state === "neutral") {
      // Disappeared neutral -> mark excluded
      newItems[id] = "force_exclude"
    } else if (state === "force_exclude") {
      // force_exclude items that disappeared: keep them excluded
      newItems[id] = "force_exclude"
    }
  }

  // 3. Merge known IDs preserving order
  const knownSet = new Set(store.knownIds)
  const newKnownIds = [...store.knownIds]
  for (const id of serverPartIds) {
    if (!knownSet.has(id)) {
      newKnownIds.push(id)
    }
  }

  return { version: 1, items: newItems, knownIds: newKnownIds, excludedContent: store.excludedContent ?? { messages: {}, parts: {} } }
}

export interface CanonicalContextProviderProps extends ParentProps {
  workspaceDir: string
  sessionId: string | undefined
}

export function CanonicalContextProvider(props: CanonicalContextProviderProps) {
  // Use session-scoped persistence when sessionId is available
  const persistTarget = () => {
    if (!props.sessionId) return null
    return Persist.session(props.workspaceDir, props.sessionId, "canonical-context")
  }

  // Debug: log session ID on mount/unmount
  console.log("[CanonicalContextProvider] Mounting with sessionId:", props.sessionId)
  onCleanup(() => {
    console.log("[CanonicalContextProvider] Unmounting sessionId:", props.sessionId)
  })

  // Create base store
  const baseStore = createStore<CanonicalContextStore>(createDefaultStore())

  // Create persisted store only when we have a session
  const [store, setStore, , ready] = (() => {
    const target = persistTarget()
    console.log("[CanonicalContextProvider] Persist target:", target?.key)
    if (target) {
      return persisted<CanonicalContextStore>(target, baseStore)
    }
    // Return non-persisted store when no session
    return [...baseStore, null, () => true] as const
  })()

  const getState = (partId: string): ItemState => {
    return store.items[partId] ?? "neutral"
  }

  const isForceIncluded = (partId: string): boolean => {
    return getState(partId) === "force_include"
  }

  const isForceExcluded = (partId: string): boolean => {
    return getState(partId) === "force_exclude"
  }

  const setInclude = (partId: string) => {
    const current = getState(partId)
    if (current === "force_include") {
      // Toggle back to neutral
      setStore("items", partId, "neutral")
    } else {
      // Set to force_include
      setStore("items", partId, "force_include")
      // Add to knownIds if not present
      if (!store.knownIds.includes(partId)) {
        setStore("knownIds", (prev) => [...prev, partId])
      }
    }
  }

  const setExclude = (partId: string) => {
    const current = getState(partId)
    if (current === "force_exclude") {
      // Toggle back to neutral
      setStore("items", partId, "neutral")
    } else {
      // Set to force_exclude
      setStore("items", partId, "force_exclude")
      // Add to knownIds if not present
      if (!store.knownIds.includes(partId)) {
        setStore("knownIds", (prev) => [...prev, partId])
      }
    }
  }

  const resetItem = (partId: string) => {
    setStore("items", partId, "neutral")
  }

  const resetAll = () => {
    setStore(createDefaultStore())
  }

  const handleMergeServerItems = (serverPartIds: string[]) => {
    const merged = mergeServerItems(serverPartIds, store)
    setStore(merged)
  }

  const getEffectiveExclusions = (): Set<string> => {
    const exclusions = new Set<string>()
    for (const [id, state] of Object.entries(store.items)) {
      if (state === "force_exclude") {
        exclusions.add(id)
      }
    }
    // Debug: log exclusions
    console.log("[CanonicalContext] getEffectiveExclusions:", {
      sessionId: props.sessionId,
      totalItems: Object.keys(store.items).length,
      exclusionCount: exclusions.size,
      exclusions: Array.from(exclusions),
    })
    return exclusions
  }

  const getForceInclusions = (): Set<string> => {
    const inclusions = new Set<string>()
    for (const [id, state] of Object.entries(store.items)) {
      if (state === "force_include") {
        inclusions.add(id)
      }
    }
    return inclusions
  }

  // Store content of excluded items so they can be displayed even after server doesn't have them
  const storeExcludedContent = (messages: Message[], parts: Record<string, Part[]>) => {
    const excludedMsgs: Record<string, Message> = {}
    const excludedParts: Record<string, Part[]> = {}

    for (const msg of messages) {
      const msgParts = parts[msg.id] ?? []
      const excludedPartsForMsg = msgParts.filter((p) => store.items[p.id] === "force_exclude")
      if (excludedPartsForMsg.length > 0) {
        excludedMsgs[msg.id] = msg
        excludedParts[msg.id] = excludedPartsForMsg
      }
    }

    setStore("excludedContent", { messages: excludedMsgs, parts: excludedParts })
    console.log("[CanonicalContext] storeExcludedContent:", {
      messageCount: Object.keys(excludedMsgs).length,
      partCount: Object.values(excludedParts).flat().length,
    })
  }

  const getExcludedContent = (): ExcludedContent => {
    return store.excludedContent ?? { messages: {}, parts: {} }
  }

  // Copy current state to a new session's storage
  const copyToSession = (newSessionId: string) => {
    if (!props.sessionId) return
    const newTarget = Persist.session(props.workspaceDir, newSessionId, "canonical-context")
    // Construct the full localStorage key (storage:key format)
    const storageKey = `${newTarget.storage}:${newTarget.key}`
    const storeData: CanonicalContextStore = {
      version: 1,
      items: { ...store.items },
      knownIds: [...store.knownIds],
      excludedContent: store.excludedContent ?? { messages: {}, parts: {} },
    }
    console.log("[CanonicalContext] copyToSession:", {
      fromSession: props.sessionId,
      toSession: newSessionId,
      storageKey,
      itemCount: Object.keys(storeData.items).length,
      excludedMessageCount: Object.keys(storeData.excludedContent.messages).length,
    })
    localStorage.setItem(storageKey, JSON.stringify(storeData))
  }

  const items = createMemo(() => store.items)

  const value: CanonicalContextValue = {
    getState,
    isForceIncluded,
    isForceExcluded,
    setInclude,
    setExclude,
    resetItem,
    resetAll,
    mergeServerItems: handleMergeServerItems,
    getEffectiveExclusions,
    getForceInclusions,
    storeExcludedContent,
    getExcludedContent,
    copyToSession,
    items,
    ready: () => ready(),
  }

  return <CanonicalContextContext.Provider value={value}>{props.children}</CanonicalContextContext.Provider>
}

export function useCanonicalContext() {
  const ctx = useContext(CanonicalContextContext)
  if (!ctx) {
    throw new Error("useCanonicalContext must be used within CanonicalContextProvider")
  }
  return ctx
}

/** Safe version that returns undefined if not inside provider */
export function useCanonicalContextMaybe() {
  return useContext(CanonicalContextContext)
}
