import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { GET } from "@/app/api/cron/storage-purge/route";

describe("storage purge cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_STORAGE_PURGE_SECRET_KEY = "sb_secret_test";
    mocks.createClient.mockReturnValue({
      rpc: mocks.rpc,
      storage: { from: () => ({ remove: mocks.remove }) },
    });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "list_storage_purge_queue"
        ? { data: [{ object_path: "person/avatar.webp" }], error: null }
        : { data: null, error: null },
    );
    mocks.remove.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.SUPABASE_STORAGE_PURGE_SECRET_KEY;
  });

  it("rejects callers without Vercel's bearer secret", async () => {
    const response = await GET(new Request("https://example.com/api/cron/storage-purge"));
    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("deletes only queued avatars and acknowledges successful removal", async () => {
    const response = await GET(
      new Request("https://example.com/api/cron/storage-purge", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pending: 0, removed: 1 });
    expect(mocks.remove).toHaveBeenCalledWith(["person/avatar.webp"]);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_storage_purge", {
      p_object_path: "person/avatar.webp",
    });
  });

  it("keeps a failed Storage deletion queued for retry", async () => {
    mocks.remove.mockResolvedValue({ error: { message: "unavailable" } });
    const response = await GET(
      new Request("https://example.com/api/cron/storage-purge", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    await expect(response.json()).resolves.toEqual({ pending: 1, removed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "complete_storage_purge",
      expect.anything(),
    );
  });
});
