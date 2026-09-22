// Subprocess helper for src/session/runtime_lease_bus_test.ts.
//
// Mirrors the Go TestRuntimeLeaseBusSubprocessHelper: the parent test spawns
// this file in a separate OS process, which subscribes to the host-only UDP
// bus and prints a line per received notification. Run with:
//   OPENSAC_RUNTIME_BUS_PORT=<port> OPENSAC_RUNTIME_BUS_HELPER_MODE=<mode> \
//     deno run --allow-net src/session/testdata/runtime_lease_bus_helper.ts

import {
  publishRuntimeLeaseNotification,
  runtimeLeaseBusDatabaseRebuilt,
  subscribeRuntimeLeaseNotifications,
  waitForRuntimeLeaseBusListener,
} from "../runtime_lease_bus.ts";

const mode = Deno.env.get("OPENSAC_RUNTIME_BUS_HELPER_MODE") ?? "";

if (mode === "publish_database_rebuilt") {
  // A peer process that rebuilt a database announces it to whoever is
  // listening on the shared port; it never listens itself.
  publishRuntimeLeaseNotification({
    type: runtimeLeaseBusDatabaseRebuilt,
    path: Deno.env.get("OPENSAC_RUNTIME_BUS_HELPER_PATH") ?? "",
    origin: "db",
  });
  // Give the fire-and-forget UDP send a tick to leave the process.
  await new Promise((resolve) => setTimeout(resolve, 250));
  Deno.exit(0);
}

const stop = subscribeRuntimeLeaseNotifications((notification) => {
  console.log(
    `received ${notification.type} ${notification.origin ?? ""} ${
      notification.originInstanceId ?? ""
    }`,
  );
  stop();
  setTimeout(() => Deno.exit(0), 50);
});

if (!await waitForRuntimeLeaseBusListener(5000)) {
  console.log("no-listener");
  Deno.exit(1);
}
console.log("ready");
await new Promise(() => {});
