import { server } from "@/lib/pi-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = server.handler;
export const POST = server.handler;
export const PATCH = server.handler;
export const DELETE = server.handler;
