//
// Provider-neutral conversation title generation through the common provider
// interface. Provider-specific request/response handling stays inside the
// provider adapters.
//
// Deviation: Go returns `(string, error)`; this port returns `Promise<string>`
// and throws a typed `Error`.

import {
  type ChatParams,
  type Message,
  type Model,
  newUserMessage,
  type Provider,
  streamError,
  streamTextDelta,
  thinkingOff,
} from "../../provider/mod.ts";

export const maxTitleRunes = 50;
export const titlePrompt =
  "Based on this conversation, give it a concise display title. Reply with only the title, without quotes, markdown, or explanation. Use the user's language. Keep it under 50 characters.";
export const titleSystem =
  "You create short conversation titles. Return only one plain-text title.";

/** Thrown when the title model returns an empty title. */
export class EmptyTitleError extends Error {
  constructor() {
    super("title model returned an empty title");
    this.name = "EmptyTitleError";
  }
}

/**
 * Generates short display titles through the common provider interface.
 * Provider-specific request and response handling stays inside the provider
 * adapters.
 */
export class Generator {
  provider?: Provider;
  model?: Model;

  constructor(init: { provider?: Provider; model?: Model } = {}) {
    this.provider = init.provider;
    this.model = init.model;
  }

  /** Creates a normalized title from the supplied conversation. */
  async generate(messages: Message[]): Promise<string> {
    if (this.provider === undefined) {
      throw new Error("title provider is required");
    }
    if (this.model === undefined) {
      throw new Error("title model is required");
    }
    if (messages.length === 0) {
      throw new EmptyTitleError();
    }
    const fallback = fallbackTitle(messages);

    const input: Message[] = [...messages];
    input.push(newUserMessage(titlePrompt));
    let raw = "";
    const params: ChatParams = {
      messages: input,
      systemPrompt: titleSystem,
      modelId: this.model.id,
      maxTokens: 32,
      thinkingLevel: thinkingOff,
    };
    for await (const event of this.provider.chat(params)) {
      switch (event.type) {
        case streamTextDelta:
          raw += event.textDelta ?? "";
          break;
        case streamError:
          if (fallback !== "") {
            return fallback;
          }
          if (event.error !== undefined) {
            throw event.error;
          }
          throw new Error("title provider returned an error");
      }
    }

    const name = normalizeTitle(raw);
    if (name === "") {
      if (fallback !== "") {
        return fallback;
      }
      throw new EmptyTitleError();
    }
    return name;
  }
}

/**
 * Creates a useful local title from the first user message when the title model
 * is unavailable or returns no text.
 */
export function fallbackTitle(messages: Message[]): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const name = normalizeTitle(messageText(message));
    if (name !== "") {
      return name;
    }
  }
  return "";
}

function messageText(message: Message): string {
  if ((message.content ?? "").trim() !== "") {
    return message.content ?? "";
  }
  const parts: string[] = [];
  for (const block of message.contents ?? []) {
    if ((block.text ?? "").trim() !== "") {
      parts.push(block.text ?? "");
    }
  }
  return parts.join(" ");
}

// Go's cutset literal is over-escaped: `" \\t\\\"'`#"` decodes to the character
// set {' ', '\', 't', '"', "'", '`', '#'} — notably including a literal
// backslash and the letter `t`. This port reproduces that exact behavior.
const trimCutset = /^[ \\t"'`#]+|[ \\t"'`#]+$/g;

/**
 * Removes common model formatting and limits a title by Unicode code points so
 * multibyte languages are not cut by byte length.
 */
export function normalizeTitle(raw: string): string {
  let name = raw.replace(/\n/g, " ").replace(/\r/g, " ").trim();
  name = name.replace(trimCutset, "");
  const runes = [...name];
  if (runes.length > maxTitleRunes) {
    name = runes.slice(0, maxTitleRunes).join("");
  }
  return name;
}
