"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createNewPortalProfile() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "complete_own_organization_onboarding",
  );

  if (error) {
    redirect("/onboarding/account?error=complete_failed");
  }

  // Finishing onboarding never creates a membership. An existing member can
  // continue; everybody else goes to the explicit request flow.
  const result = (data ?? {}) as {
    organizationSlug?: string;
    outcome?: string;
    returning?: boolean;
  };

  if (result.outcome === "joined" || result.outcome === "member") {
    redirect("/");
  }

  redirect("/access");
}
