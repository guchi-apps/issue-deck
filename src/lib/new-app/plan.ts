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
 *   管理リポジトリのIssueへ切り出す」）。ただし`/home/github-user/apps/<name>/`の作成・DB作成・PM2への登録・
 *   certbotは**`deploy.yml`が配る受け口ではない**ので、VPSの手作業として残る。
 * - **サブPCの手順は代行実行の条件を満たす形で書く。** 実行するデバイスがサブPC・1手順に
 *   コマンドブロックがちょうど1つ・対話が要るコマンドを含まない・`<…>`のプレースホルダを
 *   含まない、のすべてを満たしたときだけ画面から流せる
 *   （`lib/dispatch/dispatch-job.ts`の`manualStepExecutionRejection`）。
 * - **新しいリポジトリのIssueは、作った直後には盤面に載らない。** 載る条件は
 *   `claude-issue-dispatch.yml`がデフォルトブランチにあることで、それを作るのが初期化Issue
 *   自身。したがって初期化Issueの実行経路は**サブPCのローカルセッション**に固定する
 *   （条件は`local-repos.conf`への記載）。
 * - **人が空振りする手順を書かない**（#2248）。2つの再同期は立ち上げ自身が実行し
 *   （`lib/new-app/resync.ts`）、GitHub Appのインストール対象への追加は
 *   `repository_selection`が`selected`のときだけ出す（`lib/new-app/installation-scope.ts`）。
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
 * シークレット投入コマンド。**フィールド名の羅列にせず、そのまま貼れる1コマンドで出す**（#2249）。
 *
 * `aide-bot`の立ち上げでは「`db-name = app_aide_bot / ci-webhook-url（Signaly）/ target-dir = …`」
 * という羅列を手作業Issueに書いていたため、値が未登録のまま初回の本番デプロイが走り
 * `DB_NAME: DB_NAME is required` で失敗した（`guchi-apps/aide-bot#4`→`#8`）。
 *
 * 機械的に定まる値（配置先・DB名・許可メール）と、人がSignalyで作らないと決まらない
 * webhook URLとで**呼び分ける**。スクリプトは何度実行してもよい作りなので、順序は問わない。
 */
function provisionCommand(spec: NewAppSpec, ciWebhookUrl: string | null): string {
  const options = [`--repo ${repositoryFullName(spec)}`];
  if (ciWebhookUrl === null) {
    if (spec.databaseName) options.push(`--db-name ${spec.databaseName}`);
    // 許可メールは既存アプリの値をコピーする（コピー元はスクリプト側に持たせている）
    if (spec.auth !== "none") options.push("--copy-allowed-emails");
  } else {
    options.push(`--ci-webhook-url '${ciWebhookUrl}'`);
  }
  // 続きの行は2つ下げる（コードブロック自体が箇条書きの下に2スペース下がっているため、
  // 同じ幅だと折り返しに見えない）
  return [PROVISION_SCRIPT, ...options].join(" \\\n    ");
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
      description: `リポジトリを${spec.visibility === "private" ? "private" : "public"}で作り、既定ブランチを develop にしてラベル一式を写す`,
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
        ? "雛形の作成・CI・デプロイ設定と、マルチエージェント運用の導入。サブPCのローカルセッションで実装する"
        : "雛形の作成・CI・デプロイ設定。サブPCのローカルセッションで実装する",
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
      automation: "manual",
      title: `[手作業] VPS: ${spec.displayName}の置き場とプロセスを用意する`,
      target: "guchi-apps/issue-deck",
      description: "ディレクトリ作成・DB作成・PM2への登録・certbot。Gitで配れない実機の操作",
    },
    {
      kind: "manual-subpc",
      automation: "proxy",
      title: `[手作業] サブPC: ${spec.repositoryName}をcloneし、シークレットを投入する`,
      target: "guchi-apps/issue-deck",
      description: "cloneと対応表への追記、1Passwordへの値の投入。手作業アシスタントの代行実行で流せる",
    },
    {
      kind: "manual-browser",
      automation: "manual",
      title: `[手作業] ブラウザ: ${spec.repositoryName}のDNSとシークレットを登録する`,
      target: "guchi-apps/issue-deck",
      description: githubAppNeedsRepositoryAdd
        ? "AレコードはVPSの管理画面でしか登録できない。Secrets・GitHub Appもここで行う"
        : "AレコードはVPSの管理画面でしか登録できない。Secretsもここで行う",
    },
  ];

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
            ? "用意する"
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

1. ローカルセッションのポート帯を確保する（${portBandLine}。立ち上げが自動でPull Requestを作ります）
2. ブラウザでの登録（DNSのAレコード・Secrets${options.githubAppNeedsRepositoryAdd ? "・GitHub App" : ""}）
3. サブPCへcloneし、1Passwordへ値を投入する（ここまで済むと初期化Issueをローカルセッションで実装できる）
4. \`${repo}\` の初期化と、developへのマージ
5. \`${NEW_APP_VPS_REPOSITORY}\` のVirtualHostを develop → main まで進めて実機へ反映
6. VPSで置き場・DB・PM2・TLSを用意して初回デプロイ
7. 初回デプロイ前チェックを行い、公開URLが開けることを確かめる（\`${repo}\` の「初回デプロイ前チェックと公開確認」Issue）

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
function appearanceSteps(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const profile = newAppKindProfile(spec.kind);
  const steps: string[] = [
    `- [ ] 表示名を \`${appTitleFor(spec)}\` にする（\`title\` / \`applicationName\` / \`appleWebApp.title\`）`,
  ];

  if (spec.pwa) {
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

  if (spec.changelog) {
    steps.push(
      spec.kind === "fastapi"
        ? "- [ ] 更新履歴（changelog）を持たせる（`version.json` + `frontend/changelog.js` + `scripts/bump_version.py`。callerの`bump-command`から呼ぶ）"
        : `- [ ] 更新履歴（changelog）を持たせる。\`"version"\` lifecycleスクリプトで \`RELEASE_CHANGELOG\`・\`RELEASE_USAGE\` を受け取る（受け取り方はissue-deckの \`docs/cross-repo-setup-guide.md\`）。**\`preversion\` は作らず、スクリプトはNode標準モジュールだけで書く**——共有ワークフローはbumpのために依存をインストールしない`,
    );
  }

  if (screenshotBypassEnabled(spec)) {
    steps.push(
      `- [ ] CI撮影の認証バイパスを用意する（開発用ログインのエンドポイントと、ダミーデータを入れる \`${profile.packageManager === "pnpm" ? "pnpm" : "npm run"} db:seed:dev\` 相当）。**これが無いと \`24.screenshot-required\` が成立しない**（参照実装はissue-deckの \`/api/dev/login\`）`,
    );
  }

  return steps.join("\n");
}

export function buildInitIssueTitle(spec: NewAppSpec): string {
  return `${spec.displayName}のプロジェクトを初期化する`;
}

/**
 * 新しいリポジトリに立てる初期化Issue。
 *
 * **`## 前提条件`にサブPCの手作業Issueを書く。** このIssueは無人実行では動かせない
 * （`claude-issue-dispatch.yml`がまだ無く、盤面にも載らない）ので、サブPCのローカル
 * セッションで実装する。そのためには`local-repos.conf`への記載が要る。
 */
export function buildInitIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const profile = newAppKindProfile(spec.kind);
  const repo = repositoryFullName(spec);
  const dbScripts = profile.usesDatabase
    ? `\n- [ ] \`db:migrate:deploy\` と \`db:seed:ci\` のnpm scriptsを用意する（共有ワークフローがこの名前で呼ぶ。違う名前だと無言でスキップされる）`
    : "";
  const appearance = `\n${appearanceSteps(spec, refs)}`;
  const multiAgent = spec.multiAgent
    ? `
## マルチエージェント運用の導入

手順の正はissue-deckの \`docs/cross-repo-setup-guide.md\` です。ここに複製しません。

- [ ] \`.github/workflows/issue-labels.yml\`（\`reusable-issue-labels.yml\` のcaller）を置く
- [ ] \`.github/workflows/claude-issue-dispatch.yml\` を置く。\`runtime-setup: ${profile.runtimeSetup}\`・\`package-manager: ${profile.packageManager}\`・\`prompts-ref\` は \`uses:\` と同じタグ
- [ ] \`CLAUDE.md\` に運用ルールを書く（GitHub Actions上の無人実行はグローバル設定を読まない）
- [ ] \`.gitignore\` に \`.shared-context/\` を足す
- [ ] \`develop\` にもBranch protection（CI必須）を設定する
`
    : "";

  return `${origin(refs.parent)}

## このIssueで作るもの

${specTable(spec)}

${spec.summary.trim() ? `${spec.summary.trim()}\n` : ""}
## 前提条件

- 先に完了している必要があるIssue・PR: ${[refs.subpc ?? "（サブPCへのcloneの手作業Issue）", refs.portBandPullRequest ?? "（ローカルセッションのポート帯を足すPull Request）"].join("・")}

**このIssueはサブPCのローカルセッションで実装します。** 新しいリポジトリはまだ
\`claude-issue-dispatch.yml\` を持たないため無人実行では動かず、issue-deckの盤面にも載りません。
ローカルセッションを起こせる条件は \`~/.config/issue-deck/local-repos.conf\` への記載で、
それを行うのが上の手作業Issueです。

## やること

- [ ] 雛形を作る（${profile.label}）
- [ ] バージョン管理を \`package.json\` の \`version\` に載せる
- [ ] \`.env.example\`（変数名のみ）と \`.env.tpl\`（\`op://\` 参照）を作る
- [ ] \`.github/workflows/ci.yml\` を作る（必須）
- [ ] \`.github/workflows/deploy.yml\` を作る（\`main\` へのpushでVPSへ配る。配布先は \`${serverAppDir(spec)}/\`）
- [ ] \`.github/secrets-manifest.tsv\` を作る（\`op://apps/${spec.repositoryName}/…\` を読む行。これが無いとGitHubのsecretへ同期できない）
- [ ] 1Passwordの値をGitHubのsecretへ同期する（マニフェストをpushした後、そのブランチを指定して実行する）

  \`\`\`bash
  ${provisionCommand(spec, null)} \\
    --ref <このIssueのブランチ>
  \`\`\`

- [ ] \`.github/deploy.env.tpl\` と \`.github/scripts/signaly-notify.sh\` を置く（CI・デプロイ通知の \`SIGNALY_WEBHOOK_URL\` はorganization secretから来るため、Signalyのチャンネル作成も \`op://\` 参照の追加も要らない）
- [ ] \`main\` のBranch protectionを設定する${spec.port === null ? "" : `\n- [ ] \`deploy/ecosystem.config.js\` を作る（ポート \`${spec.port}\`）`}${dbScripts}${appearance}
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

- [ ] \`develop\` → \`main\` のリリースPRを作る
- [ ] **人がマージする**（\`develop\` → \`main\` は自動マージ不可カテゴリ）
- [ ] \`deploy.yml\` の成功と、Signalyへのデプロイ結果の通知を確認する

## 完了の確認方法

\`\`\`bash
curl -I ${url}
\`\`\`

**200 か 3xx が返ればここまで届いています。これが立ち上げの完了条件です**（${refs.parent}）。
返らないときの切り分けは次のとおりです。

| 症状 | 見るところ |
|---|---|
| 名前を解決できない | DNSのAレコード（${refs.parent} のブラウザ手作業Issue） |
| 404が返る・別のアプリが出る | ApacheのVirtualHost（${vpsRef} が \`main\` まで進んで実機へ反映されているか） |
| 502・503が返る | アプリのプロセス（${vpsManualRef}。VPSで \`pm2 describe ${spec.repositoryName}\`） |
| TLSのエラーになる | certbot（${vpsManualRef}） |

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
function portBandPrerequisite(refs: NewAppIssueRefs): string {
  const pr = refs.portBandPullRequest ?? `\`${LOCAL_PORT_BAND_CONF_PATH}\` へポート帯を足すPull Request`;
  return `${pr} がdevelopへマージされ、issue-deckの画面のホスト一覧で「更新して再起動」を押してサブPCのチェックアウトを更新済みであること`;
}

export function buildSubpcManualIssueTitle(spec: NewAppSpec): string {
  return `[手作業] サブPC: ${spec.repositoryName}をcloneし、シークレットを投入する`;
}

/**
 * サブPCの手作業Issue。**代行実行の条件をすべて満たす形で書く。**
 *
 * - 実行するデバイスは `サブPC` の1つだけ
 * - 1手順にコマンドブロックはちょうど1つ
 * - 対話が要るコマンド（`op signin` など）を含まない
 * - `<…>` のプレースホルダを含まない（値はすべて埋めて出す）
 *
 * 条件を1つでも崩すと、その手順は「あなたが実行」として並ぶだけになる。
 */
export function buildSubpcManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const repo = repositoryFullName(spec);
  const path = `/home/guchi/apps/${spec.repositoryName}`;
  return manualStepBody({
    benefit: `サブPCで \`${spec.repositoryName}\` のローカルセッションを起こせるようになり、1Passwordに \`${spec.repositoryName}\` の値（配置先${spec.databaseName ? "・DB名" : ""}${spec.auth === "none" ? "" : "・許可メール"}）が入る`,
    blocked: `\`${repo}\` のIssueをローカルセッションで実装できない。新しいリポジトリはまだ \`claude-issue-dispatch.yml\` を持たないため、無人実行でも動かせない。シークレットも未登録のままで、初回の本番デプロイが値の不足で失敗する`,
    urgency: "初期化Issueに着手する前",
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

- [ ] （サブPC）対応表に載ったことを確かめる

  \`\`\`bash
  grep -F '${repo}' "$HOME/.config/issue-deck/local-repos.conf"
  \`\`\`

- [ ] （サブPC）1Passwordのアイテムを作り、機械的に定まる値を投入する

  \`\`\`bash
  ${provisionCommand(spec, null)}
  \`\`\``,
    verification: `対応表の手順の出力に \`${repo} ${path}\` の1行が出て、投入の手順が \`ok\` で終われば完了です。
pollerは申告のたびに対応表を読み直すので、再起動は要りません。
**この時点ではGitHubのsecretへの同期は行われません**——同期には \`${repo}\` の
\`.github/secrets-manifest.tsv\` が要るので、初期化Issueでこのマニフェストを作ってマージした後に揃います。`,
    why: "サブPCのファイルシステムと個人設定（`~/.config/issue-deck/local-repos.conf`）への書き込みで、GitHubからは行えないためです。ただしこの4手順は手作業アシスタントの代行実行で流せます。",
    related: `- 起点Issue: ${refs.parent}`,
  });
}

export function buildVpsManualIssueTitle(spec: NewAppSpec): string {
  return `[手作業] VPS: ${spec.displayName}の置き場とプロセスを用意する`;
}

/**
 * VPSの手作業Issue。
 *
 * **`guchi-apps/vps`へ切り出さないものだけを書く。** `/home/github-user/apps/<name>/`・MariaDBのデータベース・
 * PM2のプロセス登録・certbotはいずれも`deploy.yml`が配る受け口ではなく、実機で1度だけ
 * 実行する。ApacheのVirtualHostはここには書かない（あちらはリポジトリ管理下）。
 */
export function buildVpsManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
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

  const pm2Step =
    spec.port === null
      ? ""
      : `
- [ ] （VPS）初回デプロイの後、PM2へ登録して保存する

  \`\`\`bash
  cd ${appDir} && pm2 start deploy/ecosystem.config.js && pm2 save
  \`\`\`
`;

  return manualStepBody({
    benefit: `${spec.displayName}が ${publicUrlFor(spec)} で開けるようになる`,
    blocked: `デプロイの配布先が無く、${spec.databaseName ? "DBにも接続できず、" : ""}HTTPSでも開けない`,
    urgency: "初回デプロイの前",
    device: "**VPS**（`ssh` で接続する）",
    cwd: "不要",
    branch: "不要",
    prerequisiteIssues: `${vpsRef}（VirtualHostが \`main\` まで進んで実機へ反映済み）、および ${refs.parent} のDNS登録`,
    otherPrerequisites: `\`sudo\` が使えること。certbotは ${host} のAレコードが引けるようになってから実行すること`,
    steps: `- [ ] （VPS）アプリの置き場を作る

  \`\`\`bash
  sudo mkdir -p ${appDir} && sudo chown -R github-user:github-user ${appDir}
  \`\`\`
${dbStep}${pm2Step}
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
    verification: `\`curl -I ${publicUrlFor(spec)}\` が 200 か 3xx を返せば公開まで届いています。
\`grep X-Forwarded-Proto /etc/apache2/sites-available/${host}-le-ssl.conf\` が何も返さないか
\`"https"\` を返せば、\`:443\` 側の直しは済んでいます（\`"http"\` が残っていると本番でだけログインが失敗します）。
控えた \`${host}-le-ssl.conf\` を ${vpsRef} で取り込むまでは、毎日のドリフト検知に
「[新規（未取り込み）] apache/sites-available/${host}-le-ssl.conf」として出続けます。`,
    why: "VPSへのSSHと`sudo`を伴う実機の操作で、エージェントの実行環境からは行えないためです（代行実行の対象はサブPCだけです）。",
    related: `- 起点Issue: ${refs.parent}
- VirtualHost: ${vpsRef}`,
  });
}

export function buildBrowserManualIssueTitle(spec: NewAppSpec): string {
  return `[手作業] ブラウザ: ${spec.repositoryName}のDNSとシークレットを登録する`;
}

/**
 * ブラウザでの登録をまとめた手作業Issue。
 *
 * **AレコードはVPSプロバイダの管理画面でしか登録できない**（APIが無い。
 * `_docs/guides/apache-domain-setup.md` も「実行者: 人間のみ」としている）。
 *
 * **2つの再同期はここに書かない**（#2248）。立ち上げ自身がリポジトリとIssueを取り込む
 * （`lib/new-app/resync.ts`）。押し忘れると新しいリポジトリのIssueが画面に出ず、#2215では
 * 実際に押されないままだった。
 *
 * **GitHub Appのインストール対象への追加も、必要なときだけ書く**（#2248）。
 * `issue-deck`・`issue-deck-dev`とも`repository_selection=all`で入っているため、通常は
 * 新しいリポジトリが自動で対象に入る。`selected`へ戻されたとき（と選び方を読めなかったとき）
 * だけ手順を出す（`refs.githubAppNeedsRepositoryAdd`）。
 */
export function buildBrowserManualIssueBody(spec: NewAppSpec, refs: NewAppIssueRefs): string {
  const repo = repositoryFullName(spec);
  const host = hostnameFor(spec);
  const dnsStep =
    spec.urlMode === "subdomain"
      ? `- [ ] （ブラウザ）VPS管理画面のDNS設定で \`${spec.subdomain}\` のAレコードを追加し、VPSのIPへ向ける

  \`\`\`bash
  dig +short ${host} A
  \`\`\`

`
      : "";

  const secretsStep = spec.multiAgent
    ? `- [ ] （ブラウザ）\`${repo}\` のActions secretsへ \`OP_SERVICE_ACCOUNT_TOKEN\`・\`CLAUDE_CODE_OAUTH_TOKEN\`・\`WORKFLOW_PAT\` を登録する

  \`\`\`
  https://github.com/${repo}/settings/secrets/actions
  \`\`\`

`
    : `- [ ] （ブラウザ）\`${repo}\` のActions secretsへ \`OP_SERVICE_ACCOUNT_TOKEN\` を登録する

  \`\`\`
  https://github.com/${repo}/settings/secrets/actions
  \`\`\`

`;

  const githubAppStep = refs.githubAppNeedsRepositoryAdd
    ? `

- [ ] （ブラウザ）issue-deckのGitHub Appのインストール対象へ \`${repo}\` を追加する

  \`\`\`
  https://github.com/organizations/${NEW_APP_ORG}/settings/installations
  \`\`\``
    : "";

  return manualStepBody({
    benefit: `${host} が名前解決できるようになり、\`${repo}\` のCI・デプロイがシークレットを読めるようになる`,
    blocked: `TLS証明書が取れず（certbotはAレコードを引けることが前提）、CI・デプロイがシークレット不足で失敗する`,
    urgency: "立ち上げの最初に行う（後続がすべてこれを待つ）",
    device: "**ブラウザ**",
    cwd: "不要",
    branch: "不要",
    prerequisiteIssues: "なし",
    otherPrerequisites: "1PasswordとGitHubにログイン済みであること",
    steps: `${dnsStep}${secretsStep.trimEnd()}${githubAppStep}`,
    verification: `\`dig +short ${host} A\` がVPSのIPを返し、\`${repo}\` のActions secretsに登録した名前が並べば完了です。
アプリ自身のシークレット（配置先・DB名）は、投入の手順の最後に出る「総数」で確かめます（\`gh api repos/${repo}/actions/secrets --jq .total_count\` と同じ値）。
リポジトリとIssueの取り込みは立ち上げが済ませているので、再同期を押す必要はありません。`,
    why: `DNSはVPSプロバイダの管理画面でしか設定できずAPIがありません。GitHub Secrets${refs.githubAppNeedsRepositoryAdd ? "、GitHub Appの権限" : ""}も、無断で変更してよいものではないためです。`,
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
};
