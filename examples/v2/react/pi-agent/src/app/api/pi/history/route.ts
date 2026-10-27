import { requireThreadId, server } from "@/lib/pi-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const threadId = requireThreadId(
      new URL(request.url).searchParams.get("threadId"),
    );
    return Response.json(await server.store.history(threadId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Unable to load conversation" },
      { status: 400 },
    );
  }
}
