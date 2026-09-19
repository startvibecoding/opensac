// Translated from internal/skillhub/clawhub_ambiguous_test.go

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { newClawHubClient } from "./clawhub.ts";
import { Install as installSkill } from "./install.ts";
import { jsonResponse, makeArchive, startServer } from "./test_helpers.ts";

const ambiguousCustomMailPayload =
  `{"code":"AMBIGUOUS_SKILL_SLUG","message":"Found multiple skills with the slug \\"custom-mail-fresh100\\"; specify which one you want to install:","slug":"custom-mail-fresh100","matches":[{"ownerHandle":"xuxuclassmate","slug":"custom-mail-fresh100","ref":"@xuxuclassmate/custom-mail-fresh100","url":"https://clawhub.ai/xuxuclassmate/skills/custom-mail-fresh100"},{"ownerHandle":"xuxuclassmate","slug":"custom-mail","ref":"@xuxuclassmate/custom-mail","url":"https://clawhub.ai/xuxuclassmate/skills/custom-mail"}]}`;

Deno.test("ClawHubDetailResolvesAmbiguousSlug", async () => {
  const calls: string[] = [];
  const server = await startServer((request) => {
    const u = new URL(request.url);
    calls.push(u.searchParams.toString());
    if (!u.searchParams.get("owner")) {
      return new Response(ambiguousCustomMailPayload, {
        status: 409,
        statusText: "Conflict",
      });
    }
    return jsonResponse(
      `{"skill":{"slug":"custom-mail-fresh100","displayName":"Fresh Mail","summary":"mail","version":"1.2.0"}}`,
    );
  });
  try {
    const detail = await newClawHubClient(server.url).detail(undefined, {
      market: "clawhub.ai",
      id: "custom-mail-fresh100",
    });
    assertEquals(detail.id, "custom-mail-fresh100");
    assertEquals(detail.version, "1.2.0");
    assertEquals(detail.name, "Fresh Mail");
    assertEquals(calls.length, 2);
    assertEquals(calls[1], "owner=xuxuclassmate");
  } finally {
    await server.close();
  }
});

Deno.test("ClawHubDetailCachesResolvedOwner", async () => {
  const server = await startServer((request) => {
    const u = new URL(request.url);
    if (!u.searchParams.get("owner")) {
      return new Response(ambiguousCustomMailPayload, {
        status: 409,
        statusText: "Conflict",
      });
    }
    assertEquals(u.searchParams.get("owner"), "xuxuclassmate");
    return jsonResponse(
      `{"skill":{"slug":"custom-mail-fresh100","version":"1.2.0"}}`,
    );
  });
  try {
    const client = newClawHubClient(server.url);
    await client.detail(undefined, {
      market: "clawhub.ai",
      id: "custom-mail-fresh100",
    });
    const files = await client.files(undefined, {
      market: "clawhub.ai",
      id: "custom-mail-fresh100",
    }, "1.2.0");
    assertEquals(files.length, 0);
    const sources = client.downloadSources({
      market: "clawhub.ai",
      id: "custom-mail-fresh100",
    }, "1.2.0");
    assertEquals(sources.length, 1);
    assertStringIncludes(sources[0].url, "owner=xuxuclassmate");
  } finally {
    await server.close();
  }
});

Deno.test("ClawHubAmbiguousSlugWithoutExactMatchReturnsHelpfulError", async () => {
  const payload =
    `{"code":"AMBIGUOUS_SKILL_SLUG","message":"Found multiple skills with the slug \\"custom-mail-fresh100\\"; specify which one you want to install:","slug":"custom-mail-fresh100","matches":[{"ownerHandle":"alice","slug":"other-mail","ref":"@alice/other-mail","url":"https://clawhub.ai/alice/skills/other-mail"},{"ownerHandle":"bob","slug":"something-else","ref":"@bob/something-else","url":"https://clawhub.ai/bob/skills/something-else"}]}`;
  const server = await startServer(() =>
    new Response(payload, { status: 409, statusText: "Conflict" })
  );
  try {
    const error = await assertRejects(() =>
      newClawHubClient(server.url).detail(undefined, {
        market: "clawhub.ai",
        id: "custom-mail-fresh100",
      })
    );
    const message = (error as Error).message;
    assertStringIncludes(message, "@alice/other-mail");
    assertStringIncludes(message, "@bob/something-else");
    assertStringIncludes(message, "custom-mail-fresh100");
  } finally {
    await server.close();
  }
});

Deno.test("ClawHubInstallResolvesAmbiguousSlugEndToEnd", async () => {
  const archive = await makeArchive({ "SKILL.md": "# Mail\n" });
  const calls: string[] = [];
  const server = await startServer((request) => {
    const u = new URL(request.url);
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith("/download")) {
      if (!u.searchParams.get("owner")) {
        return new Response(ambiguousCustomMailPayload, {
          status: 409,
          statusText: "Conflict",
        });
      }
      return new Response(archive as unknown as BodyInit, {
        status: 200,
        statusText: "OK",
      });
    }
    if (!u.searchParams.get("owner")) {
      return new Response(ambiguousCustomMailPayload, {
        status: 409,
        statusText: "Conflict",
      });
    }
    return jsonResponse(
      `{"skill":{"slug":"custom-mail-fresh100","version":"1.2.0"}}`,
    );
  });
  try {
    const result = await installSkill(
      undefined,
      newClawHubClient(server.url),
      {
        market: "clawhub.ai",
        id: "custom-mail-fresh100",
        scope: "project",
        targetDir: await Deno.makeTempDir(),
      },
    );
    assert(result.installed);
    assertEquals(result.name, "custom-mail-fresh100");
    const seen = calls.some((call) =>
      call.endsWith("/download?owner=xuxuclassmate&version=1.2.0") ||
      call.endsWith("/download?version=1.2.0&owner=xuxuclassmate")
    );
    assert(seen, `owner-qualified download not attempted: ${calls.join(", ")}`);
  } finally {
    await server.close();
  }
});

Deno.test("ClawHubExplicitOwnerRefBypassesAmbiguity", async () => {
  const calls: string[] = [];
  const server = await startServer((request) => {
    const u = new URL(request.url);
    calls.push(u.searchParams.toString());
    if (!u.searchParams.get("owner")) {
      return new Response(ambiguousCustomMailPayload, {
        status: 409,
        statusText: "Conflict",
      });
    }
    return jsonResponse(
      `{"skill":{"slug":"custom-mail-fresh100","version":"1.2.0"}}`,
    );
  });
  try {
    const client = newClawHubClient(server.url);
    await client.detail(undefined, {
      market: "clawhub.ai",
      id: "@xuxuclassmate/custom-mail-fresh100",
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0], "owner=xuxuclassmate");
  } finally {
    await server.close();
  }
});
