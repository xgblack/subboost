import { describe, expect, it, vi } from "vitest";
import { buildSourceImportParseResult, importSubscriptionFromUrl, type SourceImportTransportRequest } from "./source-import";

const ss = "{name: ss, type: ss, server: local.subboost.test, port: 443, cipher: aes-128-gcm, password: secret}";
const anytls = "{name: tls, type: anytls, server: local.subboost.test, port: 8443, password: pass, alpn: [h2], client-fingerprint: chrome}";

describe("bounded complete snapshot import", () => {
  it("compares clean YAML profiles when an entire protocol is hidden", async () => {
    const fetchText = vi.fn(async ({ userAgent }: SourceImportTransportRequest) => ({
      ok: true,
      content: `proxies: [${ss}${userAgent === "clash-verge/v2.5.2" ? ", " + anytls : ""}]`,
      headers: { profile: userAgent },
    }));
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsedNodes.map((node) => node.type)).toEqual(["ss", "anytls"]);
    expect(result.headers.profile).toBe("clash-verge/v2.5.2");
    expect(fetchText).toHaveBeenCalledTimes(4);
  });

  it("selects richer fields for the same nodes and retains success after failures", async () => {
    const basic = anytls.replace(", alpn: [h2], client-fingerprint: chrome", "");
    const fetchText = vi.fn(async ({ userAgent }: SourceImportTransportRequest) => userAgent === "bad"
      ? { ok: false, error: "timeout" }
      : { ok: true, content: `proxies: [${userAgent === "rich" ? anytls : basic}]` });
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText, userAgents: ["basic", "rich", "bad"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsedNodes[0]).toMatchObject({ alpn: ["h2"], "client-fingerprint": "chrome" });
  });

  it("caps custom candidates, preserves byte limits and keeps success after thrown requests", async () => {
    const fetchText = vi.fn(async ({ userAgent, maxBytes, timeoutMs }: SourceImportTransportRequest) => {
      expect(maxBytes).toBe(1234);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(100);
      if (userAgent !== "first") throw new Error("synthetic request failure");
      return { ok: true, content: `proxies: [${ss}]` };
    });
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, {
      fetchText, maxBytes: 1234, timeoutMs: 100, userAgents: ["first", "second", "third", "fourth", "fifth", "first"],
    });
    expect(result.ok).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(4);
  });

  it("does not launch another request or userinfo after the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchText = vi.fn(async () => {
        vi.advanceTimersByTime(60_000);
        return { ok: true, content: `proxies: [${ss}]` };
      });
      const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub", userinfoUrl: "https://local.subboost.test/info" }, { fetchText });
      expect(result.ok).toBe(true);
      expect(fetchText).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("reports failure when the budget expires before the first request", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
    try {
      const fetchText = vi.fn();
      const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText });
      expect(result).toMatchObject({ ok: false, error: "订阅源请求超时" });
      expect(fetchText).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("keeps the parse failure when remaining candidates only fail transport", async () => {
    const fetchText = vi.fn().mockResolvedValueOnce({ ok: true, content: "proxies: []" })
      .mockResolvedValue({ ok: false, error: "timeout" });
    expect(await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText }))
      .toMatchObject({ ok: false, errorInfo: { category: "parse" } });
    expect(fetchText).toHaveBeenCalledTimes(4);
  });

  it("interrupts the active profile at the total deadline and retains the earlier usable snapshot", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchText = vi.fn(async ({ signal }: SourceImportTransportRequest) => {
        signals.push(signal!);
        if (signals.length === 1) return { ok: true, content: `proxies: [${ss}]` };
        return new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      });
      const pending = importSubscriptionFromUrl({ url: "https://local.subboost.test/sub", userinfoUrl: "https://local.subboost.test/info" }, { fetchText });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({
        ok: true, parsedNodes: [expect.objectContaining({ type: "ss" })],
        parseErrors: [], warnings: ["附加订阅信息请求超时，已保留节点"],
      });
      expect(fetchText).toHaveBeenCalledTimes(2);
      expect(signals[1].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not swallow parent cancellation or start another profile", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost fixture");
    const fetchText = vi.fn(async ({ signal }: SourceImportTransportRequest) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const pending = importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(fetchText).toHaveBeenCalledOnce();
    await expect(importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText, signal: controller.signal })).rejects.toBe(reason);
    expect(fetchText).toHaveBeenCalledOnce();
  });

  it("treats a supplemental failure as a warning, not lost content", async () => {
    const fetchText = vi.fn(async ({ purpose }: SourceImportTransportRequest) => purpose === "content"
      ? { ok: true, content: `proxies: [${ss}]` }
      : { ok: false, error: "timeout" });
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub", userinfoUrl: "https://local.subboost.test/info" }, { fetchText });
    expect(result).toMatchObject({ ok: true, parsedNodes: [expect.objectContaining({ type: "ss" })], parseErrors: [], warnings: ["附加订阅信息获取失败，已保留节点"] });
    if (result.ok) expect(buildSourceImportParseResult(result)).toMatchObject({ totalParsed: 1, totalFailed: 0 });
  });
});
