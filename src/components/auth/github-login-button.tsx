"use client";

import { useSearchParams } from "next/navigation";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { startGithubOAuth } from "@/lib/supabase/github-oauth";

export function GithubLoginButton() {
  const searchParams = useSearchParams();

  async function handleLogin() {
    const next = searchParams.get("callbackUrl") ?? "/dashboard";
    await startGithubOAuth(next);
  }

  return (
    <Button className="w-full" onClick={handleLogin}>
      <LogIn />
      GitHubで始める
    </Button>
  );
}
