import { withCurrentAdmin } from "./api-auth";
import { json, apiError } from "./http";
import { JobLeaseLostError } from "./job-lease";
import { refreshSubscription } from "./subscription-service";
import {
  getSubscriptionSourceHistory,
  listSubscriptionSources,
  SourceHistoryInputError,
} from "./subscription-source-service";

async function sourceResponse(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SourceHistoryInputError) return apiError(error.message, "BAD_REQUEST", 400);
    if (error instanceof JobLeaseLostError)
      return apiError("更新任务已失去锁，请重新查看状态后重试。", "CONFLICT", 409);
    console.error("[subscription-sources] request failed", {
      errorType: error instanceof Error ? error.name : "Unknown",
    });
    return apiError("无法完成订阅源操作，请稍后重试。", "INTERNAL_ERROR", 500);
  }
}

export function listSubscriptionSourcesResponse(id: string) {
  return withCurrentAdmin((admin) =>
    sourceResponse(async () => {
      const sources = await listSubscriptionSources(admin.id, id);
      return sources ? json({ sources }) : apiError("订阅不存在。", "NOT_FOUND", 404);
    }),
  );
}

export function subscriptionSourceHistoryResponse(request: Request, id: string, sourceId: string) {
  return withCurrentAdmin((admin) =>
    sourceResponse(async () => {
      const page = await getSubscriptionSourceHistory(
        admin.id,
        id,
        sourceId,
        new URL(request.url).searchParams,
      );
      return page ? json(page) : apiError("订阅源不存在。", "NOT_FOUND", 404);
    }),
  );
}

export function refreshSubscriptionSourceResponse(id: string, sourceId: string) {
  return withCurrentAdmin((admin) =>
    sourceResponse(async () => {
      const result = await refreshSubscription(admin.id, id, { targetSourceId: sourceId });
      if (!result) return apiError("订阅不存在。", "NOT_FOUND", 404);
      return result.ok ? json(result.body) : json(result.response.body, result.response.status);
    }),
  );
}
