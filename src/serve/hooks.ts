// Ported from internal/serve/hooks/hooks.go — shell hook scripts for serve
// channels. Hooks are external scripts called before/after tool execution,
// communicating via JSON on stdin/stdout.
//
// Deviations: os/exec.CommandContext maps to Deno.Command with an
// AbortSignal.timeout carrying the manager timeout; the post-tool-call
// goroutine maps to a fire-and-forget async task.

export const HOOK_TIMEOUT_MS = 10_000;

/** Manager manages pre/post tool call hooks. */
export class HookManager {
  #preToolCall: string;
  #postToolCall: string;
  #timeoutMS: number;

  constructor(preToolCall: string, postToolCall: string) {
    this.#preToolCall = preToolCall;
    this.#postToolCall = postToolCall;
    this.#timeoutMS = HOOK_TIMEOUT_MS;
  }

  /** Returns true if a pre_tool_call hook is configured. */
  hasPreHook(): boolean {
    return this.#preToolCall !== "";
  }

  /** Returns true if a post_tool_call hook is configured. */
  hasPostHook(): boolean {
    return this.#postToolCall !== "";
  }

  /**
   * PreToolCall runs the pre_tool_call hook. If no hook is configured, allows.
   * Hook failures fail open: the error is returned but the decision is allow.
   */
  async preToolCall(
    signal: AbortSignal,
    tool: string,
    args: Record<string, unknown>,
    platform: string,
    userID: string,
  ): Promise<{ allowed: boolean; reason: string }> {
    if (this.#preToolCall === "") {
      return { allowed: true, reason: "" };
    }

    const req = {
      hook: "pre_tool_call",
      tool,
      args,
      platform,
      user_id: userID,
    };

    let output: Uint8Array;
    try {
      output = await this.#runScript(signal, this.#preToolCall, req);
    } catch (err) {
      // Hook failure = allow by default (fail open)
      throw new Error(`pre_tool_call hook error: ${errorMessage(err)}`);
    }

    let resp: { action?: string; reason?: string };
    try {
      resp = JSON.parse(new TextDecoder().decode(output));
    } catch (err) {
      throw new Error(
        `pre_tool_call hook: invalid JSON response: ${errorMessage(err)}`,
      );
    }

    switch ((resp.action ?? "").toLowerCase()) {
      case "block":
        return { allowed: false, reason: resp.reason ?? "" };
      case "allow":
      case "":
        return { allowed: true, reason: "" };
      default:
        throw new Error(
          `pre_tool_call hook: unknown action ${JSON.stringify(resp.action)}`,
        );
    }
  }

  /** PostToolCall runs the post_tool_call hook (fire-and-forget). */
  postToolCall(
    signal: AbortSignal,
    tool: string,
    args: Record<string, unknown>,
    result: string,
    errMsg: string,
    platform: string,
    userID: string,
  ): void {
    if (this.#postToolCall === "") {
      return;
    }

    const req = {
      hook: "post_tool_call",
      tool,
      args,
      result,
      error: errMsg,
      platform,
      user_id: userID,
    };

    // Fire and forget — don't block the agent loop
    void this.#runScript(signal, this.#postToolCall, req).catch(() => {});
  }

  /** Executes a hook script with JSON input on stdin, returns stdout. */
  async #runScript(
    signal: AbortSignal,
    scriptPath: string,
    input: unknown,
  ): Promise<Uint8Array> {
    // Check script exists
    try {
      await Deno.stat(scriptPath);
    } catch {
      throw new Error(`hook script not found: ${scriptPath}`);
    }

    const inputJSON = JSON.stringify(input);
    const abort = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMS),
    ]);

    const command = new Deno.Command(scriptPath, {
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: abort,
    });
    const child = command.spawn();
    // Go's exec ignores EPIPE when copying stdin into a child that exits
    // without reading it; match that tolerance here.
    try {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(inputJSON));
      writer.releaseLock();
      child.stdin.close();
    } catch {
      // ignore stdin delivery failures
    }

    const output = await child.output();
    if (!output.success) {
      throw new Error(
        `hook script exited with code ${output.code}: ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    return output.stdout;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
