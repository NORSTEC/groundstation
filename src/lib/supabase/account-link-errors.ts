export type AccountLinkErrorReason =
  | "expired"
  | "limit"
  | "merge"
  | "profile_has_data"
  | "same"
  | "source_inactive";

export function accountLinkErrorReason(message: string): AccountLinkErrorReason {
  if (message.includes("same_portal_account")) return "same";
  if (message.includes("source_profile_has_data")) return "profile_has_data";
  if (message.includes("source_portal_access_required")) return "source_inactive";
  if (message.includes("too_many_portal_accounts")) return "limit";
  if (message.includes("link_intent_expired") || message.includes("expired")) {
    return "expired";
  }
  return "merge";
}
