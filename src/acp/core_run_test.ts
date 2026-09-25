// deno-lint-ignore-file require-await -- async fake client models the Core seam
import { assertEquals } from "@std/assert";
import { coreResult } from "../core/protocol.ts";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import type { BridgeCoreClient } from "./bridge_client.ts";
import { ACPLineReader } from "./wire.ts";
import { runACPCore, type RunTransport } from "./run.ts";

class FakeCoreClient implements BridgeCoreClient {
  closed = 0;
  calls: string[] = [];

  async connect(): Promise<void> {}

  async callCore(request: import("../core/protocol.ts").CoreRpcRequest) {
    this.calls.push(request.method);
    return coreResult(request.id, {
      version: "test",
      protocolVersion: 1,
      coreProtocolVersion: 1,
      features: [],
    });
  }

  async subscribe(): Promise<void> {}
  async replay(): Promise<unknown> {
    return [];
  }
  onEvent(_listener: (event: CoreRuntimeEvent) => void): () => void {
    return () => undefined;
  }
  onReverseRequest(
    _listener: (
      request: import("./bridge_protocol.ts").CoreServerRequest,
    ) => void,
  ): () => void {
    return () => undefined;
  }
  respondToReverseRequest(): void {}
  async close(): Promise<void> {
    this.closed++;
  }
  async reconnect(): Promise<void> {}
}

function transport(input: string): RunTransport {
  const bytes = new TextEncoder().encode(input);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const output: string[] = [];
  return {
    reader: new ACPLineReader(stream),
    sink: {
      write(line) {
        output.push(line);
      },
    },
    output,
  } as RunTransport & { output: string[] };
}

Deno.test("runACPCore bridges initialize over Core and closes on EOF", async () => {
  const client = new FakeCoreClient();
  const io = transport('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  await runACPCore({}, io, { createClient: () => client });

  assertEquals(client.calls, ["core.info"]);
  assertEquals(client.closed, 1);
  const output = (io as RunTransport & { output: string[] }).output;
  assertEquals(JSON.parse(output[0]).id, 1);
  assertEquals(JSON.parse(output[0]).result.protocolVersion, 1);
});
