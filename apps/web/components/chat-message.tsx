"use client";

import type { UIMessage } from "ai";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

/**
 * Renders a standard AI SDK `UIMessage` using AI Elements components:
 * `Message`/`MessageContent`/`MessageResponse` (streamdown markdown),
 * `Reasoning` (thinking block with auto-open/close while streaming), and
 * `Tool` (collapsible tool call with input/output + status badge).
 */
interface DynamicToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: string;
  title?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function isStreamingTool(part: DynamicToolPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

export function ChatMessage({ message }: { message: UIMessage }) {
  const textParts = message.parts.filter((p) => p.type === "text");
  const text = textParts.map((p) => (p as { text?: string }).text ?? "").join("");
  const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
  const reasoning = reasoningParts.map((p) => (p as { text?: string }).text ?? "").join("\n\n");
  const tools = message.parts.filter(
    (p) => p.type === "dynamic-tool",
  ) as unknown as DynamicToolPart[];

  const reasoningStreaming = reasoningParts.some(
    (p) => (p as { state?: string }).state === "streaming",
  );
  const toolStreaming = tools.some(isStreamingTool);
  const running = reasoningStreaming || toolStreaming;

  if (message.parts.length === 0) {
    return (
      <div className="rounded-md border bg-background/40 p-3 text-sm text-muted-foreground">
        <span className="animate-pulse">waiting for output…</span>
      </div>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        {reasoning ? (
          <Reasoning isStreaming={reasoningStreaming}>
            <ReasoningTrigger>
              <span className="font-medium">{reasoningStreaming ? "Working…" : "Thinking"}</span>
            </ReasoningTrigger>
            <ReasoningContent>{reasoning}</ReasoningContent>
          </Reasoning>
        ) : null}
        {tools.map((tool) => (
          <Tool key={tool.toolCallId ?? tool.toolName} defaultOpen={isStreamingTool(tool)}>
            <ToolHeader
              type="dynamic-tool"
              state={tool.state as "input-streaming"}
              toolName={tool.toolName}
              title={tool.title ?? tool.toolName}
            />
            <ToolContent>
              {tool.input !== undefined ? <ToolInput input={tool.input} /> : null}
              {tool.output !== undefined || tool.errorText !== undefined ? (
                <ToolOutput output={tool.output} errorText={tool.errorText} />
              ) : null}
            </ToolContent>
          </Tool>
        ))}
        {text ? (
          <MessageResponse>{text}</MessageResponse>
        ) : (
          !running &&
          tools.length === 0 &&
          reasoning.length === 0 && <p className="text-sm text-muted-foreground">_(no output)_</p>
        )}
      </MessageContent>
    </Message>
  );
}
