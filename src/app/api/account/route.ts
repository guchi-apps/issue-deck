import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { createAdminClient } from "@/lib/supabase/admin";

export async function DELETE() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await db.user.delete({ where: { id: currentUser.id } });

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(currentUser.supabaseUserId);
  if (error) {
    console.error("[api/account] failed to delete Supabase Auth user", error);
    return NextResponse.json({ error: "supabase_delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
