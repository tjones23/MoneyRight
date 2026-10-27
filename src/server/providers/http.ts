import { request } from "node:https";

/**
 * The one way MoneyRight talks to a bank-data provider: HTTPS with a
 * timeout, and nothing logged.
 * Behind an interface so the sync code can be tested against fakes.
 */

export interface HttpRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 30_000;
const MAX_BODY = 5 * 1024 * 1024;

export const httpsTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== "https:") return reject(new Error("Providers are only reached over HTTPS"));
    const r = request(
      url,
      {
        method: req.method,
        headers: { Accept: "application/json", ...req.headers },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            r.destroy(new Error("Provider response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

/**
 * A provider said no. `code` is the provider's own error code — safe to
 * store and show; the message may not be, so it's only for the server log.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: "plaid",
    readonly status: number,
    readonly code: string,
    /** The person has to sign in to their bank again (update mode). */
    readonly needsReconnect: boolean,
    /** Worth trying again later: rate limits, the bank being down. */
    readonly transient: boolean,
  ) {
    super(`${provider} ${status} ${code}`);
  }
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
