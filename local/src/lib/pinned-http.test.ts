import { createServer, type Server } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestPinnedText, ResponseTooLargeError } from "./pinned-http";

describe("pinned local HTTP transport", () => {
  let server: Server;
  let port = 0;
  let observedHost = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      observedHost = request.headers.host || "";
      const body = request.url === "/large" ? "x".repeat(2048) : "ss://node";
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      });
      response.end(gzipSync(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("connects only to the validated address while preserving the original Host header", async () => {
    const response = await requestPinnedText({
      url: `http://example.test:${port}/ok`,
      addresses: ["127.0.0.1"],
      method: "GET",
      userAgent: "SubBoost Test",
      maxBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({ status: 200, content: "ss://node" });
    expect(observedHost).toBe(`example.test:${port}`);
  });

  it("enforces the limit after response decompression", async () => {
    await expect(requestPinnedText({
      url: `http://example.test:${port}/large`,
      addresses: ["127.0.0.1"],
      method: "GET",
      userAgent: "SubBoost Test",
      maxBytes: 128,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe("pinned HTTP cancellation", () => {
  it.each(["slow-headers", "reset-gzip"])("settles and closes the socket for %s", async (mode) => {
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    const server = createServer((_request, response) => {
      started();
      if (mode === "reset-gzip") {
        response.writeHead(200, { "Content-Encoding": "gzip" });
        response.write(gzipSync("ss://node").subarray(0, 12));
        setImmediate(() => response.destroy());
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const controller = new AbortController();
    const pending = requestPinnedText({
      url: `http://example.test:${address.port}/`, addresses: ["127.0.0.1"], method: "GET",
      userAgent: "SubBoost Test", maxBytes: 1024, signal: controller.signal,
    }).then(() => "unexpected success", () => "rejected");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await received;
      if (mode === "slow-headers") controller.abort();
      expect(await Promise.race([
        pending,
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 500); }),
      ])).toBe("rejected");
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ["identity", (body: string) => Buffer.from(body)],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)("aborts an unfinished %s body and closes its connection", async (encoding, compress) => {
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const server = createServer((_request, response) => {
      response.on("close", closed);
      response.writeHead(200, { "Content-Encoding": encoding });
      response.write(compress("ss://node"));
      started();
      // The compressed stream is valid, but the HTTP response deliberately never ends.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const controller = new AbortController();
    const pending = requestPinnedText({
      url: `http://example.test:${address.port}/unfinished`, addresses: ["127.0.0.1"],
      method: "GET", userAgent: "SubBoost Test", maxBytes: 1024, signal: controller.signal,
    }).then(() => "unexpected success", () => "aborted");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await received;
      // Give the client time to enter the response-body reader rather than aborting the headers.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await Promise.race([
        pending,
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 500); }),
      ])).toBe("aborted");
      await disconnected;
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not open a connection for an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled fixture"));
    await expect(requestPinnedText({
      url: "http://example.test/sub", addresses: ["127.0.0.1"], method: "GET",
      userAgent: "SubBoost Test", maxBytes: 1024, signal: controller.signal,
    })).rejects.toThrow();
  });
});
