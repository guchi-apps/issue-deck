import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import { getCurrentUser } from "@/lib/auth-user";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  return (
    <IssueDeckShell
      currentUser={
        currentUser
          ? { login: currentUser.githubLogin, name: currentUser.name, image: currentUser.image }
          : null
      }
    />
  );
}
