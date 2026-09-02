import { extractManualStepCommands } from "@/lib/manual-step-command";
import type { ManualStepGuide, ManualStepGuideStep } from "@/lib/manual-step-guide";

/**
 * 「1Passwordへ値を登録する」手順を、手作業アシスタント画面（#2753）で見分けるための判定。
 *
 * CLAUDE.md「ユーザーの手作業が残る場合は新規Issueとして起票する」のテンプレートは
 * ```
 * - [ ] （ブラウザ）1Passwordで`apps`ボールトの`<item>`を開き、`<field>`に値を登録する
 * ```
 * の形で書く決まりだが、実例（#2397・#2572）では言い回しがこれと揺れる
 * （「〜という名前のフィールドとして追加する」等）。**文の構造からボールト名・アイテム名・
 * フィールド名を抜き出すことはしない**——構造で判定すると言い回しの違いを取りこぼす。
 * ここでは「1Password」と「登録」を含むかどうかの緩い判定だけを行い、実際にコピーできる
 * ようにするのは`MarkdownBody`の`copyableInlineCode`（本文中のバッククォート表記を
 * そのままチップにする）に任せる。
 *
 * 誤検知しても案内が余分に出るだけで、既存のコピー・代行実行の動作は変えない。
 */
export function isOnePasswordRegistrationStep(step: Pick<ManualStepGuideStep, "text">): boolean {
  return /1Password/i.test(step.text) && /登録/.test(step.text);
}

/** GitHub secretへ1Passwordの値を同期するスクリプト（CLAUDE.md「GitHubのsecretへの同期と本番への反映はCLIに任せる」） */
const SYNC_SCRIPT_PATTERN = /\b(?:provision-secret\.sh|sync-github-secrets\.sh)\b/;

/** `--key OPENAI_API_KEY`・`--key=OPENAI_API_KEY`の両方を拾う */
const KEY_ARGUMENT_PATTERN = /--key[= ]([A-Za-z0-9_]+)/g;

/**
 * 本文の手順の中に、GitHub secretへ同期するコマンド（`provision-secret.sh`等）があれば、
 * その対象キー（`--key`の値）を返す（#2753）。
 *
 * 1Password登録手順のすぐ後に、この同期コマンドの手順が続くことが多い（実例: #2572）。
 * 同期コマンドはサブPCでの代行実行の対象になるが、**同じ結果はアプリの
 * 「シークレット同期」画面（`SecretsSyncSection`）の「同期」ボタンからも得られる**——
 * サブPCの端末に触れない状況（スマホからの利用等）でも、その代替手段を案内するために使う。
 *
 * 見るのは`## やること`の手順だけ（`extractManualStepCommands`）。`## 完了の確認方法`の
 * 確認コマンドは対象外——そちらは`op read`等の読み取りで、同期そのものではない。
 */
export function findManualStepSyncKeys(guide: ManualStepGuide): string[] {
  if (!guide.hasTemplate) return [];
  const keys = new Set<string>();
  for (const { command } of extractManualStepCommands(null, guide)) {
    if (!SYNC_SCRIPT_PATTERN.test(command)) continue;
    for (const match of command.matchAll(KEY_ARGUMENT_PATTERN)) keys.add(match[1]);
  }
  return [...keys];
}
