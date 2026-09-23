/**
 * Deliberately scoped to the OpenAI Responses codec. Other providers can expose
 * the same provider-neutral observations without inheriting OpenAI request or
 * lifecycle semantics.
 */
export interface HostedToolDescriptor {
  type: string;
  capability: string;
  requestTypes: string[];
  executionMode: string;
  resumePolicy: string;
  attachmentKinds: string[];
}

export interface ResponsesHostedPolicy {
  maxCalls: number;
  maxCallsSet: boolean;
  /** timeout in milliseconds (Go time.Duration) */
  timeoutMs: number;
  configured: boolean;
}

/**
 * Single source for the hosted tools that this codec understands. Unknown
 * upstream types remain forward-compatible: they can still be archived as
 * canonical items, but do not acquire guessed execution or download behavior.
 */
export const responsesHostedToolRegistry: HostedToolDescriptor[] = [
  {
    type: "web_search_call",
    capability: "web_search",
    requestTypes: ["web_search", "web_search_preview"],
    executionMode: "hosted",
    resumePolicy: "poll",
    attachmentKinds: ["citation"],
  },
  {
    type: "file_search_call",
    capability: "file_search",
    requestTypes: ["file_search"],
    executionMode: "hosted",
    resumePolicy: "poll",
    attachmentKinds: ["citation", "file"],
  },
  {
    type: "code_interpreter_call",
    capability: "code_interpreter",
    requestTypes: ["code_interpreter"],
    executionMode: "hosted",
    resumePolicy: "poll",
    attachmentKinds: ["artifact", "file"],
  },
  {
    type: "image_generation_call",
    capability: "image_generation",
    requestTypes: ["image_generation"],
    executionMode: "hosted",
    resumePolicy: "poll",
    attachmentKinds: ["image"],
  },
  {
    type: "mcp_call",
    capability: "remote_mcp",
    requestTypes: ["mcp"],
    executionMode: "hosted",
    resumePolicy: "reconnect",
    attachmentKinds: [],
  },
  {
    type: "mcp_call_output",
    capability: "remote_mcp",
    requestTypes: ["mcp"],
    executionMode: "hosted",
    resumePolicy: "reconnect",
    attachmentKinds: [],
  },
];

export function hostedToolDescriptorForType(
  itemType: string,
): HostedToolDescriptor | undefined {
  return responsesHostedToolRegistry.find((d) => d.type === itemType);
}

export function hostedToolTypes(): string[] {
  return responsesHostedToolRegistry.map((d) => d.type);
}

export function hostedRequestCapabilities(): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const descriptor of responsesHostedToolRegistry) {
    for (const requestType of descriptor.requestTypes) {
      capabilities[requestType] = true;
    }
  }
  return capabilities;
}
