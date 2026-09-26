// deno-lint-ignore-file require-await -- async fake client models the Core seam
import { assert, assertEquals } from "@std/assert";
import { coreResult } from "../core/protocol.ts";
import { privateCoreConfig } from "../core/private_core.ts";
import { type CoreCommandHandle, startCoreCommand } from "../cli/core.ts";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import type { BridgeCoreClient } from "./bridge_client.ts";
import { ACPLineReader } from "./wire.ts";
import {
  defaultACPCoreDependencies,
  runACPCore,
  type RunTransport,
  standaloneACPCoreDependencies,
} from "./run.ts";

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

// ---------------------------------------------------------------------------
// Owned-resource disposal and `--standalone` private Core dependencies
// ---------------------------------------------------------------------------

const TEST_VERSION = "0.1.0-acp-run-test";
const TEST_PROTOCOL_VERSION = 3;

Deno.test("runACPCore disposes owned resources before closing the bridge", async () => {
  const client = new FakeCoreClient();
  const order: string[] = [];
  const io = transport('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  await runACPCore({}, io, {
    createClient: () => client,
    dispose: () => {
      order.push(`dispose:${client.closed}`);
    },
  });
  // dispose() runs while the bridge connection is still usable so an owned
  // private Core can be shut down through it.
  assertEquals(order, ["dispose:0"]);
  assertEquals(client.closed, 1);
});

Deno.test("default ACP dependencies select a private Core only for --standalone", () => {
  assertEquals(defaultACPCoreDependencies({}).dispose, undefined);
  assert(
    defaultACPCoreDependencies({ standalone: true }).dispose !== undefined,
  );
});

Deno.test("standalone ACP dependencies own and clean up a private Core", async () => {
  const parentDir = await Deno.makeTempDir({
    prefix: "opensac-acp-standalone-",
  });
  let ownedPromise: Promise<CoreCommandHandle> | undefined;
  try {
    const deps = standaloneACPCoreDependencies({
      version: TEST_VERSION,
      protocolVersion: TEST_PROTOCOL_VERSION,
      parentDir,
      createLauncher: (stateDir) => () => {
        ownedPromise = startCoreCommand({
          stateDir,
          config: privateCoreConfig(),
          version: TEST_VERSION,
          protocolVersion: TEST_PROTOCOL_VERSION,
        });
        return new Promise<void>(() => {});
      },
    });

    const client = await deps.createClient();
    const core = await ownedPromise;
    assert(core !== undefined);
    await client.connect();

    await deps.dispose?.();

    // The private Core exited cleanly and its state directory was removed;
    // the shared Core's state was never involved.
    assertEquals(await core.done, 0);
    for await (const _entry of Deno.readDir(parentDir)) {
      throw new Error("private Core state directory was not cleaned up");
    }
    await client.close();
  } finally {
    const core = await ownedPromise;
    if (core !== undefined) await core.stop();
    await Deno.remove(parentDir, { recursive: true });
  }
});
