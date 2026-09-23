//
// Go attaches the `QuestionAsker` to `context.Context` via a private key; the
// port carries it on the `ToolContext`. The `AskQuestion` method is async.

import {
  createTextToolResult,
  questionAskerFromContext,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/**
 * The interface the tool uses to interact with the user. The agent implements
 * this via `RequestQuestion`.
 */
export interface QuestionAsker {
  askQuestion(
    ctx: ToolContext,
    question: string,
    options: string[],
    context: string,
  ): Promise<string> | string;
}

/** Asks the user a multiple-choice question during plan mode. */
export class QuestionTool implements Tool {
  // The registry argument is retained for parity with the Go constructor.
  constructor(_r: Registry) {}

  name(): string {
    return "question";
  }

  description(): string {
    return "Ask the user a question with predefined options to clarify requirements before forming a plan. The user selects an option or provides a custom answer.";
  }

  promptSnippet(): string {
    return "Ask the user a multiple-choice question to clarify requirements";
  }

  promptGuidelines(): string[] {
    return [
      "Use question when you need the user to make a decision or clarify requirements before planning",
      "Provide clear, concise options that cover the main choices",
      "The last option is always 'Custom input' — the user can type their own answer",
      "Use context to explain why you're asking and what each option means",
      "Ask one question at a time for clarity",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Predefined options for the user to choose from",
        },
        context: {
          type: "string",
          description:
            "Optional context or explanation for why you're asking this question",
        },
      },
      required: ["question", "options"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const question = typeof params["question"] === "string"
      ? params["question"] as string
      : "";
    if (question === "") {
      throw new Error("question is required");
    }

    const optionsRaw = params["options"];
    if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
      throw new Error("options array is required and must not be empty");
    }

    const options: string[] = [];
    for (let i = 0; i < optionsRaw.length; i++) {
      const opt = optionsRaw[i];
      if (typeof opt !== "string") {
        throw new Error(`option ${i} must be a string`);
      }
      options.push(opt.trim());
    }

    const explanation = typeof params["context"] === "string"
      ? params["context"] as string
      : "";

    const asker = questionAskerFromContext(ctx);
    if (!asker) {
      throw new Error(
        "question tool: no question handler available in context",
      );
    }

    const answer = await asker.askQuestion(
      ctx,
      question,
      options,
      explanation,
    );
    if (answer === "") {
      throw new Error("no answer received (user may have aborted)");
    }

    return createTextToolResult(`User answered: ${answer}\n`);
  }
}
