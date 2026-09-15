import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mocks.cookieGet })),
}));

vi.mock("@/lib/supabase/account-link", () => ({
  ACCOUNT_LINK_FLOW_COOKIE: "portal-account-link-flow",
  createAccountLinkClient: vi.fn(async () => ({
    client: {
      auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
      rpc: mocks.rpc,
    },
  })),
}));

import { GET } from "@/app/auth/account-link/callback/route";

describe("account-link callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieGet.mockReturnValue({ value: `add_account.${"a".repeat(64)}` });
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({
      data: { accessRequestCreated: true },
      error: null,
    });
  });

  it("keeps membership review explicit after linking an organization account", async () => {
    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/account-link/callback?code=ok"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/profile?accountLinked=request-sent",
    );
    expect(mocks.rpc).toHaveBeenCalledWith("complete_portal_account_link", {
      p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["source_profile_has_data", "profile_has_data"],
    ["too_many_portal_accounts", "limit"],
    ["same_portal_account", "same"],
    ["link_intent_expired", "expired"],
  ] as const)("redirects %s safely", async (databaseError, routeReason) => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: databaseError },
    });

    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/account-link/callback?code=ok"),
    );

    expect(response.headers.get("location")).toBe(
      `https://groundstation.norstec.no/profile?accountLinkError=${routeReason}`,
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects a callback without both OAuth code and link cookie", async () => {
    mocks.cookieGet.mockReturnValue(undefined);
    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/account-link/callback"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/profile?accountLinkError=oauth",
    );
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("returns use-existing failures to onboarding without replacing the session", async () => {
    mocks.cookieGet.mockReturnValue({ value: `use_existing.${"b".repeat(64)}` });
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "source_profile_has_data" },
    });

    const response = await GET(
      new Request("https://groundstation.norstec.no/auth/account-link/callback?code=ok"),
    );

    expect(response.headers.get("location")).toBe(
      "https://groundstation.norstec.no/onboarding/account?accountLinkError=profile_has_data",
    );
  });
});
