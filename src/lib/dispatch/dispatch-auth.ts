import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * ディスパッチAPI（`/api/dispatch/claim`・`/report`・`/hosts`）の認証（#1179）。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、systemdのtimerから
 * 無人で走るためログインセッションを持たない。
 *
 * **`PROGRESS_REPORT_SECRET`を流用せず、専用の`DISPATCH_SECRET`を持つ。**
 * 進捗報告のシークレットはorganization secretとして全リポジトリのワークフローから
 * 参照できる値で、そこに「キューからジョブを取り出せる」権限まで載せると、
 * どこか1つのリポジトリのワークフローが漏らしただけでジョブの横取りが成立してしまう。
 * 値を分ければ、漏洩時に停止・再発行する範囲もそれぞれに閉じられる。
 *
 * 未設定なら`not_configured`（503）。poller側は「設定漏れ」として案内を出し、
 * 値の不一致（401）と区別できるようにする。
 */
export function authorizeDispatch(authorizationHeader: string | null): SharedSecretAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.DISPATCH_SECRET);
}
