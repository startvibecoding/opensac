// Ported from the larksuite/oapi-sdk-go v3 IM/auth services used by the Feishu
// adapter. The Go SDK is replaced by a small raw-HTTP client over `fetch`
// (documented deviation: "Feishu SDK -> raw HTTP").
//
// Only the operations the adapter needs are implemented:
//   - tenant_access_token/internal
//   - im/v1/messages create
//   - im/v1/messages/{id}/reply
//   - im/v1/images upload
//   - im/v1/files upload
//   - im/v1/messages/{id}/resources/{key} download

export const feishuBaseURL = "https://open.feishu.cn";

/** FeishuApiError is a non-zero code / HTTP failure from the Feishu API. */
export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;

  constructor(code: number, message: string, httpStatus = 0) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface FeishuApiOptions {
  baseURL?: string;
  fetchFn?: typeof fetch;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

interface ApiEnvelope {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: unknown;
}

export interface UploadResult {
  key: string;
}

export interface ResourceDownload {
  bytes: Uint8Array;
  filename: string;
}

/** FeishuApi is the raw-HTTP Feishu Open Platform client. */
export class FeishuApi {
  readonly appID: string;
  readonly appSecret: string;
  private readonly baseURL: string;
  private readonly fetchFn: typeof fetch;
  private token: TokenState | null = null;

  constructor(appID: string, appSecret: string, opts: FeishuApiOptions = {}) {
    this.appID = appID;
    this.appSecret = appSecret;
    this.baseURL = (opts.baseURL ?? feishuBaseURL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** tenantAccessToken returns a cached (or freshly minted) tenant token. */
  async tenantAccessToken(signal: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.token !== null && this.token.expiresAt > now) {
      return this.token.token;
    }
    const res = await this.fetchFn(
      `${this.baseURL}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.appID,
          app_secret: this.appSecret,
        }),
        signal,
      },
    );
    const env = (await res.json()) as ApiEnvelope;
    if (!res.ok || (env.code ?? 0) !== 0 || !env.tenant_access_token) {
      throw new FeishuApiError(
        env.code ?? -1,
        env.msg ?? `feishu tenant_access_token HTTP ${res.status}`,
        res.status,
      );
    }
    const expire = env.expire ?? 7200;
    this.token = {
      token: env.tenant_access_token,
      // Refresh 60s before expiry.
      expiresAt: now + Math.max(60, expire - 60) * 1000,
    };
    return this.token.token;
  }

  private async authHeaders(signal: AbortSignal): Promise<Headers> {
    const token = await this.tenantAccessToken(signal);
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }

  private async decodeEnvelope(
    res: Response,
    context: string,
  ): Promise<ApiEnvelope> {
    let env: ApiEnvelope;
    try {
      env = (await res.json()) as ApiEnvelope;
    } catch {
      throw new FeishuApiError(
        -1,
        `${context}: HTTP ${res.status} with invalid JSON body`,
        res.status,
      );
    }
    if ((env.code ?? 0) !== 0) {
      throw new FeishuApiError(
        env.code ?? -1,
        `${context}: code=${env.code} msg=${env.msg}`,
        res.status,
      );
    }
    return env;
  }

  /**
   * createMessage sends a message to a chat (or open_id for legacy bindings).
   * receiveIDType is "chat_id" or "open_id".
   */
  async createMessage(
    signal: AbortSignal,
    receiveIDType: string,
    receiveID: string,
    msgType: string,
    content: string,
    uuid: string,
  ): Promise<void> {
    const body: Record<string, string> = {
      receive_id: receiveID,
      msg_type: msgType,
      content,
    };
    if (uuid.trim() !== "") {
      body.uuid = uuid;
    }
    const res = await this.fetchFn(
      `${this.baseURL}/open-apis/im/v1/messages?receive_id_type=${
        encodeURIComponent(receiveIDType)
      }`,
      {
        method: "POST",
        headers: await this.withJson(signal),
        body: JSON.stringify(body),
        signal,
      },
    );
    await this.decodeEnvelope(res, `feishu send ${msgType} message`);
  }

  /** replyMessage replies to a specific message. */
  async replyMessage(
    signal: AbortSignal,
    messageID: string,
    msgType: string,
    content: string,
    uuid: string,
  ): Promise<void> {
    const body: Record<string, string> = { msg_type: msgType, content };
    if (uuid.trim() !== "") {
      body.uuid = uuid;
    }
    const res = await this.fetchFn(
      `${this.baseURL}/open-apis/im/v1/messages/${
        encodeURIComponent(messageID)
      }/reply`,
      {
        method: "POST",
        headers: await this.withJson(signal),
        body: JSON.stringify(body),
        signal,
      },
    );
    await this.decodeEnvelope(res, `feishu reply ${msgType}`);
  }

  private async withJson(signal: AbortSignal): Promise<Headers> {
    const headers = await this.authHeaders(signal);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return headers;
  }

  /** uploadImage uploads image bytes and returns its image_key. */
  async uploadImage(
    signal: AbortSignal,
    image: Uint8Array,
  ): Promise<UploadResult> {
    const form = new FormData();
    form.set("image_type", "message");
    form.set(
      "image",
      new Blob([image as unknown as BlobPart]),
      "image",
    );
    const res = await this.fetchFn(`${this.baseURL}/open-apis/im/v1/images`, {
      method: "POST",
      headers: await this.authHeaders(signal),
      body: form,
      signal,
    });
    const env = await this.decodeEnvelope(res, "feishu upload image");
    const data = env.data as { image_key?: string } | undefined;
    const key = data?.image_key ?? "";
    if (key === "") {
      throw new FeishuApiError(
        env.code ?? -1,
        "feishu upload image: missing image_key",
      );
    }
    return { key };
  }

  /** uploadFile uploads file bytes and returns its file_key. */
  async uploadFile(
    signal: AbortSignal,
    filename: string,
    fileType: string,
    file: Uint8Array,
  ): Promise<UploadResult> {
    const form = new FormData();
    form.set("file_type", fileType);
    form.set("file_name", filename);
    form.set("file", new Blob([file as unknown as BlobPart]), filename);
    const res = await this.fetchFn(`${this.baseURL}/open-apis/im/v1/files`, {
      method: "POST",
      headers: await this.authHeaders(signal),
      body: form,
      signal,
    });
    const env = await this.decodeEnvelope(res, "feishu upload file");
    const data = env.data as { file_key?: string } | undefined;
    const key = data?.file_key ?? "";
    if (key === "") {
      throw new FeishuApiError(
        env.code ?? -1,
        "feishu upload file: missing file_key",
      );
    }
    return { key };
  }

  /** downloadMessageResource fetches an inbound image/file resource. */
  async downloadMessageResource(
    signal: AbortSignal,
    messageID: string,
    fileKey: string,
    resourceType: string,
  ): Promise<ResourceDownload> {
    const res = await this.fetchFn(
      `${this.baseURL}/open-apis/im/v1/messages/${
        encodeURIComponent(messageID)
      }/resources/${encodeURIComponent(fileKey)}?type=${
        encodeURIComponent(resourceType)
      }`,
      {
        method: "GET",
        headers: await this.authHeaders(signal),
        signal,
      },
    );
    if (!res.ok) {
      throw new FeishuApiError(
        -1,
        `feishu download ${resourceType}: HTTP ${res.status}`,
        res.status,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, filename: filenameFromDisposition(res.headers) };
  }
}

function filenameFromDisposition(headers: Headers): string {
  const disposition = headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  if (match === null) {
    return "";
  }
  try {
    return decodeURIComponent(match[1].replace(/[";]+$/, "").trim());
  } catch {
    return match[1].trim();
  }
}
