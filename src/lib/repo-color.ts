const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#64748b", "#ef4444"];

export function getRepoColor(fullName: string): string {
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) {
    hash = (hash << 5) - hash + fullName.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
