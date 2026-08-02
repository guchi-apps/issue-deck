// DBアクセスなしの純粋関数。edge middleware（src/lib/supabase/middleware.ts）からも呼べるようにするため。
function parseAllowedEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;

  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);
  return allowedEmails.has(email.trim().toLowerCase());
}
