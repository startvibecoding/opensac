import { assertEquals } from "@std/assert";
import { Generator, maxTitleRunes, normalizeTitle } from "./title.ts";
import {
  type ChatParams,
  type Model,
  newUserMessage,
  type Provider,
  streamError,
  type StreamEvent,
  streamTextDelta,
} from "../../provider/mod.ts";

class RecordingProvider implements Provider {
  params?: ChatParams;
  events: StreamEvent[];

  constructor(events: StreamEvent[]) {
    this.events = events;
  }

  chat(params: ChatParams): AsyncIterable<StreamEvent> {
    this.params = params;
    const events = this.events;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  name(): string {
    return "test";
  }

  api(): string {
    return "test-api";
  }

  models(): Model[] {
    return [{ id: "model" } as Model];
  }

  getModel(id: string): Model {
    return { id } as Model;
  }
}

Deno.test("GeneratorUsesCommonProviderInterfaceAndNormalizes", async () => {
  const p = new RecordingProvider([
    { type: streamTextDelta, textDelta: '  "修复登录问题\n' },
    { type: streamTextDelta, textDelta: '并补充测试"  ' },
  ]);
  const name = await new Generator({
    provider: p,
    model: { id: "model" } as Model,
  })
    .generate([newUserMessage("请修复登录")]);
  assertEquals(name, "修复登录问题 并补充测试");
  assertEquals(p.params?.modelId, "model");
  assertEquals(p.params?.messages.length, 2);
});

Deno.test("GeneratorFallsBackWhenProviderFails", async () => {
  const p = new RecordingProvider([
    { type: streamError, error: new Error("provider down") },
  ]);
  const name = await new Generator({
    provider: p,
    model: { id: "model" } as Model,
  })
    .generate([newUserMessage("hi")]);
  assertEquals(name, "hi");
});

Deno.test("NormalizeLimitsUnicodeTitle", () => {
  const got = normalizeTitle("###" + "界" + "界".repeat(50));
  assertEquals([...got].length, maxTitleRunes);
});

Deno.test("NormalizeReproducesGoOverEscapedCutset", () => {
  // Go's cutset includes a literal backslash and the letter `t`.
  assertEquals(normalizeTitle(" test "), "es");
  assertEquals(normalizeTitle("#title#"), "itle");
});
