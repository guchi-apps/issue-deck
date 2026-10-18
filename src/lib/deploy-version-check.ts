/**
 * `deploy.yml`が「稼働版を照合する」かの判定（#4757）。
 *
 * 以前は`APP_COMMIT_SHA`と`/api/app-version`の2語が文字列として含まれるかだけを見ていたため、
 * コメント・echoに2語を書いただけの照合なしのファイルも「照合付き」になり、雛形ではvps#298を指す
 * コメントが判定の根拠になっていた。ここでは**コメントを除いた実行行**から、照合が実際に
 * どこで行われるかを次の2つに分けて判定する。
 *
 * - `self`: `deploy.yml`自身が照合する。`/api/app-version`を引き（curl等）、`sha`を比較し、不一致ならジョブを失敗させる
 *   （issue-deck自身の`.github/workflows/deploy.yml`のヘルスチェック）
 * - `gate`: VPSのgate（`/usr/local/sbin/app-deploy-gate`）へ`APP_COMMIT_SHA`を`env`で渡し、`deploy`を呼ぶ。
 *   照合はgateが行う。gateの照合は{@link APP_DEPLOY_GATE_VERIFIES_SINCE}以降の版が実装している
 */

export const APP_DEPLOY_GATE_VERIFIES_SINCE = {
  repo: "guchi-apps/vps",
  /** `.env`の`APP_COMMIT_SHA`と`127.0.0.1:<port>/api/app-version`の`sha`を2秒おき最大30回突き合わせ、不一致なら`die`する版（scripts/app-deploy-gate.sh） */
  commit: "a25fa44",
  pullRequest: "guchi-apps/vps#298",
} as const;

export type DeployVersionCheck = "self" | "gate" | "none";

/** YAMLの全行コメントと、空白に続く行末コメントを落とす。コメントは判定の根拠にしない */
export function stripYamlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/\s+#.*$/, "")))
    .join("\n");
}

const PRINT_ONLY = /^\s*(?:-\s*)?(?:echo|printf)\b/;

export function classifyDeployVersionCheck(deployWorkflowText: string): DeployVersionCheck {
  const lines = stripYamlComments(deployWorkflowText).split("\n");

  // deploy.yml自身: 取得（echo/printfではない行にある/api/app-version）・sha比較・失敗させる、の3つが揃う
  const fetchesVersion = lines.some((line) => !PRINT_ONLY.test(line) && /\b(?:curl|wget)\b/.test(line) && line.includes("/api/app-version"));
  const comparesSha = lines.some((line) => !PRINT_ONLY.test(line) && /\bgrep\b|\bjq\b|\[\[?\s/.test(line) && /\bsha\b|APP_COMMIT_SHA/.test(line));
  const failsJob = lines.some((line) => /^\s*exit\s+[1-9]/.test(line));
  if (fetchesVersion && comparesSha && failsJob) return "self";

  // gateへ委譲: APP_COMMIT_SHAをenvのキーとして持ち、gateへ.envとして流し（`ssh … env`）、`ssh … deploy`を呼ぶ
  const passesEnvKey = lines.some((line) => /^\s*APP_COMMIT_SHA\s*:/.test(line));
  const sendsToGate = lines.some((line) => /"APP_COMMIT_SHA=/.test(line)) && lines.some((line) => /\|\s*ssh\b.*\benv\s*$/.test(line));
  const callsDeploy = lines.some((line) => /\bssh\b.*\sdeploy\s*$/.test(line));
  if (passesEnvKey && sendsToGate && callsDeploy) return "gate";

  return "none";
}

export function hasVersionCheck(deployWorkflowText: string): boolean {
  return classifyDeployVersionCheck(deployWorkflowText) !== "none";
}
