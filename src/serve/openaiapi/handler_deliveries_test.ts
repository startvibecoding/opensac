// Translated from internal/serve/openaiapi/handler_deliveries_test.go,
// adapted to the Response-returning handler projection. The route-table
// registration test stays with the route/lifecycle slice.
import { assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import {
  handleDeliveryFailuresAPI,
  handleDeliveryRetryAPI,
} from "./handler_deliveries.ts";
import type { Settings } from "../../config/settings.ts";
import { getSessionDir } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import {
  claimDeliveryOperation,
  createDeliveryPlan,
  type DeliveryPlan,
  getDeliveryOperation,
  updateDeliveryOperation,
} from "../../session/delivery_store.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-delivery-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

function serverFor(dir: string): Server {
  return new Server({
    pool: new SessionPool(0, 0),
    settings: settingsFor(dir),
  });
}

function deliveryGET(srv: Server, target: string): Response {
  return handleDeliveryFailuresAPI(
    srv,
    new Request(`http://localhost${target}`),
  );
}

function deliveryPOST(srv: Server, payload: string): Promise<Response> {
  return handleDeliveryRetryAPI(
    srv,
    new Request("http://localhost/api/deliveries/retry", {
      method: "POST",
      body: payload,
    }),
  );
}

async function jsonBody(resp: Response): Promise<Record<string, unknown>> {
  return await resp.json() as Record<string, unknown>;
}

/** deliveryAPI fixture: one session with a single delivery operation that can
 * be left pending or marked with a chosen failure. */
function deliveryAPIFixture(failureCode: string, status: string): Server {
  const dir = tempDir();
  const srv = serverFor(dir);
  createSession({
    workDir: dir,
    sessionDir: dir,
    id: "serve-delivery-session",
  });
  const sessionDir = dir;
  const sessionID = "serve-delivery-session";
  const started = new Date();
  new RunStore(sessionDir).create({
    id: "serve-delivery-run",
    sessionId: sessionID,
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: dir,
    source: "",
    model: "",
    mode: "",
    status: "completed",
    startedAt: started,
    finishedAt: started,
    error: "",
    errorInfo: {},
    progress: {},
    usage: {},
    contextUsage: {},
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  });
  const plan: DeliveryPlan = {
    intent: {
      id: "serve-delivery-intent",
      sessionId: sessionID,
      runId: "serve-delivery-run",
      platform: "wechat",
      targetId: "chat",
      replyMessageId: "",
      transportContext: null,
      status: "pending",
      createdAt: started,
      updatedAt: started,
    },
    operations: [
      {
        id: "serve-delivery-op",
        intentId: "serve-delivery-intent",
        operationKey: "caption",
        artifactId: "",
        operationKind: "send_text",
        sequence: 1,
        dependsOn: "",
        idempotencyKey: "serve-delivery-op",
        payloadDigest: "sha256:x",
        status: "pending",
        providerAssetId: "",
        providerMessageId: "",
        providerState: null,
        attemptCount: 0,
        nextAttemptAt: null,
        failureCode: "",
        retryWindowStartedAt: null,
        leaseOwner: "",
        leaseEpoch: 0,
        createdAt: started,
        updatedAt: started,
      },
    ],
  };
  createDeliveryPlan(sessionDir, plan);
  if (status !== "") {
    const claimed = claimDeliveryOperation(
      sessionDir,
      "serve-delivery-op",
      "serve-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "serve-delivery-op",
      "serve-worker",
      claimed.leaseEpoch,
      status,
      "",
      "",
      null,
      failureCode,
      null,
    );
  }
  return srv;
}

function deliveryItem(
  resp: Response,
  index = 0,
): Promise<Record<string, unknown>> {
  return deliveriesBody(resp).then((body) => {
    const list = body["deliveries"] as Record<string, unknown>[];
    return list[index];
  });
}

async function deliveriesBody(
  resp: Response,
): Promise<Record<string, unknown>> {
  if (resp.status !== 200) {
    throw new Error(`status ${resp.status} is not 200`);
  }
  return await resp.json() as Record<string, unknown>;
}

Deno.test("handleDeliveryFailuresAPI lists session failures with the retryable verdict", async () => {
  const srv = deliveryAPIFixture("transport_error", "failed");
  try {
    const resp = deliveryGET(
      srv,
      "/api/deliveries/failures?session_id=serve-delivery-session",
    );
    assertEquals(resp.status, 200);
    const item = await deliveryItem(resp);
    assertEquals(item["operationId"], "serve-delivery-op");
    assertEquals(item["platform"], "wechat");
    assertEquals(item["status"], "failed");
    assertEquals(item["failureCode"], "transport_error");
    assertEquals(item["retryable"], true);

    // A different session has no failures of its own.
    const other = deliveryGET(
      srv,
      "/api/deliveries/failures?session_id=other-session",
    );
    assertEquals(other.status, 200);
    const otherBody = await deliveriesBody(other);
    assertEquals(otherBody["count"], 0);

    // An invalid limit is rejected instead of silently clamped by the handler.
    const badLimit = deliveryGET(srv, "/api/deliveries/failures?limit=-1");
    assertEquals(badLimit.status, 400);
  } finally {
    closeAll();
  }
});

Deno.test("handleDeliveryFailuresAPI marks permanent failures not retryable", async () => {
  const srv = deliveryAPIFixture("unsupported_media_kind", "failed");
  try {
    const resp = deliveryGET(srv, "/api/deliveries/failures");
    assertEquals(resp.status, 200);
    assertEquals((await deliveryItem(resp))["retryable"], false);
  } finally {
    closeAll();
  }
});

Deno.test("handleDeliveryRetryAPI reopens only failed transport operations", async () => {
  const srv = deliveryAPIFixture("transport_error", "failed");
  try {
    const resp = await deliveryPOST(srv, `{"operationId":"serve-delivery-op"}`);
    assertEquals(resp.status, 200);
    const body = await jsonBody(resp);
    assertEquals(body["retried"], true);
    const operation = getDeliveryOperation(
      getSessionDir(srv.settings!),
      "serve-delivery-op",
    );
    assertEquals(operation?.status, "retry_wait");

    // A permanent failure is refused and stays failed.
    const permanentSrv = deliveryAPIFixture("unsupported_media_kind", "failed");
    const refused = await deliveryPOST(
      permanentSrv,
      `{"operationId":"serve-delivery-op"}`,
    );
    assertEquals(refused.status, 409);
    const permanent = getDeliveryOperation(
      getSessionDir(permanentSrv.settings!),
      "serve-delivery-op",
    );
    assertEquals(permanent?.status, "failed");
    assertEquals(permanent?.failureCode, "unsupported_media_kind");

    // A pending (in-flight) operation must not be clobbered back into retry_wait.
    const pendingSrv = deliveryAPIFixture("", "");
    const pending = await deliveryPOST(
      pendingSrv,
      `{"operationId":"serve-delivery-op"}`,
    );
    assertEquals(pending.status, 409);

    // An unknown operation is reported as missing.
    const unknown = await deliveryPOST(
      srv,
      `{"operationId":"missing-operation"}`,
    );
    assertEquals(unknown.status, 404);
  } finally {
    closeAll();
  }
});

Deno.test("handleDeliveryRetryAPI and handleDeliveryFailuresAPI validate method and payload", async () => {
  const srv = deliveryAPIFixture("transport_error", "failed");
  try {
    const listPost = handleDeliveryFailuresAPI(
      srv,
      new Request("http://localhost/api/deliveries/failures", {
        method: "POST",
      }),
    );
    assertEquals(listPost.status, 405);
    const retryGet = await handleDeliveryRetryAPI(
      srv,
      new Request("http://localhost/api/deliveries/retry"),
    );
    assertEquals(retryGet.status, 405);
    for (const payload of ["{}", `{"operationId":"   "}`, "not-json"]) {
      const resp = await deliveryPOST(srv, payload);
      assertEquals(resp.status, 400, payload);
    }
  } finally {
    closeAll();
  }
});
