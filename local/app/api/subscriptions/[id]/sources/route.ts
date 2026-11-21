import { listSubscriptionSourcesResponse } from "@local/lib/subscription-source-route-handlers";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return listSubscriptionSourcesResponse((await params).id);
}
