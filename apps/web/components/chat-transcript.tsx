"use client";

import { useMemo } from "react";
import { ChatMessage } from "@/components/chat-message";
import { buildUIMessages, type StreamEntry } from "@/lib/transcript";

/**
 * Server-component friendly transcript renderer. Converts the raw
 * session event rows into the standard Vercel AI SDK `UIMessage` format
 * and renders them via AI Elements' `Message` components.
 */
export function ChatTranscript({ transcript }: { transcript: StreamEntry[] }) {
  const messages = useMemo(() => buildUIMessages(transcript), [transcript]);
  if (messages.length === 0) {
    return (
      <div className="rounded-md border bg-background/40 p-3 text-sm text-muted-foreground">
        <span className="animate-pulse">waiting for output…</span>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
    </div>
  );
}
