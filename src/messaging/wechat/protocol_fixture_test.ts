// Ported from internal/messaging/wechat/protocol_fixture_test.go
//
// The Go `go:embed testdata/tencent-2.4.6/*.json` fixtures are read through
// `import.meta.url` (the same asset pattern used for other embedded resources).

import { assertEquals } from "@std/assert";

import { decodeAESKey } from "./crypto.ts";
import { Client, type FetchLike, getUploadURL } from "./protocol.ts";
import {
  type GetUploadURLRequest,
  type GetUploadURLResponse,
  ItemVoice,
  MessageTypeUser,
  UploadMediaFile,
  UploadMediaImage,
  UploadMediaVideo,
  type WireMessage,
} from "./types.ts";
import { Bot } from "./wechat.ts";

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/tencent-2.4.6/${name}`, import.meta.url),
  );
}

function fixtureJSON(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

function backgroundSignal(): AbortSignal {
  return new AbortController().signal;
}

// ItemVoice is referenced only to keep the shared vocabulary explicit in tests.
void ItemVoice;

Deno.test("Tencent246FixtureManifestAndWireContract", () => {
  const metadata = fixtureJSON("manifest.json") as {
    package: string;
    version: string;
    author: string;
    npmIntegrity: string;
    tarballSHA512: string;
    gitHead: string;
    evidenceFiles: string[];
    sourceContract: {
      getUploadURLMethod: string;
      cdnUploadMethod: string;
      noNeedThumb: boolean;
      aesKeyEncoding: string;
      imageMediaType: number;
      videoMediaType: number;
      fileMediaType: number;
      ambiguousClientID: string;
    };
    realBotVerified: boolean;
  };
  assertEquals(metadata.package, "@tencent-weixin/openclaw-weixin");
  assertEquals(metadata.version, "2.4.6");
  assertEquals(metadata.author, "Tencent");
  assertEquals(metadata.npmIntegrity.startsWith("sha512-"), true);
  assertEquals(metadata.tarballSHA512.length, 128);
  assertEquals(metadata.gitHead.length, 40);
  assertEquals(metadata.realBotVerified, false);
  assertEquals(metadata.evidenceFiles, [
    "src/api/api.ts",
    "src/api/types.ts",
    "src/cdn/upload.ts",
    "src/cdn/cdn-upload.ts",
    "src/messaging/send.ts",
  ]);
  const contract = metadata.sourceContract;
  assertEquals(contract.getUploadURLMethod, "POST");
  assertEquals(contract.cdnUploadMethod, "POST");
  assertEquals(contract.noNeedThumb, true);
  assertEquals(contract.aesKeyEncoding, "base64-ascii-hex");
  assertEquals(contract.imageMediaType, UploadMediaImage);
  assertEquals(contract.videoMediaType, UploadMediaVideo);
  assertEquals(contract.fileMediaType, UploadMediaFile);
  assertEquals(contract.ambiguousClientID, "uncertain");

  const wire = fixtureJSON("inbound-media.json") as WireMessage;
  assertEquals(wire.message_id, 42);
  assertEquals(wire.message_type, MessageTypeUser);
  assertEquals((wire.context_token ?? "") !== "", true);
  assertEquals(wire.item_list?.length, 5);
  const attachments = new Bot({}).inboundAttachments(
    wire,
  );
  assertEquals(attachments.length, 5);
  const wantKinds = ["image", "audio", "file", "video", "file"];
  for (let index = 0; index < attachments.length; index++) {
    assertEquals(attachments[index].kind, wantKinds[index]);
    assertEquals(attachments[index].reference.includes("fixture-"), false);
  }
});

Deno.test("Tencent246FixtureAESKeyEncodingMatchesPackageContract", () => {
  const payload = fixtureJSON("sendmessage-image.json") as {
    msg: {
      item_list: Array<{
        image_item?: { media?: { aes_key?: string } };
      }>;
    };
  };
  assertEquals(payload.msg.item_list.length, 1);
  const encoded = payload.msg.item_list[0].image_item?.media?.aes_key ?? "";
  assertEquals(encoded !== "", true);
  const decoded = atob(encoded);
  assertEquals(decoded, "30313233343536373839616263646566");
  const key = decodeAESKey(encoded);
  assertEquals(new TextDecoder().decode(key), "0123456789abcdef");
});

Deno.test("Tencent246FixtureUploadHTTPContract", async () => {
  const fixtureRequest = fixtureJSON("getuploadurl-request.json") as Record<
    string,
    unknown
  >;
  const fixtureResponse = fixtureText("getuploadurl-response.json");
  let gotRequest: Record<string, unknown> = {};
  const fetchFn: FetchLike = (_input, init) => {
    const url = new URL(String(_input));
    if (init?.method !== "POST" || url.pathname !== "/ilink/bot/getuploadurl") {
      throw new Error(`fixture request = ${init?.method} ${url.pathname}`);
    }
    const headers = new Headers(init.headers);
    if (
      headers.get("Authorization") !== "Bearer fixture-token" ||
      headers.get("AuthorizationType") !== "ilink_bot_token"
    ) {
      throw new Error("fixture auth headers are incomplete");
    }
    gotRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Promise.resolve(new Response(fixtureResponse, { status: 200 }));
  };
  const client = new Client(fetchFn);
  const response = await getUploadURL(
    client,
    backgroundSignal(),
    "https://ilink.example.invalid",
    "fixture-token",
    fixtureRequest as unknown as GetUploadURLRequest,
  );
  const typed = response as GetUploadURLResponse;
  assertEquals(typed.upload_param, "fixture-upload-param");
  assertEquals((typed.upload_full_url ?? "") !== "", true);
  for (
    const key of [
      "filekey",
      "media_type",
      "to_user_id",
      "rawsize",
      "rawfilemd5",
      "filesize",
      "no_need_thumb",
      "aeskey",
    ]
  ) {
    assertEquals(
      String(gotRequest[key]),
      String(fixtureRequest[key]),
      `request field ${key}`,
    );
  }
});

Deno.test("Tencent246FixtureIntegrityValueIsSelfConsistent", () => {
  const metadata = fixtureJSON("manifest.json") as {
    npmIntegrity: string;
    tarballSHA512: string;
  };
  assertEquals(metadata.npmIntegrity.startsWith("sha512-"), true);
  assertEquals(
    metadata.npmIntegrity,
    "sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==",
  );
  assertEquals(
    metadata.tarballSHA512,
    "ab0f64dcf2d388c5863638ec9271e071331a9c7d70e23f898b502b5886982ca0aadda151b15c1caa73e2d76edbbcea15309196e1d6f227c344084320a0efa247",
  );
});
