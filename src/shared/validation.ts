import { isIPv4 } from "node:net";

export interface BaseUrlValidationResult {
  ok: boolean;
  value?: string;
  reason?: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function uniqueNonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return Array.from(new Set(normalized));
}

/** Return the first boolean value in {@link values}, or `undefined` if none are booleans. */
export function readBooleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(normalized) || (isIPv4(normalized) && normalized.startsWith("127."));
}

function isPrivateNetworkHostname(hostname: string): boolean {
  if (!isIPv4(hostname)) return false;
  const [first, second] = hostname.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isBlockedMetadataHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "169.254.169.254" || normalized.startsWith("169.254.") || normalized === "metadata.google.internal";
}

export function validateBaseUrl(value: string, options: { allowLocalHttp?: boolean; allowPrivateHttp?: boolean } = {}): BaseUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "baseUrl must be a valid absolute URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "baseUrl must use http or https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "baseUrl must not contain credentials" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "baseUrl must not contain query strings or fragments" };
  }
  if (isBlockedMetadataHostname(parsed.hostname)) {
    return { ok: false, reason: "baseUrl host is not allowed for discovery" };
  }
  const httpHostAllowed =
    (options.allowLocalHttp === true && isLocalHostname(parsed.hostname)) ||
    (options.allowPrivateHttp === true && isPrivateNetworkHostname(parsed.hostname));
  if (parsed.protocol === "http:" && !httpHostAllowed) {
    return { ok: false, reason: "baseUrl must use https unless the host is local development (or a private-network IP with allowPrivateHttp enabled)" };
  }

  return { ok: true, value: parsed.toString().replace(/\/$/, "") };
}
