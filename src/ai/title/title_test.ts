import { assertEquals } from "../../compat/assert.ts";
import { Generator, maxTitleRunes, normalizeTitle } from "./title.ts";
import {
  type ChatParams,
  createUserMessage,
  type Model,
  type Provider,
  streamError,
  type StreamEvent,
  streamTextDelta,
} from "../../provider/mod.ts";
import { test } from "#testing";

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

test("GeneratorUsesCommonProviderInterfaceAndNormalizes", async () => {
  const p = new RecordingProvider([
    { type: streamTextDelta, textDelta: '  "修复登录问题\n' },
    { type: streamTextDelta, textDelta: '并补充测试"  ' },
  ]);
  const name = await new Generator({
    provider: p,
    model: { id: "model" } as Model,
  })
    .generate([createUserMessage("请修复登录")]);
  assertEquals(name, "修复登录问题 并补充测试");
  assertEquals(p.params?.modelId, "model");
  assertEquals(p.params?.messages.length, 2);
});

test("GeneratorFallsBackWhenProviderFails", async () => {
  const p = new RecordingProvider([
    { type: streamError, error: new Error("provider down") },
  ]);
  const name = await new Generator({
    provider: p,
    model: { id: "model" } as Model,
  })
    .generate([createUserMessage("hi")]);
  assertEquals(name, "hi");
});

test("NormalizeLimitsUnicodeTitle", () => {
  const got = normalizeTitle("###" + "界" + "界".repeat(50));
  assertEquals([...got].length, maxTitleRunes);
});

test("NormalizeReproducesGoOverEscapedCutset", () => {
  // Go's cutset includes a literal backslash and the letter `t`.
  assertEquals(normalizeTitle(" test "), "es");
  assertEquals(normalizeTitle("#title#"), "itle");
});
