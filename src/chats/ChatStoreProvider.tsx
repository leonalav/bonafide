/**
 * ChatStoreProvider.tsx — React context wrapper around the module-level
 * `chatsStore` from `ChatStore.ts`.
 *
 * Mirrors the `ModelsProvider` pattern: the store itself is module
 * state (no React dependency, no re-renders on import), and this
 * provider exposes a small, memoised hook for components that need
 * to subscribe.
 *
 * Components that only *call* actions (e.g. `createThread`,
 * `appendMessage`) don't need this hook at all — they can import the
 * store directly. The hook is for components that render thread /
 * message state and therefore need to re-render on changes.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  chatsStore,
  type ChatConfig,
  type ChatMessage,
  type ChatStatus,
  type ChatThread,
  type CreateThreadInput,
} from "./ChatStore";

export type ChatsStoreValue = {
  config: ChatConfig;
  threads: ChatThread[];
  activeThread: ChatThread | null;

  // Read-only accessors for action wiring.
  appendMessage: (threadId: string, message: ChatMessage) => void;
  createThread: (input: CreateThreadInput) => ChatThread;
  renameThread: (id: string, title: string) => void;
  deleteThread: (id: string) => void;
  setActiveThread: (id: string | null) => void;
  setThreadStatus: (threadId: string, status: ChatStatus) => void;
  updateMessage: (
    threadId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
  ) => void;
  /** Rewrite a message's content (used by the inline-edit affordance). */
  editMessage: (threadId: string, messageId: string, newContent: string) => void;
  /** Drop every message strictly after `messageId` in the thread. */
  truncateAfter: (threadId: string, messageId: string) => void;
  abortSend: (threadId: string) => void;
  // REVIEW(opus) FINDINGS 3 + 4 + 5: tryBeginSend returns false when
  // the thread is already in "sending" so the UI can bail; finishSend
  // clears the AbortController and reverts status in `finally`.
  tryBeginSend: (threadId: string) => boolean;
  finishSend: (threadId: string, finalStatus?: ChatStatus) => void;
  getAbortSignal: (threadId: string) => AbortSignal;
};

const ChatsContext = createContext<ChatsStoreValue | null>(null);

export function ChatStoreProvider({ children }: { children: ReactNode }) {
  // Re-render the provider whenever the store notifies. Components
  // that consume the hook re-render with us.
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    return chatsStore.subscribe(() => forceUpdate((n) => n + 1));
  }, []);

  // REVIEW(opus) FINDING 1 [critical]: prior useMemo with [] deps cached
  // the initial config forever, so consumers always saw the empty
  // thread list. We rebuild the value inline on every render; the bound
  // actions are stable `.bind()` references so children that pass them
  // as effect deps don't churn. The shallow copy on `threads` is
  // FINDING 6 — prevents consumers from mutating internal store state.
  const config = chatsStore.getConfig();
  const activeThread =
    config.threads.find((t) => t.id === config.activeThreadId) ?? null;

  const value: ChatsStoreValue = {
    config,
    threads: [...config.threads],
    activeThread,
    appendMessage: chatsStore.appendMessage.bind(chatsStore),
    createThread: chatsStore.createThread.bind(chatsStore),
    renameThread: chatsStore.renameThread.bind(chatsStore),
    deleteThread: chatsStore.deleteThread.bind(chatsStore),
    setActiveThread: chatsStore.setActiveThread.bind(chatsStore),
    setThreadStatus: chatsStore.setThreadStatus.bind(chatsStore),
    updateMessage: chatsStore.updateMessage.bind(chatsStore),
    editMessage: chatsStore.editMessage.bind(chatsStore),
    truncateAfter: chatsStore.truncateAfter.bind(chatsStore),
    abortSend: chatsStore.abortSend.bind(chatsStore),
    tryBeginSend: chatsStore.tryBeginSend.bind(chatsStore),
    finishSend: chatsStore.finishSend.bind(chatsStore),
    getAbortSignal: chatsStore.getAbortSignal.bind(chatsStore),
  };

  return (
    <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
  );
}

export function useChatsStore(): ChatsStoreValue {
  const ctx = useContext(ChatsContext);
  if (!ctx) {
    throw new Error(
      "useChatsStore must be used inside <ChatStoreProvider>",
    );
  }
  return ctx;
}
