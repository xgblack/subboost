import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  createSubscriptionImportErrorInfo,
  inferSubscriptionImportErrorCategory,
  sanitizePublicErrorText,
} from "@subboost/core/subscription/import-error";
import {
  importSubscriptionFromUrl,
  SUBSCRIPTION_IMPORT_USER_AGENTS,
  type SourceImportRequest,
  type SourceImportResult,
  type SourceImportTransportRequest,
  type SourceImportTransportResult,
} from "@subboost/server-core/subscription";
import { resolveHostnameByDoh } from "@subboost/server-core/subscription/doh-resolver";
import { awaitWithSignal, createRequestDeadline } from "@subboost/server-core/subscription/request-deadline";
import {
  isPrivateOrReservedIp,
  normalizeResolvedIpAddresses,
  selectDnsAddressesAfterFakeIpRecheck,
  shouldRecheckFakeIpDnsAnswers,
} from "@subboost/server-core/subscription/ssrf-ip";
import { getAllowUnsafeSubscriptionSources } from "./source-import-settings";
import { requestPinnedText, ResponseTooLargeError, type DirectHttpResponse } from "./pinned-http";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const USERINFO_TIMEOUT_MS = 8000;
const USERINFO_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const DOH_TIMEOUT_MS = 4000;

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function toFailure(message: string, status?: number): SourceImportTransportResult {
  const sanitized = sanitizePublicErrorText(message) || "获取 url 失败";
  return {
    ok: false,
    error: sanitized,
    responseStatus: status,
    publicReason: status ? `HTTP ${status}` : sanitized,
    errorInfo: createSubscriptionImportErrorInfo({
      category: inferSubscriptionImportErrorCategory(sanitized),
      message: sanitized,
      detail: sanitized,
      httpStatus: status,
    }),
  };
}

function toSecurityFailure(message: string): SourceImportTransportResult {
  return {
    ok: false,
    error: message,
    publicReason: message,
    errorInfo: createSubscriptionImportErrorInfo({
      category: "security",
      message,
      detail: message,
    }),
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

async function validatePublicFetchTarget(
  url: string,
  allowUnsafeSubscriptionSources: boolean,
  signal: AbortSignal,
): Promise<
  | { ok: true; addresses: string[] | null }
  | { ok: false; failure: SourceImportTransportResult }
> {
  signal.throwIfAborted();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, failure: toSecurityFailure("无效的订阅 URL") };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, failure: toSecurityFailure("只支持 HTTP 或 HTTPS 订阅 URL") };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, failure: toSecurityFailure("订阅 URL 不允许包含用户名或密码") };
  }

  if (allowUnsafeSubscriptionSources) return { ok: true, addresses: null };

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, failure: toSecurityFailure("禁止访问本机或内网地址") };
  }

  if (isPrivateOrReservedIp(hostname)) {
    return { ok: false, failure: toSecurityFailure("禁止访问本机或内网地址") };
  }

  if (isIP(hostname)) return { ok: true, addresses: [hostname] };

  const records = await awaitWithSignal(lookup(hostname, { all: true, verbatim: true }), signal).catch(() => {
    signal.throwIfAborted();
    return null;
  });
  if (!records || records.length === 0) {
    return { ok: false, failure: toFailure("DNS 暂时不可用，请稍后再试") };
  }
  const addresses = normalizeResolvedIpAddresses(records.map((record) => record.address));
  const finalAddresses = shouldRecheckFakeIpDnsAnswers(addresses)
    ? selectDnsAddressesAfterFakeIpRecheck(
        addresses,
        await resolveHostnameByDoh(hostname, { timeoutMs: DOH_TIMEOUT_MS, signal })
      )
    : addresses;
  const addressesToCheck = finalAddresses.length > 0 ? finalAddresses : addresses;
  if (addressesToCheck.length === 0 || addressesToCheck.some((address) => !isIP(address))) {
    return { ok: false, failure: toFailure("DNS 暂时不可用，请稍后再试") };
  }
  if (addressesToCheck.some((address) => isPrivateOrReservedIp(address))) {
    return { ok: false, failure: toSecurityFailure("禁止访问本机或内网地址") };
  }

  return { ok: true, addresses: addressesToCheck };
}

async function readFetchBodyLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => undefined); return cancellation; };
  const onAbort = () => { void cancel(); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestUnpinnedText(params: {
  url: string;
  method: "GET" | "HEAD";
  userAgent: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<DirectHttpResponse> {
  params.signal.throwIfAborted();
  const response = await fetch(params.url, {
    method: params.method,
    headers: {
      "User-Agent": params.userAgent,
      Accept: "text/plain, application/yaml, application/x-yaml, */*;q=0.8",
      "Cache-Control": "no-cache",
    },
    redirect: "manual",
    signal: params.signal,
  });
  const headers = headersToRecord(response.headers);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel("redirect response is not consumed").catch(() => undefined);
    return { status: response.status, headers, content: "" };
  }
  const contentLength = Number(headers["content-length"] || "0");
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  const content = params.method === "HEAD" ? "" : await readFetchBodyLimited(response, params.maxBytes, params.signal);
  if (params.method === "HEAD") await response.body?.cancel().catch(() => undefined);
  return { status: response.status, headers, content };
}

async function fetchTextDirect(
  request: SourceImportTransportRequest,
  allowUnsafeSubscriptionSources: boolean
): Promise<SourceImportTransportResult> {
  const deadline = createRequestDeadline(request.timeoutMs, request.signal);
  let phase = "dns";

  try {
    let currentUrl = request.url;
    let response: DirectHttpResponse | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      phase = "dns";
      const validation = await validatePublicFetchTarget(currentUrl, allowUnsafeSubscriptionSources, deadline.signal);
      deadline.signal.throwIfAborted();
      if (!validation.ok) return validation.failure;

      const method = request.purpose === "userinfo" ? "HEAD" : "GET";
      phase = "http";
      response = validation.addresses
        ? await requestPinnedText({
            url: currentUrl,
            addresses: validation.addresses,
            method,
            userAgent: request.userAgent,
            maxBytes: request.maxBytes,
            signal: deadline.signal,
          })
        : await requestUnpinnedText({
            url: currentUrl,
            method,
            userAgent: request.userAgent,
            maxBytes: request.maxBytes,
            signal: deadline.signal,
          });
      deadline.signal.throwIfAborted();

      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.location;
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      response = null;
    }

    if (!response) return toFailure("订阅重定向次数过多", 310);
    const { headers, content } = response;
    if (response.status < 200 || response.status >= 300) {
      return toFailure(`HTTP ${response.status}`, response.status);
    }

    return {
      ok: true,
      content,
      headers,
      responseStatus: response.status,
    };
  } catch (error) {
    // Parent cancellation is a task-level event, not an upstream-source failure.
    request.signal?.throwIfAborted();
    if (deadline.signal.aborted) {
      console.warn("[source-import] request timed out", { purpose: request.purpose, phase });
      return toFailure("订阅源请求超时");
    }
    if (error instanceof ResponseTooLargeError) return toFailure("订阅响应过大", 413);
    const message = error instanceof Error ? error.message : String(error);
    return toFailure(message);
  } finally {
    deadline.dispose();
  }
}

export async function fetchRuleContentDirect(url: string): Promise<SourceImportTransportResult> {
  const allowUnsafeSubscriptionSources = await getAllowUnsafeSubscriptionSources();
  return fetchTextDirect({ url, userAgent: SUBSCRIPTION_IMPORT_USER_AGENTS[0], purpose: "content",
    timeoutMs: 15000, maxBytes: 10 * 1024 * 1024 }, allowUnsafeSubscriptionSources);
}

export async function importSourceUrlDirect(request: SourceImportRequest, options: { signal?: AbortSignal } = {}): Promise<SourceImportResult> {
  options.signal?.throwIfAborted();
  const allowUnsafeSubscriptionSources = await getAllowUnsafeSubscriptionSources();
  options.signal?.throwIfAborted();
  return importSubscriptionFromUrl(request, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    signal: options.signal,
    fetchText: (transportRequest) => fetchTextDirect(transportRequest, allowUnsafeSubscriptionSources),
  });
}

export async function fetchSourceUserInfoHeadersDirect(source: {
  userinfoUrl?: string;
  userinfoUserAgent?: string;
}, options: { signal?: AbortSignal } = {}): Promise<Record<string, string> | undefined> {
  options.signal?.throwIfAborted();
  if (!source.userinfoUrl) return undefined;
  const allowUnsafeSubscriptionSources = await getAllowUnsafeSubscriptionSources();
  const response = await fetchTextDirect(
    {
      url: source.userinfoUrl,
      userAgent: source.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
      purpose: "userinfo",
      timeoutMs: USERINFO_TIMEOUT_MS,
      maxBytes: USERINFO_MAX_BYTES,
      signal: options.signal,
    },
    allowUnsafeSubscriptionSources
  );
  return response.ok ? response.headers : undefined;
}
