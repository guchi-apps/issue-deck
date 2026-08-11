/**
 * 画面の「ローカルで開始」から、WSL上のClaude Codeセッションをワンクリックで起動するための
 * URL・コマンドを組み立てる（#1049）。
 *
 * 画面（ブラウザ）からWSLのプロセスを直接起動する手段は無いため、Windows側にカスタムURL
 * プロトコル`issuedeck://`を登録し、そのハンドラ経由で`wt.exe`→`wsl.exe`→
 * `scripts/start-local-session.sh`と辿る。登録手順は
 * [docs/multi-agent/local-quick-start.md](../../docs/multi-agent/local-quick-start.md) を参照。
 *
 * このURLは登録さえされていれば**任意のWebページから叩ける**ため、ここで組み立てる値も、
 * 受け取る側（`scripts/windows/issuedeck-protocol.cmd`・`scripts/start-local-session.sh`）も、
 * 英数字・`.`・`_`・`-`とスラッシュ・数字だけを通す前提で揃えている。片側だけを緩めない。
 */

/** カスタムURLプロトコルのスキーム名（Windows側のレジストリ登録キーと一致させる） */
export const LOCAL_SESSION_URL_SCHEME = "issuedeck";

/**
 * WSL側の受け口スクリプト（`~`はハンドラ側のシェルで展開される）。
 *
 * リポジトリの作業ディレクトリではなく、プロトコル登録時に複製した固定の場所を指す（#1076）。
 * 作業ディレクトリを直接指すと、そこが別Issueのブランチに切り替わっている間はファイルが
 * 存在せず起動できない（実際に踏んだ）。複製は
 * `scripts/windows/register-issuedeck-protocol.ps1` が作る。
 */
export const LOCAL_SESSION_LAUNCHER = "~/.local/share/issue-deck/start-local-session.sh";

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
 * `issuedeck://start/<owner>/<repo>/<番号>` を組み立てる。
 * クエリ文字列ではなくパス形式にしているのは、受け口がWindowsのバッチファイル
 * （`findstr`での正規表現検証しかできない）ためで、単純な形式ほど検証が確実になる。
 */
export function buildLocalSessionUrl(repositoryFullName: string, issueNumber: number): string | null {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed || !isValidIssueNumber(issueNumber)) return null;
  return `${LOCAL_SESSION_URL_SCHEME}://start/${parsed.owner}/${parsed.repo}/${issueNumber}`;
}

/**
 * プロトコル未登録の環境向けフォールバックとして、WSLのターミナルへ貼れば同じことが起きる
 * コマンドを返す。URL経路と同じ`start-local-session.sh`を呼ぶ形にし、経路ごとに挙動が
 * 分かれないようにしている。
 */
export function buildLocalSessionCommand(
  repositoryFullName: string,
  issueNumber: number,
): string | null {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed || !isValidIssueNumber(issueNumber)) return null;
  return `${LOCAL_SESSION_LAUNCHER} ${parsed.owner} ${parsed.repo} ${issueNumber}`;
}

/**
 * WSL上のissue-deckのチェックアウト先（#1088）。`scripts/start-local-session.sh`の
 * `resolve_repo_path`が既定で返す場所と同じ値にしている。画面が案内するパスと実際の
 * 解決先がずれると、案内どおりに実行しても登録できない。
 *
 * `~`より下はユーザー環境依存のため、別の場所へ置いている場合に読み替える旨は画面側で添える。
 */
export const LOCAL_SESSION_REPO_PATH = "~/apps/issue-deck";

/** WSLディストロ名を切り替える環境変数名（Windows側で設定する。登録スクリプトと合わせる） */
export const LOCAL_SESSION_WSL_DISTRO_ENV = "ISSUEDECK_WSL_DISTRO";

/** 上記が未設定のときに登録スクリプトが使うディストロ名 */
export const LOCAL_SESSION_DEFAULT_WSL_DISTRO = "Ubuntu";

/**
 * `issuedeck://`をWindowsへ登録するコマンド（#1088）。
 *
 * Windows側のPowerShellスクリプトだが、**WSLのターミナルへそのまま貼れる1行**にしている。
 * 画面を見ている流れのままコピーして実行できるようにするためで、`wslpath -w`がWSLのパスを
 * Windowsのパス（`\\wsl.localhost\...`）へ変換する。`~`はコマンド置換の中でもシェルが
 * 展開するため、ユーザー名を埋め込まずに済む。
 */
export const LOCAL_SESSION_REGISTER_COMMAND = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ${LOCAL_SESSION_REPO_PATH}/scripts/windows/register-issuedeck-protocol.ps1)"`;

/** 動作確認用のリポジトリ。`start-local-session.sh`が設定ファイル無しで解決できる唯一のもの */
export const LOCAL_SESSION_TEST_REPOSITORY = "guchi-apps/issue-deck";

/**
 * 動作確認用のIssue番号。**実在しない番号**を使う。
 * `start-issue.sh`はIssueの取得を`git worktree add`より前に行うため、取得に失敗した時点で
 * 止まり、ブランチもworktreeも作られない。実在する番号ではその場で実装セッションが始まる。
 */
export const LOCAL_SESSION_TEST_ISSUE_NUMBER = 99999;

/**
 * 実体を作らずに経路（レジストリ登録→ハンドラ→WSLの受け口）だけを確認するURL（#1088）。
 * 形式が`buildLocalSessionUrl`とずれていないことは`local-session.test.ts`で固定している。
 */
export const LOCAL_SESSION_TEST_URL = `${LOCAL_SESSION_URL_SCHEME}://start/${LOCAL_SESSION_TEST_REPOSITORY}/${LOCAL_SESSION_TEST_ISSUE_NUMBER}`;
