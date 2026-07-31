import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// service_role キーを使うため、必ずサーバー側専用（API Route / Server Component）でのみ呼び出すこと。
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
