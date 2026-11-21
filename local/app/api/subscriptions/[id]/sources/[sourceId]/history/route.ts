import { subscriptionSourceHistoryResponse } from "@local/lib/subscription-source-route-handlers";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const { id, sourceId } = await params;
  return subscriptionSourceHistoryResponse(request, id, sourceId);
}
