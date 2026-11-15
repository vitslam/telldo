import { useEffect, useRef, useState } from "react";
import type { ChatSession, ConversationMessage } from "../shared/chat-history";

const activeKey = "telldo.active-chat";
function initialId() {
  try {
    const saved = localStorage.getItem(activeKey);
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
  } catch { /* A restricted preference store must not prevent chatting. */ }
  return crypto.randomUUID();
}
function remember(id: string) {
  try { localStorage.setItem(activeKey, id); } catch { /* SQLite still saves the chat. */ }
}

export function useChatHistory(onError: (message: string) => void) {
  const [activeId, setActiveId] = useState(initialId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const current = useRef({ id: activeId, messages });
  current.current = { id: activeId, messages };
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const saved = useRef<{ id: string; messages: ConversationMessage[] } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const moving = useRef(false);
  const persist = () => {
    const snapshot = current.current;
    if (!snapshot.messages.length || (saved.current?.id === snapshot.id && saved.current.messages === snapshot.messages))
      return queue.current;
    const write = queue.current.catch(() => {}).then(async () => {
      await window.telldo.invoke("chatHistorySave", snapshot.id, snapshot.messages);
      saved.current = snapshot;
    });
    queue.current = write;
    return write;
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    let cancelled = false;
    const id = current.current.id;
    void window.telldo.invoke("chatHistoryLoad", id).then(value => {
      if (cancelled) return;
      const session = value as ChatSession | null;
      const restored = session?.messages ?? [];
      saved.current = { id, messages: restored };
      setMessages(restored);
      remember(id);
      setReady(true);
    }).catch(error => {
      if (cancelled) return;
      // Preserve the unreadable session; never overwrite it with an empty fallback.
      const id = crypto.randomUUID();
      setActiveId(id);
      remember(id);
      setReady(true);
      errorRef.current(`未能恢复对话 / Could not restore chat: ${String(error)}`);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!ready || switching || !messages.length) return;
    // Coalesce streamed updates, but save a finished turn immediately.
    timer.current = setTimeout(() => {
      void persistRef.current().catch(error => errorRef.current(`对话未保存 / Chat was not saved: ${String(error)}`));
    }, messages.at(-1)?.state === "working" ? 750 : 0);
    return () => clearTimeout(timer.current);
  }, [messages, activeId, ready, switching]);
  useEffect(() => {
    if (!ready || switching) return;
    const interval = setInterval(() => {
      if (current.current.messages.at(-1)?.state === "working")
        void persistRef.current().catch(error => errorRef.current(`对话未保存 / Chat was not saved: ${String(error)}`));
    }, 1500);
    return () => clearInterval(interval);
  }, [ready, switching]);
  useEffect(() => {
    const flush = () => { void persistRef.current().catch(() => {}); };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);
  async function change(id?: string) {
    if (moving.current) return false;
    moving.current = true;
    setSwitching(true);
    clearTimeout(timer.current);
    try {
      await persist();
      const session = id ? await window.telldo.invoke("chatHistoryLoad", id) as ChatSession | null : null;
      if (id && !session) throw Error("对话不存在 / Chat no longer exists");
      const nextId = session?.id ?? crypto.randomUUID();
      const nextMessages = session?.messages ?? [];
      current.current = { id: nextId, messages: nextMessages };
      saved.current = current.current;
      setActiveId(nextId);
      setMessages(nextMessages);
      remember(nextId);
      return true;
    } finally {
      moving.current = false;
      setSwitching(false);
    }
  }
  return { messages, setMessages, activeId, ready, switching, change, flush: persist };
}
