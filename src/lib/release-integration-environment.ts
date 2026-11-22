/**
 * 統合検証の失敗が**環境の不足**（DB未起動・ツール無し・実行ホストの前提）かを、報告の文面から見分ける（#5561）。
 *
 * ランナー（`scripts/lib/release-evidence.sh`の`evidence_classify_step`）が`setup_missing`と分類した失敗と、
 * 失敗出力に残る接続不達・コマンド無しの文言を拾う。サーバーは`failureKind`を受け取らないため文面から推定する。
 * ブラウザ側（`release-auto-proceed-panel.tsx`）からも使うので、サーバー専用の依存を持たせない。
 */
export const INTEGRATION_ENVIRONMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /setup_missing/,
  /\bP1001\b/,
  /Can't reach database server/i,
  /ECONNREFUSED/,
  /connection refused/i,
  /command not found/i,
  /環境の不足/,
];

export function isIntegrationEnvironmentFailure(text: string | null | undefined): boolean {
  const body = (text ?? "").trim();
  return body !== "" && INTEGRATION_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(body));
}
