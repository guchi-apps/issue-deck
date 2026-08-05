import type { ReleasePhase } from "@/hooks/use-release-status";

/**
 * mainのバージョン表示を組み立てる。develop→main PRが開いている間（release_pr_open）は、
 * マージするとmainがdevelopのバージョンに追いつくことが一目でわかるよう矢印付きで表示する(#544)。
 */
export function formatMainVersionDisplay(
  mainVersion: string | null,
  developVersion: string | null,
  phase: ReleasePhase,
): string {
  if (!mainVersion) return "-";
  if (phase === "release_pr_open" && developVersion && developVersion !== mainVersion) {
    return `v${mainVersion}→v${developVersion}`;
  }
  return `v${mainVersion}`;
}

/**
 * developのバージョン表示を組み立てる。バンプPRが開いている間（bump_pr_open）は、
 * マージするとdevelopが次バージョンに上がることが一目でわかるよう矢印付きで表示する(#544)。
 */
export function formatDevelopVersionDisplay(
  developVersion: string | null,
  nextVersion: string | null,
  phase: ReleasePhase,
): string {
  if (!developVersion) return "-";
  if (phase === "bump_pr_open" && nextVersion && nextVersion !== developVersion) {
    return `v${developVersion}→v${nextVersion}`;
  }
  return `v${developVersion}`;
}
