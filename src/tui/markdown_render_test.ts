import { assertEquals } from "@opensac/assert";
import type { ReactElement } from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { AppController } from "./app_controller.ts";
import { EVENT_TEXT_DELTA, EVENT_TURN_END } from "../agentruntime/events.ts";
import { Translator } from "./i18n.ts";
import { stripANSI } from "./renderutil.ts";
import { displayWidth } from "./formatters.ts";
import { visualWidth as markdownVisualWidth } from "../tsm/mod.ts";

class FakeStdout {
  columns = 20;
  rows = 40;
  isTTY = true;
  output = "";
  write(s: string | Uint8Array): boolean {
    this.output += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
  listenerCount(): number {
    return 0;
  }
  setEncoding(): this {
    return this;
  }
  end(): void {}
  hasColors(): boolean {
    return false;
  }
  getColorDepth(): number {
    return 1;
  }
}

Deno.test("assistant markdown rows stay within the TUI width", async () => {
  const controller = new AppController(new Translator("en"), {
    onMessage: () => {},
    scheduleRender: () => {},
    deliverQuestion: () => {},
  });
  const text = [
    "这是一段很长的中文说明，用于检查终端换行是否错位。",
    "",
    "这是一段中文里有**加粗文字**还有`行内代码`混排的句子，用于检查内联样式换行错位。",
    "",
    "- 列表项一也很长需要换行",
    "- 列表里带 **加粗** 和 `行内代码` 的长句子需要换行显示对齐",
    "",
    "```bash",
    "echo 这是一段很长的命令输出示例",
    "```",
  ].join("\n");
  controller.handleAgentEvent({
    type: EVENT_TEXT_DELTA,
    textDelta: text,
  } as never);
  controller.handleAgentEvent({ type: EVENT_TURN_END } as never);

  const stdout = new FakeStdout();
  const inst = render(
    App({ controller, width: 20 }) as ReactElement,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  inst.unmount();

  const rendered = stripANSI(stdout.output);
  const lines = rendered.split("\n").filter((l) => l !== "");
  for (const line of lines) {
    assertEquals(
      displayWidth(line) <= 20 && markdownVisualWidth(line) <= 20,
      true,
      `line too wide (${displayWidth(line)}/${markdownVisualWidth(line)}): ${
        JSON.stringify(line)
      }\n${rendered}`,
    );
  }
  assertEquals(/(^|\n)#[^\n]*标题/m.test(rendered), false, rendered);
  assertEquals(rendered.includes("```bash"), false, rendered);
  assertEquals(/(^|\n)-\s+列表项一/m.test(rendered), false, rendered);
  // Inline styles are rendered, not printed verbatim: literal ** and
  // backticks surviving into the output mean the span broke the wrap.
  assertEquals(rendered.includes("**"), false, rendered);
  assertEquals(rendered.includes("`"), false, rendered);
});
