import { extractVerificationCommands } from "@/lib/manual-step-command";

/**
 * 手作業Issueを「完了してクローズ」しようとしたときに、確認が通っていないことへ気づかせる（#2256）。
 *
 * **チェックを付ける操作と、実際に効いたかの検証は結び付いていない。** `aide-bot`の立ち上げでは
 * 1Passwordへの登録がチェック済みのままcloseされ、初回デプロイが`DB_NAME is required`で落ちた
 * （`guchi-apps/aide-bot#8`として起票し直しになった）。押した人は実行したつもりで、画面には
 * それを疑う材料が何も出ていなかった。
 *
 * **クローズそのものは止めない。** 確認できない手作業は実際にあり（管理画面での設定など）、
 * ここで塞ぐと「確かめようがないから閉じられない」Issueが残る。押し直せば閉じられる形にして、
 * 「確認コマンドがあるのに、通った記録が無い」ことだけを1回見せる。
 *
 * **判定の材料は2つだけ**——本文に確認コマンドがあるか（`extractVerificationCommands`）と、
 * すべて通った記録があるか（`Issue.manualStepVerifiedAt`。定期巡回#2008と、人が流した
 * 代行実行#2256の両方が書く）。**確認を1件ずつ照合しない**のは、通った・通っていないを
 * 画面が持つとサーバーの記録と食い違うため。
 */
export type ManualStepCloseWarning = {
  /** 本文の`## 完了の確認方法`にあるコマンド。手元で流せるよう、そのまま出す */
  commands: string[];
};

export function resolveManualStepCloseWarning(params: {
  body: string | null;
  /** 確認コマンドがすべて通った日時（ISO8601）。通っていなければ`null` */
  verifiedAt: string | null;
}): ManualStepCloseWarning | null {
  if (params.verifiedAt) return null;

  const commands = extractVerificationCommands(params.body);
  // 確認がコマンドで書かれていない手作業は、そもそも機械的に確かめようがない。
  // 出すと「押すたびに1回止まるだけ」の警告になるので、何も出さない
  if (commands.length === 0) return null;

  return { commands: commands.map((entry) => entry.command) };
}
