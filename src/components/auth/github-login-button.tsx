"use client";

import { useSearchParams } from "next/navigation";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function GithubLoginButton() {
  const searchParams = useSearchParams();

  async function handleLogin() {
    const supabase = createClient();
    const next = searchParams.get("callbackUrl") ?? "/dashboard";

    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
  }

  return (
    <Button className="w-full" onClick={handleLogin}>
      <LogIn />
      GitHubで始める
    </Button>
  );
}
