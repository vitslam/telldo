import { Fragment, useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, Search, X } from "lucide-react";
import { DateTime } from "luxon";
import DetailCardModal from "./DetailCardModal";
import type { ChatHistoryPage, ChatSessionSummary } from "../shared/chat-history";
import "./chat-history.css";

export default function ChatHistoryDialog({ isZh, activeId, select, close }: {
  isZh: boolean;
  activeId: string;
  select: (id: string) => Promise<void>;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ChatSessionSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const latestQuery = useRef(query);
  latestQuery.current = query;
  async function fetchPage(offset: number, needle: string, version: number) {
    setLoading(true);
    try {
      const page = await window.telldo.invoke("chatHistoryList", { query: needle, offset }) as ChatHistoryPage;
      if (generation.current !== version || latestQuery.current !== needle) return;
      setItems(previous => offset ? [...previous, ...page.items] : page.items);
      setHasMore(page.hasMore);
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      if (generation.current === version && latestQuery.current === needle) setLoading(false);
    }
  }
  useEffect(() => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    setItems([]);
    setHasMore(false);
    const timer = setTimeout(() => void fetchPage(0, query, version), 160);
    return () => { clearTimeout(timer); generation.current++; };
  }, [query]);
  async function open(id: string) {
    if (opening) return;
    setOpening(id);
    setError("");
    try { await select(id); } catch (error) { setError(String(error)); setOpening(null); }
  }
  return <DetailCardModal labelledBy="chat-history-title" className="chat-history-dialog" close={opening ? () => {} : close}>
    <div className="history-heading">
      <h2 id="chat-history-title">{isZh ? "历史对话" : "Chat history"}</h2>
      <button className="history-close" disabled={!!opening} onClick={close} aria-label={isZh ? "关闭" : "Close"}><X size={18} /></button>
    </div>
    <label className="history-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} maxLength={200} placeholder={isZh ? "搜索对话" : "Search conversations"} aria-label={isZh ? "搜索对话" : "Search conversations"} /></label>
    {error && <p role="alert" className="history-error">{error}</p>}
    <div className="history-list" aria-busy={loading || !!opening}>
      {items.map((item, index) => {
        const date = DateTime.fromISO(item.updatedAt).setLocale(isZh ? "zh-CN" : "en");
        const previousDay = index ? DateTime.fromISO(items[index - 1].updatedAt).toISODate() : null;
        const today = DateTime.local().startOf("day");
        const day = date.hasSame(today, "day") ? (isZh ? "今天" : "Today")
          : date.hasSame(today.minus({ days: 1 }), "day") ? (isZh ? "昨天" : "Yesterday")
          : date.toFormat(isZh ? "M月d日" : "MMM d") + (date.year !== today.year ? `, ${date.year}` : "");
        return <Fragment key={item.id}>
          {date.toISODate() !== previousDay && <h3 className="history-day">{day}</h3>}
          <button className={`history-item ${item.id === activeId ? "current" : ""}`} disabled={!!opening || loading} aria-current={item.id === activeId ? "true" : undefined} onClick={() => void open(item.id)}>
            <span className="history-item-content">
              <span className="history-item-top">
                <span className="history-item-title">{item.title}</span>
                <time className="history-item-time" dateTime={item.updatedAt} title={date.toLocaleString(DateTime.DATETIME_MED)}>{date.toFormat("HH:mm")}</time>
              </span>
              <span className="history-item-bottom">
                <span className="history-item-preview">{item.preview !== item.title ? item.preview : ""}</span>
                {opening === item.id ? <LoaderCircle size={12} className="spin history-opening" /> : item.id === activeId && <span className="history-current">{isZh ? "当前对话" : "Current"}</span>}
              </span>
            </span>
          </button>
        </Fragment>;
      })}
      {!items.length && !loading && !error && <div className="history-empty"><MessageSquare size={25} /><p>{query ? (isZh ? "没有找到相关对话" : "No matching conversations") : (isZh ? "对话会保存在这里" : "Your conversations will appear here")}</p></div>}
      {loading && <div className="history-loading"><LoaderCircle size={17} className="spin" /></div>}
      {hasMore && !loading && <button className="history-more" onClick={() => void fetchPage(items.length, query, generation.current)}>{isZh ? "加载更多" : "Load more"}</button>}
    </div>
  </DetailCardModal>;
}
