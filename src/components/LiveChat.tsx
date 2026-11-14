import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { postLiveChat } from "@/lib/livestream.functions";
import { useWallet } from "@/lib/wallet";
import { toast } from "sonner";

interface ChatRow {
  id: string;
  stream_id: string;
  display_name: string | null;
  body: string;
  created_at: string;
}

export function LiveChat({ streamId }: { streamId: string }) {
  const { address, isAuthenticated } = useWallet();
  const [messages, setMessages] = useState<ChatRow[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const post = useServerFn(postLiveChat);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from("live_chat_messages")
        .select("id,stream_id,display_name,body,created_at")
        .eq("stream_id", streamId)
        .order("created_at", { ascending: true })
        .limit(200);
      if (!cancelled) setMessages((data ?? []) as ChatRow[]);
    }
    load();

    const ch = supabase
      .channel(`live-chat-${streamId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "live_chat_messages",
          filter: `stream_id=eq.${streamId}`,
        },
        (payload) => {
          setMessages((m) => [...m, payload.new as ChatRow]);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [streamId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !isAuthenticated) return;
    setBusy(true);
    try {
      await post({ data: { streamId, body: text.trim() } });
      setText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col border border-border rounded-sm bg-card h-[500px] lg:h-full">
      <div className="border-b border-border px-3 py-2 font-mono text-xs text-primary">
        [ LIVE CHAT ]
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
        {messages.length === 0 && (
          <div className="font-mono text-xs text-muted-foreground">
            No messages yet. Say hi 👋
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="break-words">
            <span className="font-mono text-xs text-primary mr-2">
              {m.display_name || "anon"}
            </span>
            <span>{m.body}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={submit} className="border-t border-border p-2 flex gap-2">
        {address && isAuthenticated ? (
          <>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="say something…"
              maxLength={500}
              className="flex-1 bg-background border border-border rounded-sm px-2 py-1 text-sm font-mono focus:outline-none focus:border-primary"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="px-3 py-1 bg-primary text-primary-foreground rounded-sm font-mono text-xs disabled:opacity-50"
            >
              send
            </button>
          </>
        ) : (
          <div className="w-full text-center font-mono text-xs text-muted-foreground py-1">
            Sign in to chat
          </div>
        )}
      </form>
    </div>
  );
}