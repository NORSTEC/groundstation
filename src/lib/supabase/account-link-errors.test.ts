import { describe, expect, it } from "vitest";
import { accountLinkErrorReason } from "@/lib/supabase/account-link-errors";

describe("accountLinkErrorReason", () => {
  it.each([
    ["source_profile_has_data", "profile_has_data"],
    ["too_many_portal_accounts", "limit"],
    ["same_portal_account", "same"],
    ["link_intent_expired", "expired"],
  ] as const)("maps %s to %s", (databaseError, routeReason) => {
    expect(accountLinkErrorReason(databaseError)).toBe(routeReason);
  });

  it("does not classify an unrelated failure as an expired intent", () => {
    expect(accountLinkErrorReason("connection_failed")).toBe("merge");
  });
});
