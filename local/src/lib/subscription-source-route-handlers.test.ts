import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticated: true, list: vi.fn(), history: vi.fn(), refresh: vi.fn() }));
vi.mock("./api-auth", () => ({
  withCurrentAdmin: (run: (admin: { id: string }) => Promise<Response>) =>
    mocks.authenticated
      ? run({ id: "owner-1" })
      : Promise.resolve(Response.json({ code: "UNAUTHORIZED" }, { status: 401 })),
}));
vi.mock("./subscription-service", () => ({ refreshSubscription: mocks.refresh }));
vi.mock("./subscription-source-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscription-source-service")>()),
  listSubscriptionSources: mocks.list,
  getSubscriptionSourceHistory: mocks.history,
}));
import { SourceHistoryInputError } from "./subscription-source-service";
import {
  listSubscriptionSourcesResponse,
  refreshSubscriptionSourceResponse,
  subscriptionSourceHistoryResponse,
} from "./subscription-source-route-handlers";

describe("subscription source management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticated = true;
  });

  it("rejects unauthenticated requests without reading data or pulling upstream", async () => {
    mocks.authenticated = false;
    expect((await listSubscriptionSourcesResponse("sub")).status).toBe(401);
    expect((await refreshSubscriptionSourceResponse("sub", "a")).status).toBe(401);
    expect(
      (await subscriptionSourceHistoryResponse(new Request("http://test/history"), "sub", "a")).status,
    ).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("scopes reads and updates to the current administrator and stored source ID", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.refresh.mockResolvedValue({ ok: true, body: { success: true, nodeCount: 3 } });
    expect((await listSubscriptionSourcesResponse("sub")).status).toBe(200);
    expect((await refreshSubscriptionSourceResponse("sub", "a")).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("owner-1", "sub");
    expect(mocks.refresh).toHaveBeenCalledWith("owner-1", "sub", { targetSourceId: "a" });
  });

  it("uses 404 for absent or inaccessible subscriptions and sources", async () => {
    mocks.list.mockResolvedValue(null);
    mocks.refresh.mockResolvedValue(null);
    mocks.history.mockResolvedValue(null);
    expect((await listSubscriptionSourcesResponse("missing")).status).toBe(404);
    expect((await refreshSubscriptionSourceResponse("missing", "a")).status).toBe(404);
    expect(
      (await subscriptionSourceHistoryResponse(new Request("http://test/history"), "sub", "missing")).status,
    ).toBe(404);
  });

  it.each([409, 502, 403])(
    "preserves refresh failure status %i and the history reference",
    async (status) => {
      mocks.refresh.mockResolvedValue({
        ok: false,
        response: { status, body: { error: "未应用", historyRecordId: "record-1" } },
      });
      const response = await refreshSubscriptionSourceResponse("sub", "a");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "未应用", historyRecordId: "record-1" });
    },
  );

  it("returns a useful 400 for an invalid history cursor", async () => {
    mocks.history.mockRejectedValue(new SourceHistoryInputError("分页参数无效"));
    const response = await subscriptionSourceHistoryResponse(
      new Request("http://test/history?cursor=bad"),
      "sub",
      "a",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "分页参数无效" });
  });
});
