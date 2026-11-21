import { refreshSubscriptionSourceResponse } from "@local/lib/subscription-source-route-handlers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const { id, sourceId } = await params;
  return refreshSubscriptionSourceResponse(id, sourceId);
}
