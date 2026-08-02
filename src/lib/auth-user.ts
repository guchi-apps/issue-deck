import { cookies } from "next/headers";

import { CI_BYPASS_COOKIE_NAME, CI_BYPASS_SUPABASE_USER_ID, isCiBypassRequest } from "@/lib/ci-auth-bypass";
import { db } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export async function getCurrentUser() {
  const cookieStore = await cookies();
  if (isCiBypassRequest(cookieStore.get(CI_BYPASS_COOKIE_NAME)?.value)) {
    return db.user.findUnique({ where: { supabaseUserId: CI_BYPASS_SUPABASE_USER_ID } });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return db.user.findUnique({ where: { supabaseUserId: user.id } });
}

export async function requireUserId(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.id ?? null;
}
