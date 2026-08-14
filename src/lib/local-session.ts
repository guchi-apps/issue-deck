/**
 * ローカルのClaude Codeセッション起動まわりの共有値（#1049）。
 *
 * **`issuedeck://`によるワンクリック起動（「このPC」）は#1263で廃止した。** 手元で作業する
 * ときはVS Codeを自分で開いているので、必要なのは新しいセッションを丸ごと立てることではなく、
 * 開いているセッションへ貼れる文面（`lib/prompts/build-implementation-prompt.ts`）だった。
 * 廃止にあわせて、Windowsのプロトコル登録・受け口の複製・登録済みかどうかを検知できない問題
 * （#1088）・複製の陳腐化（#1085・#1089）もまとめて無くなっている。
 *
 * 残っているのは次の2つ。
 *
 * - **ローカル起動プロトコルの契約バージョン**（#1073）。サブPCの`scripts/start-local-session.sh`が、
 *   マーカー行を持つリポジトリでは自前の`scripts/start-issue.sh`を優先する分岐に使う
 * - **起動コマンドの組み立て**。ターミナルへ貼ればworktreeの作成から起動まで行える
 *
 * 組み立てる値は、受け取る側（`scripts/start-local-session.sh`）と同じく英数字・`.`・`_`・`-`と
 * スラッシュ・数字だけを通す前提で揃えている。片側だけを緩めない。
 */

/**
 * ローカル起動の受け口スクリプト。ターミナルへ貼るコマンドの先頭に置く。
 *
 * **`~/.local/share/issue-deck/`への複製ではなく、チェックアウトを直接指す**（#1263）。
 * 複製を作っていたのは`issuedeck://`の登録スクリプトで、その経路ごと廃止したため複製する
 * 主体がいなくなった。複製が陳腐化する問題（#1085・#1179）も同時に無くなっている。
 *
 * 元々の複製の狙い（#1076）は「作業ディレクトリが別Issueのブランチに切り替わっている間に
 * ファイルが消える」ことの回避だったが、ここが指すのは本体のチェックアウトで、worktreeでは
 * ないため同じ問題は起きない。
 */
export const LOCAL_SESSION_LAUNCHER = "~/apps/issue-deck/scripts/start-local-session.sh";

/**
 * 「ローカル起動プロトコル」の版数（#1073）。
 *
 * ワンクリック起動は、対象リポジトリの`scripts/start-issue.sh`を呼ぶ形で成り立っている。
 * リポジトリごとに実体を持つため、**ファイルがあっても約束を守っているとは限らない**
 * （例: `ISSUE_DECK_SKIP_LAN_SETUP`を解釈しないリポジトリでは、UACを承認しても待ちから
 * 戻らずタブが固まる）。存在だけを条件にするとこの最悪ケースを通してしまう。
 *
 * そこで各リポジトリの`scripts/start-issue.sh`の冒頭にマーカー行を宣言させ、
 * **これを対応可否の単一の真実として扱う**。受け口（`scripts/start-local-session.sh`）・
 * 画面・検査スクリプト（`scripts/check-local-session-contract.sh`）が同じ行を見る。
 *
 * 約束の内容は [docs/multi-agent/local-quick-start.md](../../docs/multi-agent/local-quick-start.md)
 * を参照。**約束を増やす・変える場合はこの版数を上げる。**
 *
 * v2（#1178）で増えた約束は次の2つ。どちらもWindows Terminalが無いマシン（サブPCのUbuntu・
 * SSH越しの実行）で起動できるようにするためのもので、v1のリポジトリも引き続き受け入れる
 * （`isSupportedLocalSessionContract`が版数の上限だけを見る）。
 *
 * - Windows Terminalが無い環境では、tmuxの新しいセッションを出口にする
 * - `ISSUE_DECK_DEV_PORT_BASE`が渡されない経路でも、自リポジトリのポート帯を既定値として使う
 */
export const LOCAL_SESSION_CONTRACT_VERSION = 2;

/**
 * マーカー行にマッチする正規表現。`scripts/start-local-session.sh`・
 * `scripts/check-local-session-contract.sh`のgrepパターンと同じものを表す。
 * 片方だけを変えると判定がずれるため、変更するときは3か所を揃える。
 */
export const LOCAL_SESSION_MARKER_PATTERN = /^#\s*issue-deck-local-session:\s*v(\d+)\s*$/m;

/**
 * `scripts/start-issue.sh`の内容から、宣言されている契約の版数を読む。
 * マーカーが無ければ`null`（＝ワンクリック起動に対応していない）。
 */
export function parseLocalSessionContractVersion(startIssueScript: string): number | null {
  const matched = LOCAL_SESSION_MARKER_PATTERN.exec(startIssueScript);
  if (!matched) return null;
  const version = Number.parseInt(matched[1], 10);
  return Number.isInteger(version) && version > 0 ? version : null;
}

/**
 * 宣言された版数を、issue-deck側が扱える版数として受け入れるか。
 *
 * 現状はv1のみ。将来v2を出したときに、v1のままのリポジトリを切り捨てるか受け入れるかを
 * ここで決められるようにしている（判定を1か所に閉じておく）。
 */
export function isSupportedLocalSessionContract(version: number | null): boolean {
  return version !== null && version <= LOCAL_SESSION_CONTRACT_VERSION;
}

/**
 * 画面に「起動コマンドをコピー」の選択肢を出してよいか（#1073・#1263）。
 *
 * 貼ったコマンドは対象リポジトリの`scripts/start-issue.sh`を呼ぶ形で成り立っているため、
 * マーカー行を宣言していないリポジトリでは受け口の段階で止まる。**出しても押した先で
 * 止まるだけの選択肢を並べない**ためのゲート。
 *
 * 判定材料は`Repository.hasLocalStartScript`のみ。**`false`のときだけ隠し、`undefined`では
 * 隠さない。** リポジトリ情報が見つからない場合に誤って導線を消さないためで、
 * `startImplementationDisabledReason`（`lib/github/start-implementation.ts`）と同じ判断。
 *
 * ローカルの対応表（`~/.config/issue-deck/local-repos.conf`）とチェックアウトのブランチは
 * 画面からは知りようがないので、**出した選択肢が失敗することはある**。
 *
 * **サブPCへのディスパッチのゲートには使わない**（#1224）。サブPC側は汎用ランチャーで
 * マーカー行を持たないリポジトリも起動できるため、GitHub上のファイルの有無で隠すと
 * 「実際には起動できるのにボタンが出ない」ことになる。サブPC導線の可否は、実際にcloneされ
 * 起動できるかを申告しているサブPC側の情報（`resolveDispatchTargetRejection`）だけで判定する。
 */
export function canStartLocalSession(hasLocalStartScript: boolean | undefined): boolean {
  return hasLocalStartScript !== false;
}

/**
 * owner・repoに許可する文字。GitHubのowner名・リポジトリ名で実際に使われうる文字に限定し、
 * `;`（Windows Terminalのサブコマンド区切り）や空白・引用符が混ざる余地を無くしている。
 */
const OWNER_OR_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `.`を許可文字に含めている都合で`.`・`..`自体が通ってしまうため、別途弾く。
 * 受け口側がこの値をパスの一部として使った場合に親ディレクトリへ抜けるのを防ぐ
 * （GitHubのowner名・リポジトリ名としても実在しない）。
 */
function isDotSegment(value: string): boolean {
  return /^\.+$/.test(value);
}

/**
 * `owner/repo`形式のリポジトリ名を検証して分解する。想定外の形式ならnullを返し、
 * 呼び出し側でボタンを出さない・URLを組み立てないという扱いにする。
 */
export function parseRepositoryFullName(
  repositoryFullName: string,
): { owner: string; repo: string } | null {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER_OR_REPO_PATTERN.test(owner) || !OWNER_OR_REPO_PATTERN.test(repo)) return null;
  if (isDotSegment(owner) || isDotSegment(repo)) return null;
  return { owner, repo };
}

/** Issue番号として妥当か（正の整数のみ） */
function isValidIssueNumber(issueNumber: number): boolean {
  return Number.isInteger(issueNumber) && issueNumber > 0;
}

/**
 * ターミナルへ貼れば、worktreeの作成から新しいセッションの起動までを行うコマンドを返す。
 * サブPCのpollerが呼ぶのと同じ`start-local-session.sh`なので、経路ごとに挙動が分かれない。
 */
export function buildLocalSessionCommand(
  repositoryFullName: string,
  issueNumber: number,
): string | null {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed || !isValidIssueNumber(issueNumber)) return null;
  return `${LOCAL_SESSION_LAUNCHER} ${parsed.owner} ${parsed.repo} ${issueNumber}`;
}
