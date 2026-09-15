import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export const runtime = "nodejs";

/** Verifies that the request was signed by Vercel's cron scheduler. */
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!secret || !supplied) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Removes only avatar paths that the database has already queued for purge. */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "not_authorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_STORAGE_PURGE_SECRET_KEY;
  if (!url || !secretKey) {
    return Response.json({ error: "storage_purge_not_configured" }, { status: 503 });
  }

  const supabase = createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: queued, error: queueError } = await supabase.rpc(
    "list_storage_purge_queue",
  );
  if (queueError) {
    return Response.json({ error: "queue_unavailable" }, { status: 500 });
  }

  let removed = 0;
  for (const item of queued ?? []) {
    const { error: storageError } = await supabase.storage
      .from("member-avatars")
      .remove([item.object_path]);
    if (storageError) continue;

    const { error: completionError } = await supabase.rpc(
      "complete_storage_purge",
      { p_object_path: item.object_path },
    );
    if (!completionError) removed += 1;
  }

  return Response.json({ pending: (queued?.length ?? 0) - removed, removed });
}
