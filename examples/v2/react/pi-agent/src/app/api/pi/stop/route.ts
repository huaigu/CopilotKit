import { requireThreadId, server } from "@/lib/pi-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // Next may use an internal hostname in request.url. The Host header is the
  // browser-facing authority; forwarded headers are intentionally not trusted.
  const url = new URL(request.url);
  const expectedOrigin = `${url.protocol}//${request.headers.get("host") || url.host}`;
  if (origin && origin !== expectedOrigin)
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const body = await request.json();
    await server.store.abort(requireThreadId(body.threadId));
    return Response.json({ stopped: true });
  } catch {
    return Response.json({ error: "Unable to stop task" }, { status: 400 });
  }
}
