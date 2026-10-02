/**
 * 計画レビュー（G1）を実施するか省略するかの対象判定（#3765）。
 *
 * **`21.plan-required`が付いているだけでは別エージェントのレビューを必須にしない。** 計画の承認（人）と
 * 別エージェントのレビューは別の判断で、省略しても計画承認の要否は変わらない。
 *
 * 判定は計画本文だけを入力にする純関数で、**判定のための調査セッションは追加しない**。ファイル数や
 * 変更行数では決めず、触る領域（認証・データ・配布経路など）を語で見る。**迷ったら実施へ倒す**:
 * 誤って省略すると設計ミスが素通りし、誤って実施しても1本ぶんのコストで済むため。
 *
 * 判定の順序は次のとおり（先に当たったものが理由になる）。
 *
 * 1. 高リスク領域（認証・権限／DB・データの移行や削除／配布経路・共有スクリプト・生成物／公開API・契約／
 *    本番手順）に当たれば実施
 * 2. 軽微な変更（表示・文言・限定的な修正）と読める**かつ**変更するファイルがすべて画面・文言・テスト・
 *    文書の範囲なら省略
 * 3. どちらでもなければ判定不能として、理由付きで実施
 */

export type PlanReviewScopeDecision = {
  review: boolean;
  /** 画面とIssueコメントに出す短い理由（1行） */
  reason: string;
};

/** 実施へ倒す領域。語は計画の「要約」「変更するファイル」に現れるもの */
const HIGH_IMPACT_RULES: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "認証・権限",
    pattern: /認証|認可|権限|ログイン|セッション管理|トークン|シークレット|auth|oauth|permission|middleware|proxy\.ts/i,
  },
  {
    label: "DB・既存データの移行や削除",
    pattern: /prisma\/|schema\.prisma|migration|マイグレーション|データ移行|既存データ|DBスキーマ|テーブル(?:追加|削除)|削除する(?:データ|行)|バックフィル/i,
  },
  {
    label: "配布経路・共有スクリプト・生成物",
    pattern: /配布|共有ワークフロー|reusable-|\.github\/workflows|\.github\/prompts|scripts\/(?:lib\/|start-|subpc-|install)|templates\.generated|生成物|再生成|poller|launcher|ランチャー|prompts-ref|@workflows/i,
  },
  {
    label: "公開API・複数アプリ間の契約",
    pattern: /公開API|api\/(?:progress|dispatch|shared|webhooks)|共有トークン|契約|互換性|webhook|他リポジトリ|複数アプリ|スキーマ変更/i,
  },
  {
    label: "本番配布・運用手順",
    pattern: /本番|デプロイ|deploy|リリース手順|\.env|環境変数|ロールバック|systemd|apache|pm2/i,
  },
];

/** 変更するファイルがこの範囲だけなら、見た目・文言の変更とみなせる */
const LIGHT_PATH_PATTERN =
  /(?:^|\/)(?:components\/|app\/\(?[^/]*\)?\/page\.tsx|docs\/|README|[^/]+\.test\.[tj]sx?|[^/]+\.render\.test\.tsx|[^/]+\.css)/;

/** 軽微な変更と読める語 */
const LIGHT_INTENT_PATTERN =
  /表示(?:を|の)?(?:修正|変更|直す)|文言|ラベルの?(?:変更|修正)|見た目|余白|色(?:を|の)|アイコン|誤字|タイポ|レイアウト|ツールチップ|ボタンの(?:名前|文言)|限定|小さな(?:追加|修正)|既存(?:の)?パターン/;

/** 計画の「変更するファイル」節からパスらしい語を拾う（バッククォートで囲まれたもの） */
export function extractPlanFilePaths(plan: string): string[] {
  const section = plan.split(/^##\s*変更するファイル\s*$/m)[1];
  if (!section) return [];
  const paths = new Set<string>();
  for (const match of section.matchAll(/`([^`\s]+\/[^`\s]*|[^`\s]+\.[a-z]{1,5})`/g)) {
    paths.add(match[1]);
  }
  return [...paths];
}

export function judgePlanReviewScope(plan: string): PlanReviewScopeDecision {
  for (const rule of HIGH_IMPACT_RULES) {
    if (rule.pattern.test(plan)) {
      return { review: true, reason: `${rule.label}に関わる変更のため、初回レビューを実施します` };
    }
  }

  const paths = extractPlanFilePaths(plan);
  const lightPaths = paths.length > 0 && paths.every((path) => LIGHT_PATH_PATTERN.test(path));
  if (lightPaths && LIGHT_INTENT_PATTERN.test(plan)) {
    return {
      review: false,
      reason: "表示・文言など影響範囲が限定された変更のため、別エージェントのレビューを省略しました（実装担当が要求と既存コードを自己確認します）",
    };
  }

  return {
    review: true,
    reason: "影響範囲を計画から判断できないため、念のため初回レビューを実施します",
  };
}
