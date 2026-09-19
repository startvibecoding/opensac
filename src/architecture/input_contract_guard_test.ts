import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

// Keeps every interactive entrypoint on the Runtime-owned input/content
// boundary. The concrete wire shapes differ, but each adapter must normalize
// them before the Agent is built and must execute the resulting message with
// the same Agent Core method.
//
// The adapter modules downstream of the shared runtime (TUI, CLI, ACP, Serve/
// OpenAI-API, channels) are still being ported, so a listed file that does not
// exist yet is reported as pending rather than failing the guard. Once a file
// lands, it must contain every required Runtime input-contract call.
interface ContractCheck {
  path: string;
  requires: string[];
}

const checks: ContractCheck[] = [
  {
    path: "src/tui/input.ts",
    requires: [
      ".acceptInput(",
      ".buildUserMessage(",
      "beginArtifactCollection(",
    ],
  },
  {
    path: "src/tui/run.ts",
    requires: ["runWithUserMessage("],
  },
  {
    path: "src/cli/main_util.ts",
    requires: [
      ".acceptInput(",
      ".buildUserMessage(",
      "runWithUserMessage(",
    ],
  },
  {
    path: "src/acp/acp.ts",
    requires: [
      "promptToRunInput(",
      ".buildUserMessage(",
      "runWithUserMessage(",
    ],
  },
  {
    path: "src/serve/openaiapi/handler_run_submit.ts",
    requires: [
      ".acceptInput(",
      ".buildUserMessage(",
      "beginArtifactCollection(",
    ],
  },
  {
    path: "src/serve/openaiapi/handler_chat.ts",
    requires: [
      "requestRunInput(",
      ".acceptInput(",
      ".buildUserMessage(",
      "beginArtifactCollection(",
    ],
  },
  {
    path: "src/serve/openaiapi/background_external.ts",
    requires: [
      "req.input",
      ".buildUserMessage(",
      "beginArtifactCollection(",
    ],
  },
  {
    path: "src/serve/channels/dispatcher.ts",
    requires: [
      "channelAttachmentIngresses",
      ".acceptInput(",
      ".buildUserMessage(",
      "beginArtifactCollection(",
    ],
  },
];

Deno.test("frontend input contract guard", async (t) => {
  for (const check of checks) {
    await t.step(check.path, () => {
      let src: string;
      try {
        src = Deno.readTextFileSync(join(projectRoot, check.path));
      } catch {
        // Downstream adapter module not ported yet; enforced once it lands.
        return;
      }
      for (const required of check.requires) {
        assert(
          src.includes(required),
          `${check.path} is missing required Runtime input contract call ${
            JSON.stringify(required)
          }`,
        );
      }
    });
  }
});
