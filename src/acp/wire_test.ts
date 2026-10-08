// Translated tests from internal/acp/acp_mcp_test.go for the ACP JSON-RPC
// transport, plus focused coverage for the raw-id preservation helpers.

import { assert, assertEquals } from "@opensac/assert";
import { RPCError } from "../mcp/rpc.ts";
import {
  ACPLineReader,
  acpMaxRequestBytes,
  ACPRequestIDCounter,
  EmptyMessageError,
  readRequest,
  topLevelRawField,
  validRPCID,
  writeACPResponse,
} from "./wire.ts";

function readerFor(input: string): ACPLineReader {
  return new ACPLineReader(
    (async function* () {
      yield new TextEncoder().encode(input);
    })(),
  );
}

Deno.test("validRPCID rejects non-scalar ids", () => {
  for (const raw of ['{"x":1}', "[1]", "true", "1.5", "1e3"]) {
    assertEquals(validRPCID(raw), false, `validRPCID(${raw})`);
  }
  for (const raw of ['"request-1"', "1", "-42", "null"]) {
    assertEquals(validRPCID(raw), true, `validRPCID(${raw})`);
  }
  assertEquals(validRPCID(null), true);
});

Deno.test("readRequest rejects an oversized message", async () => {
  const reader = readerFor("x".repeat(acpMaxRequestBytes + 1) + "\n");
  await assertThrowsAsync(() => readRequest(reader));
});

Deno.test("readRequest preserves raw ids and decodes params", async () => {
  const reader = readerFor(
    '{"jsonrpc":"2.0","id":12,"method":"session/list","params":{"x":1}}\n',
  );
  const request = await readRequest(reader);
  assert(request !== null);
  assertEquals(request.idRaw, "12");
  assertEquals(request.method, "session/list");
  assertEquals(request.params, { x: 1 });

  const stringReader = readerFor(
    '{"jsonrpc":"2.0","id":"req-1","method":"initialize"}\n',
  );
  const stringRequest = await readRequest(stringReader);
  assertEquals(stringRequest?.idRaw, '"req-1"');

  const notification = await readRequest(
    readerFor('{"jsonrpc":"2.0","method":"notify"}\n'),
  );
  assertEquals(notification?.idRaw, null);
  assertEquals(notification?.method, "notify");
});

Deno.test("readRequest returns null at EOF and throws on a blank line", async () => {
  assertEquals(await readRequest(readerFor("")), null);
  await assertThrowsAsync(
    () => readRequest(readerFor("\n")),
    EmptyMessageError,
  );
});

Deno.test("readRequest throws on invalid JSON", async () => {
  await assertThrowsAsync(() => readRequest(readerFor("{not json}\n")));
});

Deno.test("writeACPResponse echoes the raw id and encodes errors", async () => {
  const chunks: string[] = [];
  const sink = { write: (data: string) => void chunks.push(data) };

  await writeACPResponse(sink, "1", { ok: true }, null);
  assertEquals(chunks[0], '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

  await writeACPResponse(sink, '"abc"', null, new RPCError(-32602, "bad"));
  assertEquals(
    chunks[1],
    '{"jsonrpc":"2.0","id":"abc","error":{"code":-32602,"message":"bad"}}\n',
  );

  // Notifications (absent / blank id) receive no response.
  await writeACPResponse(sink, null, null, null);
  await writeACPResponse(sink, "  ", null, null);
  assertEquals(chunks.length, 2);
});

Deno.test("topLevelRawField extracts nested-safe raw values", () => {
  const line =
    '{"jsonrpc":"2.0","id":{"a":1},"params":{"id":"nested"},"method":"x"}';
  assertEquals(topLevelRawField(line, "id"), '{"a":1}');
  assertEquals(topLevelRawField(line, "method"), '"x"');
  assertEquals(topLevelRawField(line, "missing"), undefined);
});

Deno.test("ACPRequestIDCounter increments", () => {
  const counter = new ACPRequestIDCounter();
  assertEquals(counter.next(), "acp-1");
  assertEquals(counter.next(), "acp-2");
});

async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  errorClass?: new (...args: never[]) => Error,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    if (errorClass !== undefined && !(error instanceof errorClass)) {
      throw new Error(
        `expected ${errorClass.name}, got ${(error as Error).name}`,
      );
    }
  }
  assert(threw, "expected an error");
}
