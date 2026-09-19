// Ported from internal/messaging/wechat/auth.go

import { dirname } from "@std/path";
import {
  type Client,
  DefaultBaseURL,
  getQRCode,
  pollQRStatus,
} from "./protocol.ts";
import type { Credentials } from "./types.ts";

const maxQRRefreshCount = 3;
const fixedQRBaseURL = "https://ilinkai.weixin.qq.com";

/** LoadCredentials loads stored credentials from disk. */
export function loadCredentials(path: string): Credentials | null {
  let data: string;
  try {
    data = Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw err;
  }
  return JSON.parse(data) as Credentials;
}

/** SaveCredentials persists credentials to disk. */
export function saveCredentials(creds: Credentials, path: string): void {
  Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data = JSON.stringify(creds, null, 2);
  Deno.writeTextFileSync(path, data + "\n", { mode: 0o600 });
}

/** ClearCredentials removes stored credentials. */
export function clearCredentials(path: string): void {
  Deno.removeSync(path);
}

/** LoginOptions configures the login flow. */
export interface LoginOptions {
  baseURL?: string;
  credPath: string;
  force?: boolean;
  onQRURL?: (url: string) => void;
  onScanned?: () => void;
  onExpired?: () => void;
}

/**
 * Login performs QR code login, returning credentials. If stored credentials
 * exist and force is false, returns them directly.
 */
export async function login(
  signal: AbortSignal,
  client: Client,
  opts: LoginOptions,
): Promise<Credentials> {
  const baseURL = opts.baseURL && opts.baseURL !== ""
    ? opts.baseURL
    : DefaultBaseURL;

  if (!opts.force) {
    const creds = loadCredentials(opts.credPath);
    if (creds !== null) {
      return creds;
    }
  }

  let qrRefreshCount = 0;
  while (true) {
    qrRefreshCount++;
    if (qrRefreshCount > maxQRRefreshCount) {
      throw new Error(
        `QR code expired ${maxQRRefreshCount} times — login aborted`,
      );
    }

    const qr = await getQRCode(client, signal, fixedQRBaseURL);
    if (opts.onQRURL) {
      opts.onQRURL(qr.qrcode_img_content);
    } else {
      console.error(`Scan this URL in WeChat: ${qr.qrcode_img_content}`);
    }

    let lastStatus = "";
    let currentPollBaseURL = fixedQRBaseURL;
    while (true) {
      const status = await pollQRStatus(
        client,
        signal,
        currentPollBaseURL,
        qr.qrcode,
      );

      if (status.status !== lastStatus) {
        lastStatus = status.status;
        switch (status.status) {
          case "scaned":
            if (opts.onScanned) {
              opts.onScanned();
            } else {
              console.error("QR scanned — confirm in WeChat");
            }
            break;
          case "expired":
            if (opts.onExpired) {
              opts.onExpired();
            } else {
              console.error("QR expired — requesting new one");
            }
            break;
          case "confirmed":
            console.error("Login confirmed");
            break;
        }
      }

      if (status.status === "confirmed") {
        if (
          !status.bot_token || !status.ilink_bot_id || !status.ilink_user_id
        ) {
          throw new Error("login confirmed but missing credentials");
        }
        let resolvedBase = baseURL;
        if (status.baseurl) {
          resolvedBase = status.baseurl;
        }
        const creds: Credentials = {
          token: status.bot_token,
          baseUrl: resolvedBase,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        try {
          saveCredentials(creds, opts.credPath);
        } catch (err) {
          console.error(`Warning: could not save credentials: ${err}`);
        }
        return creds;
      }

      if (status.status === "scaned_but_redirect") {
        if (status.redirect_host) {
          currentPollBaseURL = "https://" + status.redirect_host;
          console.error(`IDC redirect → ${status.redirect_host}`);
        }
        await sleepCtx(signal, 2000);
        continue;
      }

      if (status.status === "expired") {
        break;
      }

      await sleepCtx(signal, 2000);
    }
  }
}

/**
 * sleepCtx waits for d ms or until the signal is aborted, whichever comes
 * first. It throws the abort reason if cancelled so polling loops can abort
 * promptly instead of blocking for the full duration.
 */
export function sleepCtx(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
