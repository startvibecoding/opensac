import { assertEquals } from "../compat/assert.ts";
import {
  type Event,
  eventToolCall,
  eventToolExecutionEnd,
  eventToolExecutionStart,
  eventToolResult,
  type Message,
  roleAssistant,
} from "../../sdk/agent/mod.ts";
import { EvidenceTracker, finalAssistantResponse } from "./evidence.ts";
import { test } from "#testing";

test("FinalAssistantResponse prefers content and falls back to blocks", () => {
  let messages: Message[] = [
    { role: roleAssistant, content: "first answer" },
    {
      role: roleAssistant,
      contents: [
        { type: "thinking", thinking: "ignore" },
        { type: "text", text: "block " },
        { type: "text", text: "answer" },
      ],
    },
  ];
  assertEquals(finalAssistantResponse(messages), "block answer");

  messages = [
    ...messages,
    { role: roleAssistant, content: "plain content" },
  ];
  assertEquals(finalAssistantResponse(messages), "plain content");

  assertEquals(
    finalAssistantResponse([{ role: "user", content: "hi" }]),
    "",
  );
});

test("EvidenceTracker counts unique tool calls and errors", () => {
  const tracker = new EvidenceTracker();
  const events: Event[] = [
    {
      agentId: "a",
      type: eventToolExecutionStart,
      toolCallId: "call-1",
      toolName: "read",
    },
    {
      agentId: "a",
      type: eventToolCall,
      toolCallId: "call-1",
      toolName: "read",
    },
    { agentId: "a", type: eventToolExecutionStart, toolName: "bash" },
    {
      agentId: "a",
      type: eventToolExecutionEnd,
      toolCallId: "call-1",
      toolError: new Error("denied"),
    },
    {
      agentId: "a",
      type: eventToolResult,
      toolCallId: "call-2",
      toolError: new Error("failed"),
    },
  ];
  for (const ev of events) tracker.observe(ev);

  const { toolCalls, toolNames, toolError } = tracker.summary();
  assertEquals(toolCalls, 2);
  assertEquals(toolNames.get("read"), 2);
  assertEquals(toolNames.get("bash"), 1);
  assertEquals(toolError.get("call-1"), true);
  assertEquals(toolError.get("call-2"), true);
  assertEquals(toolError.size, 2);
});
