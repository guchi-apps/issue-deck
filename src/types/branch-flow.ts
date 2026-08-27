import type { ReleaseMergeTarget } from "@/lib/github/release-button-status";
import type { ProgressStatusKey } from "@/lib/issue-progress";
import type { PullRequestKind, PullRequestSummary } from "@/types/pull-request";

/**
 * 未リリースの変更を「マージコミット単位」で数えた内訳（#2333）。
 *
 * **数えるのは`main..develop`のfirst-parentの列だけ。** 通常マージ運用では、PR 1件の
 * マージにつき作業ブランチ側のコミット（1個とは限らない）とマージコミットが両方
 * `aheadBy`へ載るため、コミット数は実質的な作業の件数より必ず多く出る。first-parentを
 * たどると、developの幹に直接載った単位＝「PRのマージ1回」または「直接push 1回」だけが
 * 残るので、squash mergeのリポジトリ（1PR＝1コミット）でも同じ数え方で正しくなる。
 */
export type UnreleasedUnits = {
  /** PRのマージコミットの数。**バージョンバンプのマージは含まない**（`versionBumpCount`へ分ける） */
  mergeCount: number;
  /**
   * マージを経ずdevelopの幹へ直接載ったコミットの数。直接pushのほか、
   * squash mergeしたPRもここに入る（マージコミットが残らないため）。
   */
  directCount: number;
  /**
   * バージョンバンプPR（`release/vX.Y.Z`→`develop`）のマージコミットの数。
   * リリースの配管であって出す中身ではないので、件数の本体からは外して別枠で数える。
   */
  versionBumpCount: number;
};

/** `develop`が`main`よりどれだけ進んでいるか */
export type BranchComparison = {
  /** baseに対してheadが進んでいるコミット数 */
  aheadBy: number;
  /** baseに対してheadが遅れているコミット数 */
  behindBy: number;
  /**
   * `main`と`develop`の**中身（tree）が同一**か（#2316）。
   *
   * **`aheadBy`が1以上でも、出すものが無いことがある。** リリースフローは
   * バンプPR（`release/vX.Y.Z`→develop）のhead（`$GITHUB_SHA^2`）を`release-main/vX.Y.Z`
   * として凍結してmainへ出す（#2117）ため、バンプPRを`develop`へマージしたときにできる
   * **マージコミットだけがdevelop側に取り残される**。差分は0ファイルなのに`aheadBy`は1に
   * なり、リリース直後のリポジトリすべてが「未リリース 1コミット」に見えていた。
   *
   * tree OIDの一致で判定するので、コミット数ではなく実際に出るものの有無を表す。
   * 取得できなかった場合はfalse（＝差分があるものとして扱い、リリースを止めない）。
   */
  sameContent: boolean;
  /**
   * マージコミット単位で数えた内訳（#2333）。**コミット一覧を取れなければ`null`**で、
   * その場合は従来どおり`aheadBy`をコミット数として出す。
   *
   * 取れないのは、比較のコミットが取得上限（100件）を超えているとき、または
   * `headTarget`のOIDが読めずfirst-parentをたどれないとき。
   */
  units: UnreleasedUnits | null;
};

/**
 * リポジトリ1件ぶんのブランチ状況。`GET /api/branch-flow`が返す。
 *
 * **ブランチを列挙するのではなく、知りたいブランチだけを名指しで確認した結果**を持つ
 * （理由は`lib/github/branches-api.ts`）。そのため「確認したもの」と「存在したもの」を
 * 分けて返す。確認していないブランチについては、この応答は何も言っていない。
 */
export type RepositoryBranchStatus = {
  repositoryFullName: string;
  /** 存在を問い合わせたブランチ名 */
  checkedBranches: string[];
  /** そのうち実在したブランチ名 */
  existingBranches: string[];
  /** `main`と`develop`の差分。どちらかのブランチが無いリポジトリではnull */
  developVsMain: BranchComparison | null;
  /**
   * リリース用workflow（`release-develop-to-main.yml`）を持つか（#1538）。
   * 「リリースする」ボタンを出してよいかの前提。取得に失敗した場合はfalse（出さない）。
   */
  hasReleaseWorkflow: boolean;
  /**
   * 本番デプロイworkflow（`deploy.yml`）を持つか（#2020）。
   * 「本番へ再デプロイ」ボタンを出してよいかの前提。取得に失敗した場合はfalse（出さない）。
   *
   * **`hasReleaseWorkflow`で代用しない。** 現時点ではこの2つを持つリポジトリの集合は一致して
   * いるが、条件としては別物（`deploy.yml`だけを置いたリポジトリでも出し直しは要る）。
   * 一致しなくなった瞬間に「押せるのに進捗が出ない」「押せないのに出せる」が起こる。
   */
  hasDeployWorkflow: boolean;
};

/**
 * mainブランチ上の本番デプロイworkflow（`deploy.yml`）の最新実行（#1579）。
 * `GET /api/branch-flow/deploy`が返す。取得できなければnull（`deploy.yml`が無い・権限が無い等）。
 */
export type BranchFlowDeployRun = {
  /** queued | in_progress | completed など */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  /**
   * この実行を起こしたイベント（#2020）。`push`＝mainへのマージを受けた本番反映、
   * `workflow_dispatch`＝画面からの手動の出し直し。
   */
  event: string;
  /**
   * 何回目の試行か（初回は1。#2134）。2以上なら`deploy-retry.yml`が自動で再実行したもの
   * （人がGitHubの画面から再実行した場合も同じく増える）。
   */
  runAttempt: number;
};

/**
 * 本番デプロイの失敗を追跡するために自動起票したIssueへの参照（#2236）。
 *
 * **失敗の表示から、それを追いかけているIssueへ1回で移れるようにするためだけの型。**
 * 起票そのものは`lib/github/deploy-failure-sweep-run.ts`が行い、ここに出るのは
 * その結果（DBの`DeployFailureIssue`）を読んだもの。
 */
export type DeployFailureIssueRef = {
  number: number;
  htmlUrl: string;
};

/** リポジトリ1件ぶんの本番デプロイ状況。`GET /api/branch-flow/deploy`が返す */
export type RepositoryDeployStatus = {
  repositoryFullName: string;
  deployRun: BranchFlowDeployRun | null;
  /** そのリポジトリで開いているデプロイ失敗Issue。無ければnull（#2236） */
  failureIssue: DeployFailureIssueRef | null;
};

export type BranchFlowDeployResponse = {
  repositories: RepositoryDeployStatus[];
  /** 取得時刻（ISO8601） */
  fetchedAt: string;
};

/**
 * mainへマージした変更が本番へ届いたか（#1579）。
 *
 * - `waiting` … マージ済みだが、今回のデプロイ実行がまだ現れていない
 * - `running` … デプロイ実行中
 * - `success` … デプロイ成功（＝ここで初めて「本番反映」と言ってよい）
 * - `failure` … デプロイが失敗した（**mainには入ったが本番には出ていない**）
 *
 * 判定できない場合（実行を1件も取得できない）は`null`にし、画面は従来の表示のままにする。
 */
export type BranchFlowDeployStateKind = "waiting" | "running" | "success" | "failure";

export type BranchFlowDeployState = {
  kind: BranchFlowDeployStateKind;
  /** 実行ログのURL。`waiting`（実行がまだ現れていない）ではnull */
  htmlUrl: string | null;
  /**
   * 画面から手動で起こした出し直しの実行か（#2020）。
   *
   * **この状態が「その版が本番へ出たか」を表していないことの印。** 出し直しはすでに本番へ出た
   * mainをもう一度出しているだけなので、走っている間も失敗したときも、版の見出しの「本番反映」を
   * 取り消してはいけない（取り消すと、出ている版が出ていないように読める）。
   */
  manual: boolean;
  /**
   * 失敗を自動で再実行した後の実行か（#2134）。
   *
   * **「失敗しか通知されない」状態を画面側でも作らないための印。** これが無いと、自動再実行が
   * 走っている間の表示は初回の実行中と見分けが付かず、人は自分で「本番へ再デプロイ」を押しに
   * 行くしかないと読んでしまう（#2072と同じ問題）。`failure`と組み合わさったときは
   * 「1回やり直しても駄目だった」＝人が見る番になったことを意味する。
   */
  autoRetried: boolean;
};

export type BranchFlowResponse = {
  repositories: RepositoryBranchStatus[];
  /** 取得時刻（ISO8601）。画面のヘッダーに「〜時点」として出す */
  fetchedAt: string;
  /** 取得に失敗したリポジトリのfullName。1件の失敗で全体を落とさないため個別に返す */
  failedRepositories: string[];
};

/**
 * 作業レーン1本の状態。「ブランチとPRがどうなっているか」を1語で表す。
 *
 * - `no-pull-request` … ブランチはあるがPRが1件も無い（実装中、またはPRの作り忘れ）
 * - `open` … マージ待ちのPRがある
 * - `merged` … マージ済み
 * - `closed` … PRが未マージのままクローズされた
 *
 * **「マージ済みなのにブランチが残っている」は状態として持たない。** このリポジトリ群は
 * マージ後のブランチ削除を自動化しておらず（`delete_branch_on_merge`が無効）、実際に数百本の
 * `issue-*`が残っているため、全件が該当してしまい情報にならない。ブランチの掃除は別の
 * 仕組みの話として切り離す。
 */
export type BranchFlowLaneStatus = "no-pull-request" | "open" | "merged" | "closed";

/**
 * レーンに残っている手作業Issue（`71.manual-step`。#1510）。
 *
 * **GitHubネイティブのサブIssue関係は使わない。** 親子関係はDBへキャッシュしておらず
 * （`/api/issues/sub-issues`はIssue詳細を開いたときだけ取る）、持たせるにはGitHub Appの
 * `sub_issues`Webhook購読の追加とスキーマ変更が要る。手作業Issueは本文の`## 関連`へ
 * 起点Issueの番号を書く決まりなので、**DBキャッシュにある本文からの推定で足りる**。
 */
export type BranchFlowManualStep = {
  number: number;
  title: string;
  state: "open" | "closed";
};

/** レーンに紐づくIssue。DBキャッシュに無いIssueでも番号だけは出せるようにする */
export type BranchFlowIssueRef = {
  number: number;
  /** DBキャッシュに無い場合はnull（番号だけ表示する） */
  title: string | null;
  /** DBキャッシュに無い場合はnull */
  progress: ProgressStatusKey | null;
  /** DBキャッシュに無い場合はnull */
  state: "open" | "closed" | null;
};

/**
 * Issueの優先度（`80.Priority: High` / `89.Priority: low`）。付いていなければnull（#1704）。
 *
 * ブランチ画面が使うのは**実装予定の並び順と1行の表示だけ**なので、ラベル名から解決した結果を
 * この2値へ潰して持つ。優先度ラベルは`11.local`と番号帯が重ならないよう80・89番台にリネーム済み。
 */
export type BranchFlowIssuePriority = "high" | "low";

/**
 * 実行ボタンを押して動き出した、まだブランチが無いIssue（#1704・#2386）。
 *
 * ブランチ画面のレーンはPRのheadブランチと実在する作業ブランチの和集合で作るため、
 * **押した直後のIssueは画面のどこにも現れない**（作業ブランチがGitHubへ現れるのは最初のpushから）。
 * 「いま何本走っているか」を同じ画面で見せるために、レーンにならないIssueをそのまま並べる。
 * 材料は既存のIssueキャッシュだけで、追加の取得は無い。
 *
 * **`ready`（未着手）は入らない**（#2386）。ここが未着手を含んでいたころは、バックログ全体の
 * 大きさが畳んだ1行の件数になっており、見ても何も起こせなかった。
 */
export type BranchFlowStartedIssue = BranchFlowIssueRef & {
  priority: BranchFlowIssuePriority | null;
};

/**
 * マージ済みの作業が本番（main）まで届いているか（#1455）。
 *
 * - `released` … develop→mainのリリースPRに乗ってmainへ入った。`version`はそのリリースの版
 *   （リリースPRのタイトルから取れなかった場合はnull）
 * - `pending` … developには入ったが、まだリリースPRが出ていない（本番未反映）
 * - `unknown` … 取得しているクローズ済みPRの範囲より古く、どのリリースに乗ったか特定できない
 */
export type BranchFlowReleaseState =
  | { kind: "released"; version: string | null; pullRequestNumber: number }
  | { kind: "pending" }
  | { kind: "unknown" };

/**
 * `develop`へ向かう作業1本ぶん（Issue → ブランチ → PR → マージ先）。
 *
 * PRのあるブランチと、**進行中のIssueに対応する実在のブランチ**の和集合で作る。後者を
 * 混ぜることで「ブランチは上がっているがPRがまだ無い」作業が画面に現れる。
 */
export type BranchFlowLane = {
  /** 一覧のkey。ブランチ名（リポジトリ内で一意） */
  key: string;
  branchName: string;
  kind: PullRequestKind;
  /** このブランチをheadとするPR。新しい順（openを先頭に寄せる） */
  pullRequests: PullRequestSummary[];
  issue: BranchFlowIssueRef | null;
  /**
   * このレーンのPRが参照している、`issue`以外のIssue（#1455）。1本のPRで複数のIssueを
   * 扱った場合にここへ入る。**本文の`#番号`は単なる言及も混ざるため「関連」として出す。**
   */
  relatedIssues: BranchFlowIssueRef[];
  status: BranchFlowLaneStatus;
  /**
   * 本番（main）へ届いているか。**マージ済みのレーンでのみ意味を持ち**、
   * まだマージされていないレーンではnull。どのリリースの束へ入れるかもこれで決まる。
   */
  releaseState: BranchFlowReleaseState | null;
  /** このレーンの対応Issueから生まれた手作業Issue（#1510）。無ければ空配列 */
  manualSteps: BranchFlowManualStep[];
  /** 並び順に使う代表日時（PRがあればその更新日時、無ければnull） */
  updatedAt: string | null;
};

/**
 * リリース1回ぶんの束（#1510）。「このバージョンに何が乗ったか」を表す。
 *
 * 画面はこれを横線1本として描き、`lanes`をその下にぶら下げる。束の作り方は
 * `resolveReleaseState`と同じ計算——作業PRがdevelopへ入った後、最初にマージされた
 * リリースPRがその変更を運んだ——なので、**追加のGitHub API取得は要らない**。
 */
export type BranchFlowReleaseGroup = {
  /** 一覧のkey */
  key: string;
  /** 版。リリースPRのタイトルから取れなかった場合はnull */
  version: string | null;
  /** develop→mainのPR。まだリリースPRが無い（これから出す）束ではnull */
  pullRequest: PullRequestSummary | null;
  /**
   * openなバージョンバンプPR（`release/vX.Y.Z`→develop。#1548）。**先頭（未リリース）の束にだけ入る。**
   *
   * バンプPRは幹の一部なので作業レーンには出さない。レーンとして扱っていたころは、PR本文に並ぶ
   * 「今回のリリース対象issue」の番号を`linkedIssueNumbers`が拾い、無関係なIssueが対応Issue・関連
   * としてぶら下がっていた。マージ済みのバンプPRは持たない（どの版で出たかは束の見出しが表す）。
   */
  bumpPullRequest: PullRequestSummary | null;
  /** mainへ入った日時（ISO8601）。**nullなら未リリース**（進行中またはこれから） */
  mergedAt: string | null;
  /**
   * この版の本番デプロイの状態（#1579）。**いちばん新しくmainへ入った束にだけ入る。**
   * 判定に使うのはmainブランチの`deploy.yml`の最新実行なので、それより前の版については
   * 何も言えない（＝null）。`mergedAt`がnullの束（未リリース）でも常にnull。
   */
  deploy: BranchFlowDeployState | null;
  lanes: BranchFlowLane[];
  /** この束に残っている未完了の手作業Issueの件数 */
  openManualStepCount: number;
};

/**
 * 畳んだ1行（サマリー行）に出す集計（#1510）。
 *
 * **「手が要るか」だけを表す。** 進行中の本数のような量の情報と、CI失敗・マージ待ちのような
 * 手を動かす必要がある情報を分けて持ち、後者をヘッダーの「手が要るもの◯件」に数える
 * （#1932で初回の自動展開をやめたので、開く条件としては使わない）。
 */
export type BranchFlowRepositorySummary = {
  /** まだどのバージョンにも乗っていないレーンの本数（クローズ済みを除く） */
  activeLaneCount: number;
  /** CIが失敗しているopenなPRがある */
  hasCiFailure: boolean;
  /**
   * ユーザーがマージするしかないopenなPRがある（リリースPRを除く）。
   *
   * **畳んだ1行には出さず、ヘッダーの「手が要るもの◯件」だけに使う**（#2172）。ピルとして
   * 出していたころは文言が長く、スマホ幅でその行だけが2段に折り返していた。マージの導線は
   * 開いたPR行とPR一覧画面が持っている。
   */
  needsUserMerge: boolean;
  /**
   * このリポジトリに残っている未完了の手作業Issue（`71.manual-step`）の件数（#1586）。
   *
   * **既定の表示を「次のリリースに乗る分」まで畳んだぶん、ここで数える。** 手作業は
   * 本番へ出た版に紐づいたまま残ることがあり、畳んだ行に出さないと開くまで気づけない。
   * 同じIssueが複数レーンに現れても1件として数える。
   */
  openManualStepCount: number;
  /**
   * リリースが進行中（openなリリースPR、またはopenなバージョンバンプPRがある）。
   * バンプPRを作業レーンから外した（#1548）ぶん、ここで数える。
   */
  releaseInProgress: boolean;
  /**
   * リリースを進めているPR（リリースPR・バージョンバンプPR）が自動で進んでいる最中
   * （CIの実行中、または自動マージ可否の判定中）（#1931・#2326）。
   *
   * **畳んだ1行の「リリース中」に回るアイコンを出すためだけに持つ。** 「リリース中」は
   * CIが走っている間も、CIが終わって人のマージを待っている間も同じ見た目で、開くまで
   * 「待てばよいのか、自分が押す番なのか」を区別できなかった。`unknown`（`Checks: read`が
   * 無い・取得失敗）では実行中と言い切れないためfalseにする。
   *
   * **自動マージ可否の判定中（`claude-review-develop`）も含む**（#2326）。判定はCI状態の
   * 集約から外してある（#1799）ため、CIだけを見ているとClaudeのレビュー中だけアイコンが
   * 止まり、自動で進んでいるリリースが止まって見えていた。
   */
  releaseAutoProgressing: boolean;
  /**
   * リリースを進めているPRのうち、**人がマージするしかない状態で止まっているもの**の
   * マージ先（#2038）。待っていなければnull。
   *
   * 畳んだ1行で「リリース中」（紫・待てば進む）と「mainへマージ待ち」（琥珀・押す番）を
   * 書き分けるために持つ。**紫と琥珀の対比はこの画面の既存の約束**（「ユーザーのマージが
   * 必要」「手作業◯」が琥珀）で、そこへリリースのマージ待ちを合流させる。
   *
   * 判定の基準は展開したときのリリースの見出し（`ReleaseGroupHeader`）と同じく
   * 「CIが`pending`でなくなり、自動マージ可否の判定も終わった時点」（#2326）。
   * **`failure`だけは除く**——赤の「CI失敗」と並べると
   * 「直す必要がある」と「マージすればよい」を取り違えるため（#1059と同じ優先順位）。
   * `unknown`（`Checks: read`が無い・取得失敗）はマージ待ちのまま残す（CI状態が取れない
   * だけで、待っているものが画面から消える方が困る）。
   */
  releaseMergeTarget: ReleaseMergeTarget | null;
  /**
   * 実行ボタンを押したがまだブランチが無いIssueの件数（#1704・#2386）。畳んだ1行に破線の丸の
   * アイコンと数字だけで出す（#1886。言葉は`title`と`aria-label`が持つ）。
   *
   * **`activeLaneCount`（進行中）と足し合わせて「いま動いている総数」になる。** ブランチが
   * 上がったIssueはレーンとして数えられているため、こちらからは外してある。
   *
   * **手が要るものではない**ので、「手が要るもの◯件」の判定（`needsAttention`）には加えない。
   * 開かずに走っている本数だけ分かればよい、というのがこの数字の役目。
   */
  startedIssueCount: number;
  /**
   * 直近のリリースの本番デプロイの状態（#1579）。畳んだ1行に「デプロイ中」「デプロイ失敗」を
   * 出すために持つ。**mainへマージした後もここが動いている間はまだ本番へ出ていない。**
   */
  deploy: BranchFlowDeployState | null;
};

/** `develop` → `main` のリリースレーン */
export type BranchFlowRelease = {
  /** develop→mainのPR。無ければnull */
  pullRequest: PullRequestSummary | null;
  comparison: BranchComparison | null;
  /**
   * 直近でmainへ出た版（マージ済みのリリースPRのうち最も新しいもののタイトルから取る）。
   * 取得できたPRの範囲に1件も無ければnull。
   */
  latestVersion: string | null;
};

export type BranchFlowRepository = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  release: BranchFlowRelease;
  /**
   * まだどのバージョンにも乗っていない作業レーン（#1510）。マージ待ち・PR未作成・
   * 未マージのままクローズ。図のいちばん上に置く。
   */
  activeLanes: BranchFlowLane[];
  /** バージョンごとの束。**新しい順**で、先頭が未リリース（進行中またはこれから）の束 */
  releaseGroups: BranchFlowReleaseGroup[];
  /**
   * developへは入ったが、どの版で本番へ出たか特定できなかったレーン。
   * 取得しているクローズ済みPRの範囲より古いもの。図のいちばん下へまとめる。
   */
  unassignedLanes: BranchFlowLane[];
  summary: BranchFlowRepositorySummary;
  /**
   * リリース用workflow（`release-develop-to-main.yml`）を持つか。「リリースする」を
   * 出してよいリポジトリの前提。**ブランチ状況を取得できていない場合はfalse**（#1538）。
   */
  canRelease: boolean;
  /**
   * いま「リリースする」を押してよいか（#1510）。リリース用workflowがあり、
   * openなリリースPRもバンプPRも無く、未リリースの変更が1つ以上ある場合だけtrue。
   */
  canTriggerRelease: boolean;
  /**
   * いま「本番へ再デプロイ」を押してよいか（#2020）。`deploy.yml`があり、デプロイが
   * 動いていない（`summary.deploy`が`waiting`・`running`でない）場合だけtrue。
   *
   * **未リリースの変更の有無は見ない。** これは`main`をそのまま出し直す操作で、
   * developとの差分は出ないため、リリースの可否とは関係が無い。
   */
  canTriggerDeploy: boolean;
  /**
   * そのリポジトリで開いているデプロイ失敗Issue（#2236）。無ければnull。
   * 失敗の帯からこのIssueへ移れるようにするためだけに持つ。
   */
  deployFailureIssue: DeployFailureIssueRef | null;
  /**
   * developへマージの段階まで進んでいるはずなのに、ブランチもPRも見つからないIssue。
   * 「関連が付いていない」ことを隠さないために出す。
   *
   * **実装中は含めない**（#2386）。押した直後は必ずブランチが無い状態を通るため、異常として
   * 警告すると起動したセッションのぶんだけ枠が出る。そちらは`startedIssues`が普通に並べる。
   */
  orphanIssues: BranchFlowIssueRef[];
  /**
   * 実行ボタンを押して動き出したIssue（#1704・#2386）。進捗が`planning`・`implementation`で、
   * まだどのレーンにも現れていないもの。
   *
   * **`orphanIssues`とは別物。** あちらは「developへマージの段階なのにPRが見つからない」という
   * 異常を隠さないための枠で、こちらは正常な上流（押した直後で、まだpushが無いIssue）。
   * 並びは計画検討中 → 実装中、同じ進捗では優先度の高い順、最後に番号の新しい順。
   */
  startedIssues: BranchFlowStartedIssue[];
  /** ブランチ状況を取得できたか。falseのときはPRだけから組み立てている */
  branchesLoaded: boolean;
};
