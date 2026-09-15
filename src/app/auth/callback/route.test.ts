import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  tableResults: new Map<string, unknown>(),
}));

function query(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      getUser: mocks.getUser,
      signOut: vi.fn(),
    },
    from: vi.fn((table: string) => query(mocks.tableResults.get(table))),
    rpc: mocks.rpc,
  })),
}));

import { GET } from "@/app/auth/callback/route";

describe("primary OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tableResults.clear();
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
      error: null,
    });
    mocks.tableResults.set("portal_accounts", {
      data: {
        onboarding_status: "complete",
        people: {
          alumni_access_granted_at: null,
          portal_access_status: "active",
        },
        person_id: 1,
      },
      error: null,
    });
    mocks.tableResults.set("memberships", {
      data: { id: 1 },
      error: null,
    });
  });

  it("enters Groundstation when the linked person has membership", async () => {
    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/callback?code=ok"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/",
    );
  });

  it("rejects a callback without an authorization code", async () => {
    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/callback"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/login?error=oauth_callback",
    );
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("does not continue after a failed code exchange", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      error: { message: "invalid code" },
    });
    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/callback?code=bad"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/login?error=oauth_callback",
    );
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
