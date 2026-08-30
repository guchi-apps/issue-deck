/**
 * 立ち上げで「何が作られるか」と、そのIssueの本文を組み立てる（#2188）。
 *
 * **このファイルも純粋関数だけにする**（`spec.ts`と同じ理由。ウィザードのStep 3が
 * `buildNewAppPlan`をそのまま描く）。
 *
 * 設計の要点は3つ。
 *
 * - **実機の設定ファイルを直接書き換える手順を書かない。** ApacheのVirtualHostは
 *   `guchi-apps/vps`のIssueへ切り出す（CLAUDE.md「VPS・サブPCの設定ファイルの変更は、
 *   管理リポジトリのIssueへ切り出す」）。`/home/github-user/apps/<name>/`の作成・DB作成・
 *   PM2への登録・certbotも、`guchi-apps/vps`の「アプリをプロビジョニングする」ワークフロー
 *   （`guchi-apps/vps#132`）へ寄せた。**人がVPSへSSHする手順はもう出さない**（#2246）。
 * - **サブPCの手順は代行実行の条件を満たす形で書く。** 実行するデバイスがサブPC・1手順に
 *   コマンドブロックがちょうど1つ・対話が要るコマンドを含まない・`<…>`のプレースホルダを
 *   含まない、のすべてを満たしたときだけ画面から流せる
 *   （`lib/dispatch/dispatch-job.ts`の`manualStepExecutionRejection`）。
 * - **新しいリポジトリのIssueは、作った直後から盤面に載る**（#2247）。載る条件は
 *   `claude-issue-dispatch.yml`がデフォルトブランチにあることで、以前はそれを作るのが
 *   初期化Issue自身だった。いまはリポジトリを作った直後にissue-deckが雛形一式をコミット
 *   する（`lib/new-app/scaffold.ts`）ので、初期化Issueも最初から無人実行で回せる。
 *   **サブPCの手作業Issueは残るが、初期化Issueの前提ではなくなった**——あちらの目的は
 *   1Passwordへの値の投入（#2249）で、cloneはローカルセッションを使いたいときのため。
 * - **人が空振りする手順を書かない**（#2248・#2246）。2つの再同期は立ち上げ自身が実行し
 *   （`lib/new-app/resync.ts`）、GitHub Appのインストール対象への追加は
 *   `repository_selection`が`selected`のときだけ出す（`lib/new-app/installation-scope.ts`）。
 *   DNSのAレコードは`*.gucchii.com`のワイルドカードで済み（`guchi-apps/vps#131`）、
 *   Actions secretsはorganizationに`visibility=all`で登録済み（#2255）なので、
 *   **ブラウザの手作業Issueは残る手順があるときだけ作る**。
 */

import {
  LOCAL_PORT_BAND_CONF_PATH,
  formatLocalPortBandLine,
} from "@/lib/new-app/local-port-bands";
import {
  NEW_APP_AUTH_LABELS,
  NEW_APP_ORG,
  NEW_APP_PARENT_REPOSITORY,
  NEW_APP_VPS_REPOSITORY,
  appTitleFor,
  hostnameFor,
  newAppKindProfile,
  offlineEnabled,
  publicUrlFor,
  screenshotBypassEnabled,
  supportsUnattendedScreenshot,
  vpsAppListLocation,
  type NewAppSpec,
} from "@/lib/new-app/spec";

/** 手作業Issueに付けるラベル（`00.check-user`は付けない）。 */
export const MANUAL_STEP_LABEL = "71.manual-step";

/**
 * 立ち上げが決めた値を1PasswordとGitHubのsecretへ入れるスクリプト（#2249）。
 *
 * **サブPCの本体チェックアウトから絶対パスで呼ぶ。** 代行実行のcwdはホームに固定されており
 * （`scripts/run-manual-step.sh`）、新しいリポジトリのチェックアウトはまだ無いことがある。
 */
const PROVISION_SCRIPT = "$HOME/apps/issue-deck/scripts/provision-app-secrets.sh";

/** 実機の配置先。`/apps/<name>`ではない（#2246。同じ立ち上げの中で2つのパスが混在していた）。 */
function serverAppDir(spec: Pick<NewAppSpec, "repositoryName">): string {
  return `/home/github-user/apps/${spec.repositoryName}`;
}

/**
 * VPS実機の受け入れ（置き場・DB・vhostの有効化・PM2への登録・certbot・`:443`の
 * `X-Forwarded-Proto`）を1回で行う`guchi-apps/vps`のワークフロー（`guchi-apps/vps#132`）。
 *
 * **これができたので、VPSの手作業はSSHではなくサブPCからの1コマンドになった**（#2246）。
 * 実行するのは実機に配置済みの`scripts/provision-app.sh`で、何度流しても結果は同じ。
 * 済んでいる段は「(変更なし)」と出るだけなので、初回デプロイの前と後で2回流してよい。
 */
const VPS_PROVISION_WORKFLOW = "provision-app.yml";

/**
 * プロビジョニングのワークフローで受け入れられるか。
 *
 * **常駐プロセスを持たない種別（静的サイト）は対象外。** ワークフローの入力`app_port`が必須で、
 * `scripts/provision-app.sh`も1024〜65535を要求する。その場合だけ従来どおり実機の手順を出す。
 */
function vpsProvisionable(spec: Pick<NewAppSpec, "port">): boolean {
  return spec.port !== null;
}

/**
 * プロビジョニングを流すコマンド。**`<…>`のプレースホルダを残さない**——残すと
 * 代行実行の対象から外れる（`lib/dispatch/dispatch-job.ts`の`manualStepExecutionRejection`）。
 */
function vpsProvisionCommand(spec: NewAppSpec): string {
  const args = [
    `-f app_name=${spec.repositoryName}`,
    `-f app_host=${hostnameFor(spec)}`,
    `-f app_port=${spec.port}`,
  ];
  if (spec.databaseName) args.push(`-f db_name=${spec.databaseName}`);
  return [
    `gh workflow run ${VPS_PROVISION_WORKFLOW} --repo ${NEW_APP_VPS_REPOSITORY}`,
    ...args,
  ].join(" \\\n    ");
}

/**
 * シークレット投入コマンド。**フィールド名の羅列にせず、そのまま貼れる1コマンドで出す**（#2249）。
 *
 * `aide-bot`の立ち上げでは「`db-name = app_aide_bot / ci-webhook-url（Signaly）/ target-dir = …`」
 * という羅列を手作業Issueに書いていたため、値が未登録のまま初回の本番デプロイが走り
 * `DB_NAME: DB_NAME is required` で失敗した（`guchi-apps/aide-bot#4`→`#8`）。
 *
 * 機械的に定まる値（配置先・DB名・許可メール）と、人がSignalyで作らないと決まらない
 * webhook URLとで**呼び分ける**。スクリプトは何度実行してもよい作りなので、順序は問わない。
 */
function provisionCommand(
  spec: NewAppSpec,
  ciWebhookUrl: string | null,
  options: { check?: boolean } = {},
): string {
  const args = [`--repo ${repositoryFullName(spec)}`];
  if (ciWebhookUrl === null) {
    if (spec.databaseName) args.push(`--db-name ${spec.databaseName}`);
    // 許可メールは既存アプリの値をコピーする（コピー元はスクリプト側に持たせている）
    if (spec.auth !== "none") args.push("--copy-allowed-emails");
  } else {
    args.push(`--ci-webhook-url '${ciWebhookUrl}'`);
  }
  // 確認用は同じ引数に`--check`を足すだけにする（#2256）。投入と確認で対象のフィールドが
  // ずれると、「入っていない値を確かめていない」という一番まずい形になる
  if (options.check) args.push("--check");
  // 続きの行は2つ下げる（コードブロック自体が箇条書きの下に2スペース下がっているため、
  // 同じ幅だと折り返しに見えない）
  return [PROVISION_SCRIPT, ...args].join(" \\\n    ");
}

/** 作成物の自動化の度合い。画面のチップの色に対応する。 */
export type NewAppAutomation =
  /** issue-deckがその場で作る */
  | "auto"
  /** 手作業だが、手作業アシスタントが代行実行できる */
  | "proxy"
  /** 人が画面や実機で行うしかない */
  | "manual";

export type NewAppArtifactKind =
  | "repository"
  | "port-band"
  | "parent-issue"
  | "init-issue"
  | "deploy-check-issue"
  | "vps-issue"
  | "manual-vps"
  | "manual-subpc"
  | "manual-browser";

export type NewAppArtifact = {
  kind: NewAppArtifactKind;
  automation: NewAppAutomation;
  /** 画面に出す見出し */
  title: string;
  /** どこに作られるか（`guchi-apps/vps`）。リポジトリ作成そのものは`null` */
  target: string | null;
  /** 補足の1〜2行 */
  description: string;
};

export function repositoryFullName(spec: Pick<NewAppSpec, "repositoryName">): string {
  return `${NEW_APP_ORG}/${spec.repositoryName}`;
}

export type NewAppPlanOptions = {
  /**
   * 払い出す予定のローカルセッションのポート帯。preflightが実物の対応表から決める。
   * 決まっていなければ`null`で、そのときは値を出さずに「確保する」とだけ書く。
   */
  localPortBase?: number | null;
  /**
   * GitHub Appのインストール対象へ手で追加する手順が要るか（#2248）。
   * `repository_selection=all`なら不要で、既定はその想定の`false`。
   */
  githubAppNeedsRepositoryAdd?: boolean;
};

/**
 * 「立ち上げを開始」で作られるものの一覧。**押す前にそのまま画面へ出す**ため、
 * 実行順と同じ並びにする。
 */
export function buildNewAppPlan(
  spec: NewAppSpec,
  options: NewAppPlanOptions = {},
): NewAppArtifact[] {
  const repo = repositoryFullName(spec);
  const host = hostnameFor(spec);
  const localPortBase = options.localPortBase ?? null;
  const githubAppNeedsRepositoryAdd = options.githubAppNeedsRepositoryAdd ?? false;

  const artifacts: NewAppArtifact[] = [
    {
      kind: "repository",
      automation: "auto",
      title: repo,
      target: null,
      description: `リポジトリを${spec.visibility === "private" ? "private" : "public"}で作り、既定ブランチを develop にしてラベル一式を写す。CI・デプロイ・無人実行の雛形一式もこの時点でコミットする`,
    },
    {
      kind: "port-band",
      automation: "auto",
      title:
        localPortBase === null
          ? "ローカルセッションの開発サーバーのポート帯を確保する"
          : `ローカルセッションの開発サーバーのポート帯 ${localPortBase} を確保する`,
      target: NEW_APP_PARENT_REPOSITORY,
      description: `\`${LOCAL_PORT_BAND_CONF_PATH}\` へ1行足すPull Requestを作る。載せないと汎用ランチャーの既定 3000 + Issue番号 に落ち、未登録のリポジトリ同士でポートが衝突する`,
    },
    {
      kind: "parent-issue",
      automation: "auto",
      title: `${spec.displayName}の立ち上げ`,
      target: "guchi-apps/issue-deck",
      description: "以下をサブIssueとして紐付ける親Issue",
    },
    {
      kind: "init-issue",
      automation: "auto",
      title: "プロジェクトを初期化する",
      target: repo,
      description: spec.multiAgent
        ? "アプリ本体の雛形とpackage.jsonの整備。ワークフローは作成時にコミット済みで、盤面から無人実行で回せる"
        : "アプリ本体の雛形とpackage.jsonの整備。CI・デプロイの雛形は作成時にコミット済み",
    },
    {
      kind: "deploy-check-issue",
      automation: "auto",
      title: "初回デプロイ前チェックと公開確認",
      target: repo,
      description: `周辺インフラの実地確認と、${publicUrlFor(spec)} が開けることの確認。**deployジョブの成功は公開できたことを保証しない**（#2252）`,
    },
    {
      kind: "vps-issue",
      automation: "auto",
      title:
        spec.urlMode === "subdomain"
          ? `${host}のVirtualHostを追加し、アプリ一覧に載せる`
          : `${host}のVirtualHostへ${spec.basePath}を足し、アプリ一覧に載せる`,
      target: NEW_APP_VPS_REPOSITORY,
      description: "実機を直接触らずGit経由で反映する（developへのマージとリリースPRの2回）",
    },
    {
      kind: "manual-vps",
      automation: vpsProvisionable(spec) ? "proxy" : "manual",
      title: buildVpsManualIssueTitle(spec),
      target: "guchi-apps/issue-deck",
      description: vpsProvisionable(spec)
        ? `置き場・DB・vhostの有効化・PM2への登録・certbotを、${NEW_APP_VPS_REPOSITORY}の「アプリをプロビジョニングする」ワークフローへ流すだけ（\`guchi-apps/vps#132\`）。SSHもsudoも要らず、手作業アシスタントの代行実行で流せる`
        : "ディレクトリ作成・vhostの有効化・certbot。常駐プロセスを持たない種別はプロビジョニングのワークフローを使えないため、実機での操作が残る",
    },
    {
      kind: "manual-subpc",
      automation: "proxy",
      title: `[手作業] サブPC: ${spec.repositoryName}のシークレットを投入する`,
      target: "guchi-apps/issue-deck",
      description: "1Passwordへの値の投入とGitHub secretへの同期。cloneはローカルセッションを使うとき用。手作業アシスタントの代行実行で流せる",
    },
  ];

  // ブラウザの手作業は、残る手順があるときだけ作る（#2246）。DNSのAレコードは
  // `*.gucchii.com`のワイルドカードで済み（`guchi-apps/vps#131`）、Actions secretsは
  // organizationに`visibility=all`で登録済み（#2255）。`aide-bot`の立ち上げでは、
  // 中身が全部空振りのIssueが人の着手を待ち続けた（#2215）
  if (githubAppNeedsRepositoryAdd) {
    artifacts.push({
      kind: "manual-browser",
      automation: "manual",
      title: buildBrowserManualIssueTitle(spec),
      target: "guchi-apps/issue-deck",
      description:
        "GitHub Appのインストール対象が`selected`のため、新しいリポジトリを手で追加する必要がある",
    });
  }

  return artifacts;
}

export type SpecTableOptions = {
  /**
   * 体裁と運用の5行（表示名・アイコン・PWA・更新履歴・撮影バイパス）を含めるか（#2254）。
   * **既定は含める。** ApacheのVirtualHostや疎通確認のIssueでは判断材料にならないので、
   * そちらだけ`false`で呼ぶ。
   */
  appearance?: boolean;
};

/** 立ち上げの決めごとを、どのIssueにも同じ形で載せるための表。 */
export function specTable(spec: NewAppSpec, options: SpecTableOptions = {}): string {
  const profile = newAppKindProfile(spec.kind);
  const rows: [string, string][] = [
    ["アプリ名", spec.displayName],
    ["リポジトリ", `\`${repositoryFullName(spec)}\`（${spec.visibility}）`],
    ["種別", `${profile.label}（\`runtime-setup: ${profile.runtimeSetup}\`）`],
    ["公開URL", publicUrlFor(spec)],
    ["本番ポート", spec.port === null ? "なし（常駐プロセスを持たない）" : `\`${spec.port}\``],
    ["プロセス管理", profile.processManager],
    ["データベース", spec.databaseName ? `\`${spec.databaseName}\`（MariaDB）` : "使わない"],
    ["認証", NEW_APP_AUTH_LABELS[spec.auth]],
    ["マルチエージェント運用", spec.multiAgent ? "対応させる" : "対応させない"],
  ];

  if (options.appearance !== false) {
    rows.push(
      ["表示名", `${appTitleFor(spec)}（\`title\` / \`applicationName\` / \`appleWebApp.title\`）`],
      [
        "アイコン・テーマカラー",
        spec.pwa
          ? `${spec.iconPlan === "provisional" ? "暫定で始める" : "用意してから始める"}（\`${spec.themeColor}\`）`
          : "用意しない（PWA対応しないため）",
      ],
      [
        "PWA",
        spec.pwa
          ? `対応する（オフラインは${offlineEnabled(spec) ? "対応する" : "対応しない"}）`
          : "対応しない",
      ],
      ["更新履歴", spec.changelog ? "持つ" : "持たない（バージョンだけが上がる）"],
      [
        "CI撮影の認証バイパス",
        spec.auth === "none"
          ? "不要（認証なし）"
          : screenshotBypassEnabled(spec)
            ? supportsUnattendedScreenshot(spec.kind)
              ? "用意する"
              : "用意する（`runtime-setup: minimal` のため無人撮影は成立せず、ローカル実行専用）"
            : "用意しない（`24.screenshot-required`は使えない）",
      ],
    );
  }

  return [
    "| 項目 | 値 |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
  ].join("\n");
}

/** どのIssueにも入れる、この立ち上げの出どころ。 */
function origin(parentRef: string): string {
  return `${parentRef} の新規アプリ立ち上げから、issue-deckの画面が自動で起票しました。`;
}

export type NewAppIssueRefs = {
  /** 親Issue（`guchi-apps/issue-deck#123`の形） */
  parent: string;
  /** `guchi-apps/vps`のIssue。まだ作っていなければ`null` */
  vps: string | null;
  /** サブPCの手作業Issue。まだ作っていなければ`null` */
  subpc: string | null;
  /** VPSの手作業Issue。まだ作っていなければ`null` */
  vpsManual?: string | null;
  /** 新しいリポジトリの初期化Issue。まだ作っていなければ`null` */
  init?: string | null;
  /** 払い出したローカルセッションのポート帯。決められなかったときだけ`null` */
  localPortBase: number | null;
  /** ポート帯を足すPull Request（`guchi-apps/issue-deck#124`の形）。作れなかったら`null` */
  portBandPullRequest: string | null;
  /**
   * GitHub Appのインストール対象へ手で追加する手順が要るか（#2248）。
   * `lib/new-app/installation-scope.ts`が実物の`repository_selection`から決める。
   * 既定は不要（`repository_selection=all`）。
   */
  githubAppNeedsRepositoryAdd?: boolean;
};

export function buildParentIssueTitle(spec: NewAppSpec): string {
  return `${spec.displayName}（${spec.repositoryName}）の立ち上げ`;
}

/**
 * 親Issueの本文。**この1本を開けば、立ち上げの決めごとと残りの作業が分かる**ようにする。
 *
 * 「完了条件」を持つのはここ。**判定は公開URLの`curl`で行う**（#2252）。`deploy.yml`の
 * ヘルスチェックはVPS内の`http://127.0.0.1:<port>/`宛で、ApacheのVirtualHostが無くても
 * 成功するため、deployジョブの成功では公開できたことを確かめられない。
 *
 * 完了条件には「一覧への登録」も畳んである。`_docs/guides/new-app-checklist.md`の最終項目は
 * 3か所への追記を求めており、vps READMEは`guchi-apps/vps`のIssueが扱うが、issue-deck自身の
 * `docs/supported-repositories.md`と共有知識の`standards/tech-stack.md`はどのサブIssueにも
 * 属さない。
 *
 * **暫定で始めた体裁は「後で決めること」として残す**（#2254）。完了条件には入れない——
 * 暫定のアイコンでも公開はできるので、これを条件にすると立ち上げが閉じられなくなる。
 */
export function buildParentIssueBody(
  spec: NewAppSpec,
  options: NewAppPlanOptions = {},
): string {
  const repo = repositoryFullName(spec);
  const localPortBase = options.localPortBase ?? null;
  const portBandLine =
    localPortBase === null
      ? `\`${LOCAL_PORT_BAND_CONF_PATH}\` への追記`
      : `\`${formatLocalPortBandLine(repositoryFullName(spec), localPortBase).replace(/\s+/g, " ")}\` の追記`;
  // 実施順。**空振りの段を並べない**（#2246）——`aide-bot`の立ち上げでは、中身が不要だった
  // ブラウザの登録が2番目に居座り、後続がそれを待つ形に見えていた
  const steps = [
    `ローカルセッションのポート帯を確保する（${portBandLine}。立ち上げが自動でPull Requestを作ります）`,
    ...(options.githubAppNeedsRepositoryAdd
      ? [`ブラウザでissue-deckのGitHub Appのインストール対象へ \`${repo}\` を追加する`]
      : []),
    "サブPCで1Passwordへ値を投入する（初回デプロイまでに済んでいればよく、初期化Issueは待ちません）",
    `\`${repo}\` の初期化と、developへのマージ（**盤面から無人実行で始められます**。\n   リポジトリの作成時に \`claude-issue-dispatch.yml\` までコミット済みのため、cloneは要りません）`,
    `\`${NEW_APP_VPS_REPOSITORY}\` のVirtualHostを develop → main まで進めて実機へ反映`,
    vpsProvisionable(spec)
      ? `サブPCから \`${NEW_APP_VPS_REPOSITORY}\` のプロビジョニングを流し（置き場・DB・vhostの有効化・PM2・TLS）、初回デプロイ`
      : "VPSで置き場とTLSを用意して初回デプロイ",
    `初回デプロイ前チェックを行い、公開URLが開けることを確かめる（\`${repo}\` の「初回デプロイ前チェックと公開確認」Issue）`,
  ];
  // **暫定で始めたものだけを書く**（#2254）。`aide-bot`ではテーマカラー`#0f766e`が誰にも
  // 決められないまま入り、暫定だったことがどこにも残らなかった。
  const pending: string[] = [];
  if (spec.pwa && spec.iconPlan === "provisional") {
    pending.push(
      `- [ ] アイコンとテーマカラー（暫定で \`${spec.themeColor}\` の1色で始めています）を決めて差し替える`,
    );
  }
  const pendingSection =
    pending.length === 0
      ? ""
      : `## 後で決めること

暫定のまま始めたものです。**立ち上げの完了条件には含めません**が、放っておくと誰も決めないまま
本番に残ります。

${pending.join("\n")}

`;
  return `## 立ち上げるアプリ

${specTable(spec)}

${spec.summary.trim() ? `${spec.summary.trim()}\n` : ""}
## 進め方

サブIssueが実施順に並んでいます。実機へ出るまでの流れは次のとおりです。

${steps.map((line, index) => `${index + 1}. ${line}`).join("\n")}

**DNSのAレコードとActions secretsの登録は要りません**（#2246）。\`*.gucchii.com\` はワイルドカードで
登録済みで（\`guchi-apps/vps#131\`）、共通のsecretはorganizationに \`visibility=all\` で入っています（#2255）。
**VPSへSSHする手順もありません**——実機の操作は ${NEW_APP_VPS_REPOSITORY} の「アプリをプロビジョニングする」
ワークフローが行います（\`guchi-apps/vps#132\`）。

**ポート帯のPull Requestは、developへマージしただけでは効きません。**
\`${LOCAL_PORT_BAND_CONF_PATH}\` はサブPCの本体チェックアウトから読まれるため、
issue-deckの画面のホスト一覧で「更新して再起動」を押すまで反映されません
（[docs/multi-agent/generic-launcher.md](https://github.com/${NEW_APP_PARENT_REPOSITORY}/blob/develop/docs/multi-agent/generic-launcher.md)）。

## 完了条件

**この立ち上げが終わったと言えるのは、公開URLが実際に開けたときです**（#2252）。

- [ ] \`curl -I ${publicUrlFor(spec)}\` が 200 か 3xx を返す
- [ ] \`${repo}\` の「初回デプロイ前チェックと公開確認」Issueが閉じている
- [ ] \`${NEW_APP_VPS_REPOSITORY}\` のREADMEのアプリ一覧へ追記した
- [ ] issue-deckの \`docs/supported-repositories.md\` へ追記した${spec.multiAgent ? "" : "（マルチエージェント運用に対応させないため、対象外なら不要）"}
- [ ] 共有知識（\`guchi-apps/docs\`）の \`standards/tech-stack.md\` のスタック一覧へ追記した

**\`deploy.yml\` の deploy ジョブが成功しても、公開できたことにはなりません。**
ヘルスチェックが叩くのはVPS内の \`http://127.0.0.1:<ポート>/\` で、ApacheのVirtualHostが
無くても成功します（\`aide-bot\` では公開できていないことに気づくのが \`${NEW_APP_VPS_REPOSITORY}#128\` の
調査まで遅れました）。上の \`curl\` だけが、DNS・Apache・TLS・アプリのすべてを通した確認になります。

${pendingSection}## 参考

- 新規アプリ作成チェックリスト: \`guchi-apps/docs\` の \`guides/new-app-checklist.md\`
- マルチエージェント運用の導入手順: issue-deckの \`docs/cross-repo-setup-guide.md\`
`;
}

/**
 * 初期化Issueの「やること」に入る、体裁と運用の項目（#2254）。
 *
 * **決めた結果「やらない」ことは項目にしない。** 決めた事実は決めごとの表に残るので、
 * ここに「PWA対応はしない」のような空振りのチェックを並べると、消し込む相手が無い項目が増える。
 */
type AppearanceStepsOptions = {
  /**
   * 雛形（#2247）がPWA・changelogの受け皿（`src/app/manifest.ts`・`public/icon.svg`・
   * `src/lib/changelog.ts`）をすでにコミット済みなら`true`。**置く指示は出さない**——
   * 値を決めて差し替える指示（`buildInitIssueBody`の`pwaTasks`）に譲る。
   */
  pwaAndChangelogScaffolded?: boolean;
};

function appearanceSteps(
  spec: NewAppSpec,
  refs: NewAppIssueRefs,
  options: AppearanceStepsOptions = {},
): string {
  const profile = newAppKindProfile(spec.kind);
  const steps: string[] = [
    `- [ ] 表示名を \`${appTitleFor(spec)}\` にする（\`title\` / \`applicationName\` / \`appleWebApp.title\`）`,
  ];

  if (spec.pwa && !options.pwaAndChangelogScaffolded) {
    steps.push(
      `- [ ] PWA対応の一式を置く（\`manifest\`・アイコン・テーマカラー \`${spec.themeColor}\`）。${
        offlineEnabled(spec)
          ? "**オフライン対応も行う**（Service Workerでのキャッシュ）"
          : "**オフライン対応（Service Worker）は入れない**"
      }`,
    );
    steps.push(
      spec.iconPlan === "provisional"
        ? `- [ ] アイコンは暫定（テーマカラー1色）で置いて始める。差し替えは ${refs.parent} の「後で決めること」で追う`
        : "- [ ] 用意されたアイコンを置く（`icon-192.png`・`icon-512.png`・`apple-icon.png`・`favicon.ico`）",
    );
  }

  if (spec.changelog && !options.pwaAndChangelogScaffolded) {
    steps.push(
      spec.kind === "fastapi"
        ? "- [ ] 更新履歴（changelog）を持たせる（`version.json` + `frontend/changelog.js` + `scripts/bump_version.py`。callerの`bump-command`から呼ぶ）"
        : `- [ ] 更新履歴（changelog）を持たせる。\`"version"\` lifecycleスクリプトで \`RELEASE_CHANGELOG\`・\`RELEASE_USAGE\` を受け取る（受け取り方はissue-deckの \`docs/cross-repo-setup-guide.md\`）。**\`preversion\` は作らず、スクリプトはNode標準モジュールだけで書く**——共有ワークフローはbumpのために依存をインストールしない`,
    );
  }

  if (screenshotBypassEnabled(spec)) {
    // `runtime-setup: minimal`ではPlaywrightが入らないため、無人実行では撮れない。
    // バイパス自体はローカルの画面確認に効くので、用途を断って書く
    const unattended = supportsUnattendedScreenshot(spec.kind)
      ? `**これが無いと \`24.screenshot-required\` が成立しない**`
      : `\`runtime-setup: ${profile.runtimeSetup}\` ではPlaywrightが入らないため、**\`24.screenshot-required\` は無人実行では成立しない**。ローカル実行での画面確認用として作り、その旨を \`CLAUDE.md\` に書く`;
    steps.push(
      `- [ ] CI撮影の認証バイパスを用意する（開発用ログインのエンドポイントと、ダミーデータを入れる \`${profile.packageManager === "pnpm" ? "pnpm" : "npm run"} db:seed:dev\` 相当）。${unattended}（参照実装はissue-deckの \`/api/dev/login\`）`,
    );
  }

  return steps.join("\n");
}

export function buildInitIssueTitle(spec: NewAppSpec): string {
  return `${spec.displayName}のプロジェクトを初期化する`;
}

/** 初期化Issueの本文に添える、雛形として置かれたファイルの状況（#2247）。 */
export type ScaffoldOutcome = {
  /** 実際にコミットしたパス（`.github/workflows/ci.yml`など）。空なら置けなかった */
  paths: string[];
  /** callerが参照している共有ワークフローのタグ。決められなかったら`null` */
  workflowTag: string | null;
};

/**
 * 新しいリポジトリに立てる初期化Issue。
 *
 * **雛形がコミットされていれば、このIssueは無人実行で回せる**（#2247）。以前は
 * `claude-issue-dispatch.yml`を作るのがこのIssue自身だったため盤面に載らず、実行経路を
 * サブPCのローカルセッションに固定し、cloneの手作業Issueを`## 前提条件`に置いていた。
 *
 * **雛形を置けなかった場合は、その旨と従来の手順を書く。** 置けたことにして書くと、
 * 無人実行が始まらないまま`Ready`で止まっていることに誰も気づけない。
 */
export function buildInitIssueBody(
  spec: NewAppSpec,
  refs: NewAppIssueRefs,
  scaffold: ScaffoldOutcome | null = null,
): string {
  const profile = newAppKindProfile(spec.kind);
  const repo = repositoryFullName(spec);
  const isNext = spec.kind === "next" || spec.kind === "next-db";
  const scaffolded = scaffold !== null && scaffold.paths.length > 0;
  const has = (path: string) => scaffolded && scaffold.paths.includes(path);
  // **無人実行で回せるかどうかは、雛形が置けたかではなくcallerが置けたかで決まる。**
  // 参照タグを読めなかった回はcallerだけが欠け、他のファイルは置かれている
  const dispatchReady = has(".github/workflows/claude-issue-dispatch.yml");

  const prerequisites = dispatchReady
    ? `- 先に完了している必要があるIssue・PR: なし

**このIssueはissue-deckの盤面から無人実行で実装できます。** リポジトリの作成時に
\`.github/workflows/claude-issue-dispatch.yml\` までコミット済みで（下記「すでに置かれているもの」）、
盤面へ載る条件を満たしています。サブPCのローカルセッションで実装しても構いません。`
    : `- 先に完了している必要があるIssue・PR: ${[refs.subpc ?? "（サブPCの手作業Issue）", refs.portBandPullRequest ?? "（ローカルセッションのポート帯を足すPull Request）"].join("・")}

**${
        !spec.multiAgent
          ? "マルチエージェント運用に対応させない選択のため"
          : scaffolded
            ? "無人実行のcaller（`claude-issue-dispatch.yml`）を置けなかったため"
            : "雛形のコミットに失敗したため"
      }、このIssueはサブPCのローカルセッションで実装します。**
\`claude-issue-dispatch.yml\` が無いあいだは無人実行では動かず、issue-deckの盤面にも載りません。
ローカルセッションを起こせる条件は \`~/.config/issue-deck/local-repos.conf\` への記載で、
それを行うのが上の手作業Issueです。`;

  const alreadyThere = scaffolded
    ? `
## すでに置かれているもの

リポジトリの作成時に、issue-deckが次のファイルをコミットしています（#2247）。
**同じものを作り直さないでください。** 内容が現行の標準からずれていた場合は、
このリポジトリで直したうえでissue-deckの \`src/lib/new-app/scaffold.ts\` にも反映します。

${scaffold.paths.map((path) => `- \`${path}\``).join("\n")}

${scaffold.workflowTag ? `共有ワークフローの参照タグは \`${scaffold.workflowTag}\`（\`uses:\` と \`prompts-ref\` は同じ値）。\n` : ""}**アプリの雛形（\`create-next-app\` など）は空のディレクトリを前提にするものが多く、
このリポジトリの上では実行できません。** 一時ディレクトリで作ってから、必要なファイルだけを
取り込んでください。
`
    : "";

  const dbTasks = profile.usesDatabase
    ? `\n- [ ] \`prisma/schema.prisma\` と初期マイグレーションを作る${has("prisma.config.ts") ? "（\`prisma.config.ts\` は雛形にあり、\`loadEnv\` の \`quiet: true\` を落とさないこと）" : ""}\n- [ ] \`db:migrate:deploy\` と \`db:seed:ci\` のnpm scriptsを用意する（共有ワークフローがこの名前で呼ぶ。違う名前だと無言でスキップされる）`
    : "";

  // **`typecheck`の中身をここで固定する**（#2378）。Next.js 16の`PageProps`/`LayoutProps`/
  // `RouteContext`は`.next/types`へ生成されるグローバル型で、`tsc --noEmit`だけでは
  // `Cannot find name 'LayoutProps'`になる。`next build`は内部で型生成するため、
  // **ビルドは通るのに`typecheck`だけが落ちる**という分かりにくい形になる
  const typecheckScript = isNext
    ? `

  \`\`\`json
  "lint": "eslint",
  "typecheck": "next typegen && tsc --noEmit",
  "build:ci": "${profile.usesDatabase ? "prisma generate && " : ""}next build"
  \`\`\`

  **\`typecheck\` から \`next typegen\` を外さないこと。** Next.js 16の \`PageProps\`・\`LayoutProps\`・
  \`RouteContext\` は \`.next/types\` へ生成されるグローバル型で、生成前は
  \`Cannot find name 'LayoutProps'\` になる。\`next build\` は内部で型生成するため、
  **ビルドは通るのに \`typecheck\` だけが落ちる**という分かりにくい形になる。`
    : "";

  // **`packageManager`を書かないと、雛形が置いた設定が無言で効かない**（#2378）。
  // `ci.yml`・`deploy.yml`の`pnpm/action-setup@v4`は`version:`を持たず、VPSの
  // `corepack enable pnpm`も、どちらも`package.json`の`packageManager`を見てpnpmの版を決める。
  // 版が変わると`pnpm-workspace.yaml`の設定キーの解釈も変わりうる
  const packageManagerTask = isNext
    ? `
- [ ] \`package.json\` に \`"packageManager"\` を書いてpnpmの版を固定する（\`corepack use pnpm@latest\` が
      ハッシュ付きで書き込む）。**書かないと \`ci.yml\`・\`deploy.yml\`・VPSの \`corepack enable pnpm\` が
      それぞれ別の版を拾い、\`pnpm-workspace.yaml\` の設定が無言で効かないことがある**`
    : "";

  // **ビルドスクリプトの承認は雛形（`pnpm-workspace.yaml`）で済んでいる**（#2378）。
  // ここに書くのは「作り直さない」「依存を足したら承認し直す」の2点だけ
  const buildApprovalTask = has("pnpm-workspace.yaml")
    ? `
- [ ] 依存を入れたら \`pnpm approve-builds\` を実行し、\`pnpm-workspace.yaml\` の差分をコミットする。
      雛形が${[...(profile.usesDatabase ? ["prisma", "@prisma/client", "@prisma/engines"] : []), "sharp", "unrs-resolver"].map((name) => `\`${name}\``).join("・")}を承認済みにしてあるので、**このファイルを作り直さない**。
      pnpm 10系は未承認のビルドスクリプトを**警告だけ出して終了コード0で素通りする**ため、
      承認漏れは\`${profile.packageManager} install\`の成功では気づけない`
    : "";

  const ciTasks = has(".github/workflows/ci.yml")
    ? `\n- [ ] \`.github/workflows/ci.yml\` が呼ぶ \`lint\`・\`typecheck\`・\`build:ci\` のnpm scriptsを用意する${typecheckScript}`
    : `\n- [ ] \`.github/workflows/ci.yml\` を作る（必須）
- [ ] \`.github/workflows/deploy.yml\` を作る（\`main\` へのpushでVPSへ配る。配布先は \`${serverAppDir(spec)}/\`）`;

  const secretTasks = has(".github/secrets-manifest.tsv")
    ? ""
    : `\n- [ ] \`.github/secrets-manifest.tsv\` を作る（\`op://apps/${spec.repositoryName}/…\` を読む行。これが無いとGitHubのsecretへ同期できない）
- [ ] 1Passwordの値をGitHubのsecretへ同期する（マニフェストをpushした後、そのブランチを指定して実行する）

  \`\`\`bash
  ${provisionCommand(spec, null)} \\
    --ref <このIssueのブランチ>
  \`\`\`
`;

  const pwaAndChangelogScaffolded = isNext && has("src/app/manifest.ts");

  const pwaTasks = pwaAndChangelogScaffolded
    ? `
- [ ] \`src/app/layout.tsx\` に \`metadata\`（\`title\`・\`applicationName\`・\`appleWebApp\`・\`icons\`）と \`viewport.themeColor\` を書く

  \`\`\`ts
  export const metadata: Metadata = {
    title: "${spec.displayName}",
    description: "${(spec.summary.trim() || spec.displayName).replace(/"/g, '\\"')}",
    applicationName: "${spec.displayName}",
    appleWebApp: { capable: true, title: "${spec.displayName}", statusBarStyle: "default" },
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  };
  export const viewport: Viewport = { themeColor: "#0f766e", viewportFit: "cover" };
  \`\`\`

- [ ] アイコン（\`public/icon-192.png\`・\`icon-512.png\`・\`apple-icon.png\`）とテーマカラーを決めて差し替える。
      雛形の \`public/icon.svg\` と \`#0f766e\` は暫定値（${NEW_APP_PARENT_REPOSITORY}#2254）
- [ ] \`package.json\` の scripts へ \`"version": "node scripts/version-changelog.mjs"\` を足す（更新履歴の受け皿は \`src/lib/changelog.ts\`）`
    : "";

  const appearance = `\n${appearanceSteps(spec, refs, { pwaAndChangelogScaffolded })}`;

  const multiAgent =
    spec.multiAgent && !dispatchReady
      ? `
## マルチエージェント運用の導入

手順の正はissue-deckの \`docs/cross-repo-setup-guide.md\` です。ここに複製しません。

- [ ] \`.github/workflows/issue-labels.yml\`（\`reusable-issue-labels.yml\` のcaller）を置く
- [ ] \`.github/workflows/claude-issue-dispatch.yml\` を置く。\`runtime-setup: ${profile.runtimeSetup}\`・\`package-manager: ${profile.packageManager}\`・\`prompts-ref\` は \`uses:\` と同じタグ
- [ ] \`CLAUDE.md\` に運用ルールを書く（GitHub Actions上の無人実行はグローバル設定を読まない）
- [ ] \`.gitignore\` に \`.shared-context/\` を足す
- [ ] \`develop\` にもBranch protection（CI必須）を設定する
`
      : spec.multiAgent
        ? `
## マルチエージェント運用

callerは雛形として置かれています。残りは保護設定と、まだ配られていないcallerだけです。

- [ ] \`develop\` にBranch protection（CI必須）を設定する
- [ ] 自動修復系のcaller（\`claude-ci-fix.yml\`・\`claude-conflict-resolve.yml\`・\`claude-pr-repair.yml\`・\`claude-review-develop.yml\`・\`deploy-retry.yml\`）を、issue-deckの画面（設定＞フリート運用）から配る
`
        : "";

  return `${origin(refs.parent)}

## このIssueで作るもの

${specTable(spec)}

${spec.summary.trim() ? `${spec.summary.trim()}\n` : ""}
## 前提条件

${prerequisites}
${alreadyThere}
## やること

- [ ] アプリの雛形を作る（${profile.label}）
- [ ] バージョン管理を \`package.json\` の \`version\` に載せる${packageManagerTask}${buildApprovalTask}
- [ ] \`.env.local.example\`（ローカル開発の記入例）を作る${has(".env.example") ? "" : "。あわせて \`.env.example\`（変数名のみ）も作る"}${ciTasks}${secretTasks}${has(".github/scripts/signaly-notify.sh") ? "" : "\n- [ ] \`.github/scripts/signaly-notify.sh\` を置く（CI・デプロイ通知の \`SIGNALY_WEBHOOK_URL\` はorganization secretから来るため、Signalyのチャンネル作成も \`op://\` 参照の追加も要らない）"}
- [ ] \`main\` のBranch protectionを設定する${has("deploy/ecosystem.config.js") || spec.port === null ? "" : `\n- [ ] \`deploy/ecosystem.config.js\` を作る（ポート \`${spec.port}\`）`}${dbTasks}${pwaTasks}${appearance}
${multiAgent}
## 参考

- 新規アプリ作成チェックリスト: \`guchi-apps/docs\` の \`guides/new-app-checklist.md\`
- ディレクトリ構成・ポート・DB名の規約: 同リポジトリの \`standards/\`
- 立ち上げ全体: ${refs.parent}
- リポジトリ: \`${repo}\`
`;
}

export function buildDeployCheckIssueTitle(spec: NewAppSpec): string {
  return `${spec.displayName}の初回デプロイ前チェックと公開確認`;
}

/**
 * 新しいリポジトリに立てる、初回デプロイ前チェックと公開確認のIssue（#2252）。
 *
 * **`deploy.yml`のdeployジョブの成功は、公開できたことを保証しない。** ヘルスチェックが叩くのは
 * VPS内の`http://127.0.0.1:<port>/`で、ApacheのVirtualHostが無くても成功する。`aide-bot`では
 * そのせいで公開できていないことに気づくのが`guchi-apps/vps#128`の調査まで遅れた。
 *
 * **初期化Issueへ畳まず、独立したIssueにする。** 初期化Issueは`develop`へのマージで`Done`に
 * なるが、初回デプロイは`develop`→`main`のリリースPRをマージした後なので、そこまで開いたまま
 * 追えるものが誰も残らない。
 *
 * **サブPCのローカルセッションで実装する。** 実地確認の手順は個人スキル
 * （`initial-deploy-check`）にあり、GitHub Actions上の無人実行からは読めない。1Passwordや
 * VPSへのSSHも同じ理由でローカルからしか確かめられない。
 */
export function buildDeployCheckIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const repo = repositoryFullName(spec);
  const host = hostnameFor(spec);
  const url = publicUrlFor(spec);
  const vpsRef = refs.vps ?? `${NEW_APP_VPS_REPOSITORY}のVirtualHostのIssue`;
  const vpsManualRef = refs.vpsManual ?? `${refs.parent} のVPS手作業Issue`;
  const initRef = refs.init ?? "このリポジトリの初期化Issue";
  const dbCheck = spec.databaseName
    ? `\n- [ ] VPSに \`${spec.databaseName}\` のデータベースがあり、\`DATABASE_URL\` で接続できる`
    : "";
  const processCheck =
    spec.port === null
      ? ""
      : `\n- [ ] PM2に \`${spec.repositoryName}\` が登録され、\`pm2 save\` まで済んでいる`;

  return `${origin(refs.parent)}

## このIssueで確かめること

**\`deploy.yml\` の deploy ジョブが成功しても、公開できたことにはなりません**（#2252）。
ヘルスチェックが叩くのはVPS内の \`http://127.0.0.1:${spec.port ?? "<ポート>"}/\` で、ApacheのVirtualHostが
無くてもジョブは成功します。\`aide-bot\` では、そのせいで公開できていないことに気づくのが
\`${NEW_APP_VPS_REPOSITORY}#128\` の調査まで遅れました。

このIssueは、初回デプロイの前に周辺インフラが**実際に疎通する**ことを確かめ、デプロイの後に
**${url} が開けること**まで見届けるためのものです。

${specTable(spec, { appearance: false })}

## 前提条件

- 実行するデバイス: サブPC（ローカルセッション）
- 先に完了している必要があるIssue・PR: ${[initRef, vpsRef, vpsManualRef].join("・")}
- その他の前提: \`op\`・\`gh\` がサブPCでログイン済みで、VPSへSSHできること

**このIssueはサブPCのローカルセッションで実装します。** 実地確認の手順は個人スキル
\`initial-deploy-check\` にあり、GitHub Actions上の無人実行からは読めません。1Password・VPSへの
SSHも同じ理由で、無人実行からは確かめられません。

## やること（初回デプロイの前）

\`initial-deploy-check\` スキルに沿って、設定が「ファイルとして存在する」ではなく
「実際に疎通する」ことを確かめます。

- [ ] 1Passwordの \`apps\` ボールトの \`${spec.repositoryName}\` に実値が入っている（\`op run --env-file=.github/deploy.env.tpl -- env\` が解決できる。**値そのものは出力・記録しない**）
- [ ] \`gh secret list --repo ${repo}\` に必要なsecretが並ぶ
- [ ] \`ci.yml\` が1回以上成功し、\`main\` のBranch protectionが設定済み
- [ ] \`dig +short ${host} A\` がVPSのIPを返す
- [ ] VPSに \`/apps/${spec.repositoryName}/\` があり、\`${host}\` のVirtualHostが実機へ反映済み${dbCheck}${processCheck}

## やること（初回デプロイ）

- [ ] \`develop\` → \`main\` のリリースPRを、**\`release-develop-to-main.yml\` から作る**
      （issue-deckの画面のリリースボタン、または \`gh workflow run release-develop-to-main.yml --repo ${repo} -f bump_kind=auto\`）
- [ ] **人がマージする**（\`develop\` → \`main\` は自動マージ不可カテゴリ）
- [ ] \`deploy.yml\` の成功と、Signalyへのデプロイ結果の通知を確認する

**2回目以降も同じ経路を使ってください。** \`deploy.yml\` の tag ジョブは \`package.json\` の
\`version\` から \`v<version>\` のタグを作るため、**この初回デプロイの時点で最初のタグが
切られます**（\`create-next-app\` の既定のままなら \`v0.1.0\`）。
バージョンを上げずに次の \`develop\` → \`main\` を出すと、\`Tag v0.1.0 already exists\` で
デプロイが止まります。\`release-develop-to-main.yml\` はバージョンbump用のPRを先に作るので、
この経路を通っているかぎり詰まりません。雛形の \`version-tag-check.yml\` が
main宛PRのCIで先に落としますが、**落ちてから直すより、最初からこの経路を使うほうが早い**
（${NEW_APP_PARENT_REPOSITORY}#2378）。

## 完了の確認方法

\`\`\`bash
curl -I ${url}
\`\`\`

**200 か 3xx が返ればここまで届いています。これが立ち上げの完了条件です**（${refs.parent}）。
返らないときの切り分けは次のとおりです。

| 症状 | 見るところ |
|---|---|
| 名前を解決できない | \`*.gucchii.com\` のワイルドカードで引けるはず（\`guchi-apps/vps#131\`）。引けなければDNSの障害 |
| 404が返る・別のアプリが出る | ApacheのVirtualHost（${vpsRef} が \`main\` まで進んで実機へ反映されているか） |
| 502・503が返る | アプリのプロセス（${vpsManualRef} のプロビジョニングを初回デプロイの後にもう一度流す） |
| TLSのエラーになる | certbot（${vpsManualRef} のプロビジョニング） |

## 関連

- 立ち上げ全体: ${refs.parent}
- 初期化: ${initRef}
- VirtualHost: ${vpsRef}
`;
}

export function buildVpsIssueTitle(spec: NewAppSpec): string {
  const host = hostnameFor(spec);
  return spec.urlMode === "subdomain"
    ? `${host} のVirtualHostを追加し、アプリ一覧に載せる`
    : `${host} のVirtualHostへ /${spec.basePath} を追加し、アプリ一覧に載せる`;
}

/**
 * `guchi-apps/vps`へ立てるIssue。
 *
 * **2段構えで書く。** 1段目（\`:80\` のvhostとREADMEの追記）はすぐ着手できるが、
 * 2段目（certbotが実機に作る \`-le-ssl.conf\` の取り込み）はcertbotを実行した後にしかできない。
 * ここを書き落とすと、毎日のドリフト検知（\`.github/scripts/check-drift.sh\` が実機の
 * \`/etc/apache2/sites-available/*.conf\` を正として列挙する）に
 * 「[新規（未取り込み）]」として残り続ける。
 */
export function buildVpsIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const host = hostnameFor(spec);
  const proxy =
    spec.port === null
      ? `    DocumentRoot /var/www/html/${host}`
      : spec.urlMode === "subdomain"
        ? `    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${spec.port}/
    ProxyPassReverse / http://127.0.0.1:${spec.port}/`
        : `    ProxyPass /${spec.basePath} http://127.0.0.1:${spec.port}/${spec.basePath}
    ProxyPassReverse /${spec.basePath} http://127.0.0.1:${spec.port}/${spec.basePath}`;

  const vhost =
    spec.urlMode === "subdomain"
      ? `新規に \`apache/sites-available/${host}.conf\` を作ります。

\`\`\`apache
<VirtualHost *:80>
    ServerName ${host}
${proxy}
    ErrorLog \${APACHE_LOG_DIR}/${host}-error.log
    CustomLog \${APACHE_LOG_DIR}/${host}-access.log combined
</VirtualHost>
\`\`\`

**HTTPS（443）の \`${host}-le-ssl.conf\` はここでは作りません。** certbotが実機に作ったものを
後から取り込みます（下記2段目）。`
      : `既存の \`${host}\` のVirtualHostへ、次のプロキシ設定を追加します。

\`\`\`apache
${proxy}
\`\`\`

**プレフィックスを保持したまま転送しています。** アプリ側が \`basePath\` を認識できることが前提です。
静的アプリなど \`basePath\` 相当を持たない場合は \`ProxyPass /${spec.basePath}/ http://127.0.0.1:${spec.port}/\`
（末尾スラッシュ込みで剥がす形）にして、アプリ側は相対パスだけでURLを組み立ててください。`;

  return `${origin(refs.parent)}

## 立ち上げるアプリ

${specTable(spec, { appearance: false })}

## やること（1段目・すぐ着手できる）

- [ ] VirtualHostを追加する

${vhost}

- [ ] READMEのアプリ一覧へ次の行を足す

\`\`\`
| ${spec.repositoryName} | ${spec.summary.trim() || spec.displayName} | ${vpsAppListLocation(spec)} | ${newAppKindProfile(spec.kind).processManager} | [${repositoryFullName(spec)}](https://github.com/${repositoryFullName(spec)}) の \`deploy/ecosystem.config.js\` |
\`\`\`

## やること（2段目・certbotの後）

TLS証明書を取ると、certbotが実機に \`/etc/apache2/sites-available/${host}-le-ssl.conf\` を作ります。
**これをこのリポジトリへ取り込むまで、毎日のドリフト検知に「[新規（未取り込み）]」として残り続けます。**

- [ ] certbot実行後、${refs.parent} のVPS手作業Issueへ貼られた \`${host}-le-ssl.conf\` の内容を \`apache/sites-available/\` へ追加する

**\`:443\` 側の \`RequestHeader set X-Forwarded-Proto\` が \`"https"\` になっていることを確かめてから取り込みます。**
certbotは \`:80\` のVirtualHostをそのまま複製するため \`"http"\` が残ることがあり、アプリが自分を \`http://\` だと
誤認して**本番でだけログインが失敗します**（OAuthのリダイレクトURIが登録済みの \`https://\` と一致しなくなるため）。
\`"http"\` のまま貼られていたら、実機を直し直してから控え直してもらってください。

## このIssueが持たない作業

**同じアプリの作業でも、次はこのIssueの担当ではありません。同じ対象のIssueを新しく立てず、
下のIssueへ書いてください**（\`aide-bot\` の立ち上げでは同じ作業のIssueが4件並びました。#2250）。

| 作業 | 担当するIssue |
|---|---|
| DNSのAレコードの登録 | 不要（\`*.gucchii.com\` のワイルドカードで引ける。\`guchi-apps/vps#131\`） |
| 置き場・DB・vhostの有効化・PM2への登録・**certbotの実行** | ${refs.parent} のVPS受け入れの手作業Issue（\`scripts/provision-app.sh\` を流す） |
| \`${host}-le-ssl.conf\` の**取り込み** | このIssue（上の2段目） |

## 注意点

- 実機を直接編集しないでください。\`develop\` へマージし、さらに \`develop\` → \`main\` のリリースPRを
  マージすると \`.github/workflows/deploy.yml\` がVPSへ同期し \`scripts/apply.sh\` が反映します（マージは2回）。
- \`develop\` → \`main\` のマージは自動マージ不可カテゴリなので人が行います。

## 関連

- 起点Issue: ${refs.parent}
`;
}

/** 手作業Issueの共通の骨組み（CLAUDE.mdの雛形どおりの見出しと順序）。 */
function manualStepBody(params: {
  benefit: string;
  blocked: string;
  urgency: string;
  device: string;
  cwd: string;
  branch: string;
  prerequisiteIssues: string;
  otherPrerequisites: string;
  steps: string;
  verification: string;
  why: string;
  related: string;
}): string {
  return `## この作業でできるようになること

- できるようになること: ${params.benefit}
- 実行するまでできないこと: ${params.blocked}
- 急ぎ具合: ${params.urgency}

## 前提条件

- 実行するデバイス: ${params.device}
- カレントディレクトリ: ${params.cwd}
- Gitブランチ: ${params.branch}
- 先に完了している必要があるIssue・PR: ${params.prerequisiteIssues}
- その他の前提: ${params.otherPrerequisites}

## やること

${params.steps}

## 完了の確認方法

${params.verification}

## なぜエージェントが実施しないか

${params.why}

## 関連

${params.related}
`;
}

/**
 * サブPCの手作業Issueの「その他の前提」に足す1行。
 *
 * **ポート帯はdevelopへマージしただけでは効かない。** `local-repo-ports.conf`はサブPCの
 * 本体チェックアウト（`~/apps/issue-deck/scripts/`）から読まれるため、画面の
 * 「更新して再起動」でチェックアウトを更新するまで、汎用ランチャーの既定
 * `3000 + Issue番号` が使われ続ける（docs/multi-agent/generic-launcher.md）。
 * **これは手作業Issueにしない**——画面のボタン1つで済む操作だから（#2009）。
 */
/**
 * organizationのsecretで足りていることの確認（#2246）。
 *
 * **登録の手順は出さない。** `OP_SERVICE_ACCOUNT_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`・
 * `WORKFLOW_PAT`はorganizationに`visibility=all`で登録済みで（#2255）、リポジトリごとの
 * 登録は空振りになる。ただし**確認は残す**——`visibility`が`selected`へ変えられたときに
 * 黙って壊れるのを、定期巡回が拾えるようにするため。
 *
 * 数えるのはリポジトリのsecretとorganizationのsecretの和集合で、どちらで揃っていてもよい。
 */
function sharedSecretCheck(spec: NewAppSpec): string {
  const repo = repositoryFullName(spec);
  const names = spec.multiAgent
    ? ["CLAUDE_CODE_OAUTH_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN", "WORKFLOW_PAT"]
    : ["OP_SERVICE_ACCOUNT_TOKEN"];
  return `
- ワークフローから${names.length}件の共通secretを読める

  \`\`\`bash
  { gh secret list --repo ${repo} --json name --jq '.[].name'; gh api repos/${repo}/actions/organization-secrets --jq '.secrets[].name'; } | sort -u | grep -cE '^(${names.join("|")})$'
  \`\`\`

  **\`${names.length}\` が出れば完了です。** organizationに \`visibility=all\` で登録済みのため、
  通常は何もしなくてもこの数になります（\`aide-bot\` では、これを知らずにリポジトリごとの登録を
  手作業Issueへ書いていました）。足りなければ \`https://github.com/organizations/${NEW_APP_ORG}/settings/secrets/actions\` を確かめてください。
`;
}

/**
 * ワイルドカードのAレコードで名前が引けることの確認（#2246）。
 *
 * **登録の手順は出さない。** `*.gucchii.com`を登録済みのため（`guchi-apps/vps#131`）、
 * 新しいサブドメインは追加登録なしで引ける。`aide-bot`の立ち上げでは、この空振りの手順が
 * 手作業Issueの先頭に置かれ、後続がすべてそれを待つ形になっていた。
 */
function wildcardDnsCheck(spec: NewAppSpec): string {
  if (spec.urlMode !== "subdomain") return "";
  return `
- ホスト名が引ける

  \`\`\`bash
  dig +short ${hostnameFor(spec)} A | grep -qE '^[0-9]+\\.' && echo ok
  \`\`\`

  \`ok\` が出れば完了です。\`*.gucchii.com\` はワイルドカードで登録済みなので、
  **Aレコードの追加登録は要りません**（\`guchi-apps/vps#131\`）。
`;
}

function portBandPrerequisite(refs: NewAppIssueRefs): string {
  const pr = refs.portBandPullRequest ?? `\`${LOCAL_PORT_BAND_CONF_PATH}\` へポート帯を足すPull Request`;
  return `${pr} がdevelopへマージされ、issue-deckの画面のホスト一覧で「更新して再起動」を押してサブPCのチェックアウトを更新済みであること`;
}

export function buildSubpcManualIssueTitle(spec: NewAppSpec): string {
  return `[手作業] サブPC: ${spec.repositoryName}のローカル準備とシークレット投入を行う`;
}

/**
 * サブPCの手作業Issue。フォルダ信頼だけは人が確認し、残りは代行実行できる形で書く。
 *
 * - 実行するデバイスは `サブPC` の1つだけ
 * - 1手順にコマンドブロックはちょうど1つ
 * - フォルダ信頼の確認は対話が要るため、単独の手順にして「あなたが実行」へ分ける
 * - `<…>` のプレースホルダを含まない（値はすべて埋めて出す）
 *
 * 信頼確認以外で条件を崩すと、その手順まで「あなたが実行」として並ぶため注意する。
 */
export function buildSubpcManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const repo = repositoryFullName(spec);
  const path = `/home/guchi/apps/${spec.repositoryName}`;
  return manualStepBody({
    benefit: `1Passwordに \`${spec.repositoryName}\` の値（配置先${spec.databaseName ? "・DB名" : ""}${spec.auth === "none" ? "" : "・許可メール"}）が入り、GitHubのsecretへ同期される。あわせてサブPCでフォルダ信頼確認に止まらず、\`${spec.repositoryName}\` のローカルセッションを起こせるようになる`,
    blocked: `シークレットが未登録のままで、初回の本番デプロイが値の不足で失敗する（\`guchi-apps/aide-bot#4\`）。\`${repo}\` のIssueをローカルセッションで実装することもできない（**無人実行は雛形のcallerで動くため、こちらは止まりません**）`,
    urgency: "初回の本番デプロイまで（初期化Issueは待ちません）",
    device: "**サブPC**（メインPCからなら `ssh subpc`）",
    cwd: "`/home/guchi/apps`",
    branch: "不要",
    prerequisiteIssues: refs.githubAppNeedsRepositoryAdd
      ? `${refs.parent}（GitHub Appのインストール対象への追加が済んでいること）`
      : refs.parent,
    otherPrerequisites: `\`gh\` がサブPCでログイン済みで、\`~/.config/issue-deck/op-writer.env\` に1Passwordの書き込み用トークンがあること。${portBandPrerequisite(refs)}`,
    steps: `- [ ] （サブPC）リポジトリをcloneする

  \`\`\`bash
  gh repo clone ${repo} ${path}
  \`\`\`

- [ ] （サブPC）ローカルセッションの対応表へ追記する

  \`\`\`bash
  printf '%s\\n' '${repo} ${path}' >> "$HOME/.config/issue-deck/local-repos.conf"
  \`\`\`

- [ ] （サブPC）Claude Codeを一度開き、「Yes, I trust this folder」を選んでから \`/exit\` で抜ける

  \`\`\`bash
  cd ${path} && claude
  \`\`\`

- [ ] （サブPC）1Passwordのアイテムを作り、機械的に定まる値を投入する

  \`\`\`bash
  ${provisionCommand(spec, null)}
  \`\`\``,
    verification: `**手順ごとに1つずつ確かめます**（#2256）。上から順に流し、すべてが成功すれば完了です。

- リポジトリがcloneできている

  \`\`\`bash
  test -d ${path}/.git && echo cloned
  \`\`\`

  \`cloned\` が出れば完了です。

- ローカルセッションの対応表に載っている

  \`\`\`bash
  grep -F '${repo} ${path}' "$HOME/.config/issue-deck/local-repos.conf"
  \`\`\`

  追記した1行がそのまま出れば完了です。pollerは申告のたびに読み直すので、再起動は要りません。

- Claude Codeのフォルダ信頼確認が済んでいる

  \`\`\`bash
  bash -c 'source "$HOME/apps/issue-deck/scripts/lib/claude-trust.sh" && claude_trust_is_trusted "${path}"' && echo trusted
  \`\`\`

  \`trusted\` が出れば完了です。信頼確認そのものは自動化せず、人が対象リポジトリを確認して答えます。

- 1Passwordのアイテムに値が入っている

  \`\`\`bash
  ${provisionCommand(spec, null, { check: true })}
  \`\`\`

  「すべて値が入っています」が出れば完了です。**未登録が1つでもあれば終了コード1で終わります**（\`aide-bot\` では投入が未実施のままIssueがcloseされ、初回デプロイが \`DB_NAME is required\` で落ちました）。
${sharedSecretCheck(spec)}${wildcardDnsCheck(spec)}
**GitHubのsecretへの同期もこの時点で終わります**——同期に要る \`.github/secrets-manifest.tsv\` は
リポジトリの作成時に雛形としてコミット済みだからです（#2247）。`,
    why: "サブPCのファイルシステムと個人設定（`~/.config/issue-deck/local-repos.conf`）への書き込みで、GitHubからは行えないためです。フォルダ信頼は対象を人が確認して答える必要があるため自動化せず、その手順だけサブPCの端末で実行します。ほかの手順と`## 完了の確認方法`のコマンドは、手作業アシスタントの代行実行で流せます。",
    related: `- 起点Issue: ${refs.parent}`,
  });
}

export function buildVpsManualIssueTitle(spec: NewAppSpec): string {
  // 実行する場所が変わるとタイトルの先頭も変わる（CLAUDE.md「[手作業] <実行する場所>: <やること>」）。
  // ワークフローへ流せるならサブPCの1コマンドで済む（#2246）
  return vpsProvisionable(spec)
    ? `[手作業] サブPC: ${spec.displayName}をVPSへ受け入れる（置き場・DB・証明書）`
    : `[手作業] VPS: ${spec.displayName}の置き場と証明書を用意する`;
}

/**
 * VPS実機の受け入れの手作業Issue。
 *
 * **常駐プロセスを持つ種別では、サブPCから1コマンド流すだけになった**（#2246）。
 * `/home/github-user/apps/<name>/`の作成・DB作成・vhostの有効化・PM2への登録・certbot・
 * `:443`の`X-Forwarded-Proto`の修正は、`guchi-apps/vps`の「アプリをプロビジョニングする」
 * ワークフローが実機の`scripts/provision-app.sh`を叩いて行う（`guchi-apps/vps#132`）。
 * SSHもsudoも要らないので、手作業アシスタントの代行実行で流せる。
 *
 * **ApacheのVirtualHostはここには書かない**（あちらはリポジトリ管理下で、
 * ワークフローは配置済みのファイルを`a2ensite`で有効化するだけ）。
 */
export function buildVpsManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  if (vpsProvisionable(spec)) return buildVpsProvisionIssueBody(spec, refs);
  return buildVpsSshManualIssueBody(spec, refs);
}

/** ワークフローへ流すだけで済む形（常駐プロセスを持つ種別）。 */
function buildVpsProvisionIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const host = hostnameFor(spec);
  const vpsRef = refs.vps ?? `${NEW_APP_VPS_REPOSITORY}のIssue`;
  const command = vpsProvisionCommand(spec);
  const runList = `gh run list --repo ${NEW_APP_VPS_REPOSITORY} --workflow ${VPS_PROVISION_WORKFLOW}`;

  return manualStepBody({
    benefit: `${spec.displayName}が ${publicUrlFor(spec)} で開けるようになる`,
    blocked: `デプロイの配布先が無く、${spec.databaseName ? "DBにも接続できず、" : ""}HTTPSでも開けない`,
    urgency: "初回デプロイの前（1回目）と、初回デプロイの後（2回目）",
    device: "**サブPC**",
    cwd: "不要",
    branch: "不要",
    prerequisiteIssues: `${vpsRef}（VirtualHostが \`main\` まで進んで実機へ反映済み）`,
    otherPrerequisites: `\`gh\` がログイン済みであること。**VPSへのSSHも \`sudo\` も要りません**——実機の操作は ${NEW_APP_VPS_REPOSITORY} の「アプリをプロビジョニングする」ワークフローが行います（\`guchi-apps/vps#132\`）。DNSは \`*.gucchii.com\` のワイルドカードで登録済みなので、Aレコードの追加も要りません（\`guchi-apps/vps#131\`）`,
    steps: `**同じコマンドを2回流します。** 何度実行しても結果は同じで、済んでいる段は
\`(変更なし)\` と出るだけです。1回目で置き場・DB・vhostの有効化・証明書まで進み、
2回目で\`deploy/ecosystem.config.js\`ができたPM2への登録が進みます。

- [ ] （サブPC）初回デプロイの前に、VPSの受け入れを流す

  \`\`\`bash
  ${command}
  \`\`\`

- [ ] （サブPC）初回デプロイの後に、もう一度流してPM2へ登録する

  \`\`\`bash
  ${command}
  \`\`\`

- [ ] （サブPC）実行ログの末尾「リポジトリへ取り込む差分」に出た内容を ${vpsRef} へ控える

  \`\`\`bash
  ${runList} --limit 1 --json databaseId --jq '.[0].databaseId' \\
    | xargs -I{} gh run view {} --repo ${NEW_APP_VPS_REPOSITORY} --log
  \`\`\`

  certbotは実機の設定ファイルだけを書き換えます。控えて取り込むまで、毎日のドリフト検知に
  「[新規（未取り込み）]」として出続けます。`,
    verification: `**手順ごとに1つずつ確かめます**（#2256）。サブPCで上から順に流し、すべてが成功すれば完了です。

- 直近のプロビジョニングが成功している

  \`\`\`bash
  ${runList} --limit 1 --json conclusion --jq '.[0].conclusion' | grep -x success
  \`\`\`

  \`success\` が出れば完了です。実行が1件も無ければ何も返らず、終了コードは0になりません。

- 公開まで届いている

  \`\`\`bash
  curl -fsS -o /dev/null -w '%{http_code}\\n' ${publicUrlFor(spec)}
  \`\`\`

  200 か 3xx が出れば完了です。**DNS・Apache・TLS・アプリのプロセスをすべて通るので、
  ここが通れば置き場もDBもPM2も証明書も揃っています**（#2252）。400以上は終了コードが0になりません。

控えた \`${host}-le-ssl.conf\` を ${vpsRef} で取り込むところだけは、コマンドで確かめられません。
${vpsRef} にコメントが付いていることを目で確かめてください。`,
    why: `${NEW_APP_VPS_REPOSITORY} のワークフローを \`workflow_dispatch\` で起動する操作で、実機の設定と本番のDBに触れるためです。**この手順と \`## 完了の確認方法\` のコマンドは、手作業アシスタントの代行実行で流せます。**`,
    related: `- 起点Issue: ${refs.parent}
- VirtualHost: ${vpsRef}
- プロビジョニングの受け口: \`guchi-apps/vps#132\``,
  });
}

/**
 * 実機での手順を残す形（常駐プロセスを持たない種別）。
 *
 * **プロビジョニングのワークフローは`app_port`が必須なので使えない。** 静的サイトのように
 * ポートを持たない種別だけがここへ来る。
 */
function buildVpsSshManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const host = hostnameFor(spec);
  const appDir = serverAppDir(spec);
  const vpsRef = refs.vps ?? `${NEW_APP_VPS_REPOSITORY}のIssue`;

  const dbStep = spec.databaseName
    ? `
- [ ] （VPS）データベースを作る

  \`\`\`bash
  sudo mysql -e "CREATE DATABASE IF NOT EXISTS ${spec.databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  \`\`\`
`
    : "";

  // 確認は手順と1対1にする（#2256）。手順を出し分けたのに確認が固定だと、
  // 「確かめる先が無いコマンド」が並んで必ず失敗する
  const dbCheck = spec.databaseName
    ? `
- データベースがある

  \`\`\`bash
  sudo mysql -N -e "SHOW DATABASES LIKE '${spec.databaseName}'" | grep -x ${spec.databaseName}
  \`\`\`
`
    : "";

  return manualStepBody({
    benefit: `${spec.displayName}が ${publicUrlFor(spec)} で開けるようになる`,
    blocked: `デプロイの配布先が無く、${spec.databaseName ? "DBにも接続できず、" : ""}HTTPSでも開けない`,
    urgency: "初回デプロイの前",
    device: "**VPS**（`ssh` で接続する）",
    cwd: "不要",
    branch: "不要",
    prerequisiteIssues: `${vpsRef}（VirtualHostが \`main\` まで進んで実機へ反映済み）`,
    otherPrerequisites: `\`sudo\` が使えること。DNSは \`*.gucchii.com\` のワイルドカードで登録済みなので、${host} は最初から引けます（\`guchi-apps/vps#131\`）`,
    steps: `- [ ] （VPS）アプリの置き場を作る

  \`\`\`bash
  sudo mkdir -p ${appDir} && sudo chown -R github-user:github-user ${appDir}
  \`\`\`
${dbStep}
- [ ] （VPS）TLS証明書を取得する

  \`\`\`bash
  sudo certbot --apache -d ${host}
  \`\`\`

- [ ] （VPS）certbotが複製した \`:443\` 側の \`X-Forwarded-Proto\` を \`"https"\` へ直す（\`"http"\` のままだと本番でだけログインが失敗する）

  \`\`\`bash
  grep -n 'X-Forwarded-Proto' /etc/apache2/sites-available/${host}-le-ssl.conf
  sudo sed -i 's/X-Forwarded-Proto "http"/X-Forwarded-Proto "https"/' /etc/apache2/sites-available/${host}-le-ssl.conf
  sudo apachectl configtest && sudo systemctl reload apache2
  \`\`\`

- [ ] （VPS）certbotが作った設定ファイルの内容を控え、${vpsRef} へコメントする

  \`\`\`bash
  sudo cat /etc/apache2/sites-available/${host}-le-ssl.conf
  \`\`\``,
    verification: `**手順ごとに1つずつ確かめます**（#2256）。VPSで上から順に流し、すべてが成功すれば完了です。

- アプリの置き場がある

  \`\`\`bash
  test -d ${appDir} && echo ok
  \`\`\`
${dbCheck}
- 公開まで届いている

  \`\`\`bash
  curl -fsS -o /dev/null -w '%{http_code}\\n' ${publicUrlFor(spec)}
  \`\`\`

  200 か 3xx が出れば完了です。400以上は終了コードが0になりません。

- \`:443\` 側に \`X-Forwarded-Proto "http"\` が残っていない

  \`\`\`bash
  conf=/etc/apache2/sites-available/${host}-le-ssl.conf
  sudo test -f "$conf" && ! sudo grep -q 'X-Forwarded-Proto "http"' "$conf" && echo ok
  \`\`\`

  \`ok\` が出れば完了です（\`"http"\` が残っていると本番でだけログインが失敗します）。

控えた \`${host}-le-ssl.conf\` を ${vpsRef} で取り込むまでは、毎日のドリフト検知に
「[新規（未取り込み）] apache/sites-available/${host}-le-ssl.conf」として出続けます。ここだけは
コマンドで確かめられないので、${vpsRef} にコメントが付いていることを目で確かめてください。`,
    why: "VPSへのSSHと`sudo`を伴う実機の操作で、エージェントの実行環境からは行えないためです（代行実行の対象はサブPCだけです）。",
    related: `- 起点Issue: ${refs.parent}
- VirtualHost: ${vpsRef}`,
  });
}

export function buildBrowserManualIssueTitle(spec: NewAppSpec): string {
  return `[手作業] ブラウザ: ${spec.repositoryName}をGitHub Appのインストール対象へ追加する`;
}

/**
 * ブラウザでしか行えない登録の手作業Issue。
 *
 * **中身が空振りの手順しか無いときは、このIssue自体を作らない**（#2246。
 * `newAppArtifacts`と`POST /api/new-app`が`githubAppNeedsRepositoryAdd`で出し分ける）。
 * `aide-bot`の立ち上げ（#2215）では、5手順のうち独自に必要なものが実質1つも無いIssueが
 * 人の着手を待ち続けた。外した3つの根拠は次のとおり。
 *
 * - **DNSのAレコード**: `*.gucchii.com`のワイルドカードを登録済み（`guchi-apps/vps#131`）。
 *   新しいサブドメインは追加登録なしで引ける
 * - **Actions secrets**: `OP_SERVICE_ACCOUNT_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`・
 *   `WORKFLOW_PAT`はorganizationに`visibility=all`で登録済み（#2255）。
 *   確認だけはサブPCの手作業Issueへ移した（`buildSubpcManualIssueBody`）
 * - **2つの再同期**: 立ち上げ自身が実行する（#2248・`lib/new-app/resync.ts`）
 *
 * 残るのはGitHub Appのインストール対象への追加だけで、これも
 * `repository_selection`が`selected`のときにしか要らない（`lib/new-app/installation-scope.ts`）。
 */
export function buildBrowserManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const repo = repositoryFullName(spec);

  return manualStepBody({
    benefit: `\`${repo}\` のIssueがissue-deckの盤面に載り、無人実行を起動できるようになる`,
    blocked: "新しいリポジトリのIssueが画面に出ず、無人実行を起動できない",
    urgency: "初期化Issueを盤面から起動するまで",
    device: "**ブラウザ**",
    cwd: "不要",
    branch: "不要",
    prerequisiteIssues: "なし",
    otherPrerequisites: "GitHubにorganizationの管理者としてログイン済みであること",
    steps: `- [ ] （ブラウザ）issue-deckのGitHub Appのインストール対象へ \`${repo}\` を追加する

  \`\`\`
  https://github.com/organizations/${NEW_APP_ORG}/settings/installations
  \`\`\``,
    verification: `- インストール対象に入っている

  \`\`\`bash
  gh api repos/${repo}/installation --jq .id
  \`\`\`

  インストールIDが1行出れば完了です。対象に入っていなければ404で終わり、終了コードは0になりません。

DNSのAレコードとActions secretsの登録は要りません（\`*.gucchii.com\` のワイルドカードと、
organizationの \`visibility=all\` のsecretで足ります）。リポジトリとIssueの取り込みも
立ち上げが済ませているので、再同期を押す必要はありません。`,
    why: "GitHub Appのインストール対象は、無断で変更してよいものではないためです。",
    related: `- 起点Issue: ${refs.parent}`,
  });
}

/**
 * ポート帯を足すPull Requestのブランチ名。
 *
 * `issue-<番号>`の形は使わない——Issue単位の作業ブランチと取り違えると、進捗の遷移が
 * ブランチ名だけを見ている仕組み（`issue-labels.yml`）が誤って反応する。
 */
export function portBandBranchName(spec: Pick<NewAppSpec, "repositoryName">): string {
  return `new-app-port-band/${spec.repositoryName}`;
}

export function buildPortBandCommitMessage(spec: NewAppSpec, base: number): string {
  return `${spec.displayName}（${spec.repositoryName}）のローカルセッションのポート帯 ${base} を確保する。`;
}

export function buildPortBandPullRequestTitle(spec: NewAppSpec, base: number): string {
  return `${spec.repositoryName}のローカルセッションのポート帯 ${base} を確保する`;
}

/**
 * ポート帯を足すPull Requestの本文（CLAUDE.mdのPR本文テンプレートの見出しに揃える）。
 *
 * **`closes`は使わない。** developへのマージ時点では親Issueをcloseしない運用で、
 * 立ち上げはここから先も続く。
 */
export function buildPortBandPullRequestBody(
  spec: NewAppSpec,
  base: number,
  refs: Pick<NewAppIssueRefs, "parent">,
): string {
  const repo = repositoryFullName(spec);
  return `${origin(refs.parent)}

## 対応Issue

- ${refs.parent}

## 実装内容

- \`${LOCAL_PORT_BAND_CONF_PATH}\` へ \`${repo}\` のポート帯（ベース値 \`${base}\`）を追記する

対応表に載っていないリポジトリは、汎用ランチャー（\`scripts/generic-start-issue.sh\`）の既定
\`3000 + Issue番号\` に落ちます。未登録のリポジトリ同士が同じ帯へ相乗りするため、同じ番号の
Issueを別リポジトリで同時に起こすと開発サーバーのポートが衝突します（#1741・#1276・#2213）。

## テスト内容

- なし（設定ファイルへの1行追記のみ。CIのlint・型チェック・テストは通ります）

## 確認方法

\`\`\`bash
grep -F '${repo}' scripts/local-repo-ports.conf
\`\`\`

サブPCでは、developへマージしたうえで**issue-deckの画面のホスト一覧で「更新して再起動」**を
押すと反映されます（このファイルは本体チェックアウトから読まれるため、マージだけでは効きません）。

## 注意点

- 帯は「現状の最大 + 1000」で決めています。空きを詰め直してはいません（古いチェックアウトが
  残っているサブPCで前の持ち主と衝突しうるため）。
`;
}

/** 立ち上げの最後に画面へ出す、作られたものの参照。 */
export type NewAppCreatedRef = {
  kind: NewAppArtifactKind;
  title: string;
  /** `guchi-apps/issue-deck#123` / `guchi-apps/kakei-report` */
  reference: string;
  url: string;
  /**
   * 新しく作ったのではなく、**既にあったIssueへコメントした**（#2250）。
   * 画面はこれを見て「既存」の印を出す。
   */
  existing?: boolean;
};
