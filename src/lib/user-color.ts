const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#64748b", "#ef4444"];

export function getUserColor(login: string): string {
  let hash = 0;
  for (let i = 0; i < login.length; i++) {
    hash = (hash << 5) - hash + login.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
