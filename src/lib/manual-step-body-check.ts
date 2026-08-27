import { collectShellBlocks, findInteractiveCommand } from "@/lib/manual-step-command";
import {
  matchManualStepDeviceNames,
  parseManualStepGuide,
  splitManualStepSections,
} from "@/lib/manual-step-guide";
import { FENCE_PATTERN } from "@/lib/markdown-task-list";

/**
 * 手作業Issueの本文が、画面（手作業アシスタント）の読み方に合っているかを検査する（#2048）。
 *
 * **書式の揺れは見た目の問題ではなく、機能が黙って落ちる問題である。** 実測でopenだった3件
 * （guchi-apps/aide#103・asset-manager#210・car-care#99）は、太字の有無・コードブロックの
 * インデント・参照の書き方が3通りに割れていた。うち2件は`## 関連`の対応PRをURLで書いており、
 * `manual-step-prerequisites.ts`の参照抽出（`owner/repo#123`形式）から丸ごと落ちていた。
 *
 * **検査するのは画面が実際に使う項目だけにする。** 「テンプレートと文字が違う」を全部指摘すると
 * 読まれなくなる。ここに1つ足すときは、崩れたときにどの機能が落ちるかを言えることを条件にする。
 *
 * **プレースホルダ（`<控えたkey>`）は規則にしない**（#2051で判断した）。値を人が埋める手順は
 * 本来そう書くしかなく、崩れているわけではない。指摘にすると直しようのない指摘が正しい本文へ
 * 出続ける。代行実行から外す判定は`findPlaceholder`（`manual-step-command.ts`）が持つ。
 *
 * **判定はパーサーと同じ関数を通す**（`parseManualStepGuide`・`splitManualStepSections`・
 * `collectShellBlocks`）。別実装で書き直すと、検査を通った本文を画面が読めない・その逆、
 * という食い違いが必ず出る。
 *
 * **ここは指摘を返すだけで、ラベルもゲートも持たない。** 手作業Issueに`00.check-user`を
 * 付けない規約（docs/multi-agent/labels.md）があり、起票を止める仕組みでもないため。
 */

/** 指摘の重さ。`error`は画面の機能が落ちるもの、`warning`は揃っていないが落ちないもの */
export type ManualStepBodyFindingSeverity = "error" | "warning";

export type ManualStepBodyFinding = {
  /** 規則の識別子。コメントの重複判定やテストで使う */
  rule: string;
  severity: ManualStepBodyFindingSeverity;
  /** 何が崩れているか。**直し方まで含めて1文で書く** */
  message: string;
};

/**
 * `## `の見出しと、その順序。
 *
 * 照合は`parseManualStepGuide`の`SECTION_MATCHERS`と同じく**部分一致**にする
 * （`## やること（サブPC）`のように補足が付く書き方が実際にあるため）。
 */
const REQUIRED_HEADINGS = [
  { label: "## この作業でできるようになること", needles: ["できるようになること"] },
  { label: "## 前提条件", needles: ["前提条件"] },
  { label: "## やること", needles: ["やること", "手順"] },
  { label: "## 完了の確認方法", needles: ["完了の確認方法", "確認方法"] },
  { label: "## なぜエージェントが実施しないか", needles: ["エージェントが実施しない"] },
  { label: "## 関連", needles: ["関連"] },
] as const;

/**
 * `## 前提条件`に要る項目。`needles`は`parseManualStepWhere`の`label.includes(...)`と揃える。
 *
 * デバイス・ディレクトリ・ブランチは画面のチップと代行実行の可否に直結するので`error`、
 * 残り2つは欠けても画面は動くので`warning`にしている。
 */
const REQUIRED_PREREQUISITES = [
  { label: "実行するデバイス", needles: ["デバイス"], severity: "error" },
  { label: "カレントディレクトリ", needles: ["ディレクトリ"], severity: "error" },
  { label: "Gitブランチ", needles: ["ブランチ"], severity: "error" },
  { label: "先に完了している必要があるIssue・PR", needles: ["先に完了", "必要があるissue"], severity: "warning" },
  { label: "その他の前提", needles: ["その他"], severity: "warning" },
] as const satisfies readonly {
  label: string;
  needles: readonly string[];
  severity: ManualStepBodyFindingSeverity;
}[];

/**
 * 1Passwordの中身を書き換える`op`のサブコマンド。
 *
 * **読み取り（`op read`・`op item get`・`op item list`）は含めない。** サブPCに常時exportされて
 * いるサービスアカウントはread権限を持つので、読むだけの手順はそのまま代行実行で通る。
 */
const OP_WRITE_COMMAND = /\bop\s+(?:item|document)\s+(?:create|edit|delete)\b/;

/** `https://github.com/<owner>/<repo>/(issues|pull)/<番号>` */
const GITHUB_REFERENCE_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** 照合用に、装飾と空白を落として小文字へ寄せる */
function normalize(text: string): string {
  return text.replace(/[\s　*`_]/g, "").toLowerCase();
}

export function checkManualStepBody(
  body: string | null | undefined,
  options: { repositoryFullName?: string } = {},
): ManualStepBodyFinding[] {
  if (!body || body.trim() === "") {
    return [{ rule: "empty-body", severity: "error", message: "本文が空です。雛形（docs/multi-agent/manual-step-body-template.md）を埋めてください。" }];
  }

  const findings: ManualStepBodyFinding[] = [];
  const sections = splitManualStepSections(body);
  const guide = parseManualStepGuide(body);

  findings.push(...checkHeadings(sections));
  findings.push(...checkPrerequisites(sections));
  findings.push(...checkDevice(guide));
  findings.push(...checkTodo(sections, guide));
  findings.push(...checkVerification(sections, guide));
  findings.push(...checkSecretCommands(sections, guide));
  findings.push(...checkRelatedReferences(sections, options.repositoryFullName));

  return findings;
}

/** 6つの見出しが規定の順で揃っているか */
function checkHeadings(sections: ReturnType<typeof splitManualStepSections>): ManualStepBodyFinding[] {
  const headings = sections
    .map((section) => section.heading)
    .filter((heading): heading is string => heading !== null)
    .map(normalize);

  const missing: string[] = [];
  // 文書に現れる順で貪欲に消し込む。残ったものが「不足」、消せたが順番が前後したものが「順序違い」
  let cursor = 0;
  let outOfOrder = false;
  for (const required of REQUIRED_HEADINGS) {
    const matches = (heading: string) => required.needles.some((needle) => heading.includes(needle));
    const at = headings.findIndex(matches);
    if (at === -1) {
      missing.push(required.label);
      continue;
    }
    if (at < cursor) outOfOrder = true;
    cursor = at;
  }

  const findings: ManualStepBodyFinding[] = [];
  if (missing.length > 0) {
    findings.push({
      rule: "missing-heading",
      severity: "error",
      message: `見出しが足りません: ${missing.join("・")}。画面はこの見出しで本文を節に割るため、無い節はそのまま欠けます。`,
    });
  }
  if (outOfOrder) {
    findings.push({
      rule: "heading-order",
      severity: "warning",
      message: `見出しの順が雛形と違います。${REQUIRED_HEADINGS.map((heading) => heading.label.replace("## ", "")).join(" → ")} の順にしてください。`,
    });
  }
  return findings;
}

/** `## 前提条件`の5項目が「ラベル: 値」の1行として読めるか */
function checkPrerequisites(
  sections: ReturnType<typeof splitManualStepSections>,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => entry.key === "prerequisites");
  if (!section) return [];

  const labels: string[] = [];
  const wrapped: string[] = [];
  let previousLabel: string | null = null;
  let openFence: string | null = null;

  for (const line of section.lines) {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      previousLabel = null;
      continue;
    }
    if (openFence !== null) continue;

    const item = LIST_ITEM.exec(line);
    if (item) {
      const separator = /[:：]/.exec(item[1]);
      previousLabel = separator ? normalize(item[1].slice(0, separator.index)) : null;
      if (previousLabel) labels.push(previousLabel);
      continue;
    }
    if (line.trim() === "" || HEADING.test(line)) {
      previousLabel = null;
      continue;
    }
    // リスト項目でも空行でもない行が項目の直後に続いている＝値の折り返し。
    // `parseManualStepWhere`は行単位でしか読まないため、続きは値に入らない
    if (previousLabel !== null) {
      wrapped.push(previousLabel);
      previousLabel = null;
    }
  }

  const findings: ManualStepBodyFinding[] = [];
  for (const required of REQUIRED_PREREQUISITES) {
    if (labels.some((label) => required.needles.some((needle) => label.includes(needle)))) continue;
    findings.push({
      rule: "missing-prerequisite",
      severity: required.severity,
      message: `\`## 前提条件\`に「${required.label}」の行がありません。\`- ${required.label}: …\`の形で1行足してください。`,
    });
  }
  if (wrapped.length > 0) {
    findings.push({
      rule: "wrapped-prerequisite",
      severity: "warning",
      message: "`## 前提条件`の項目が次の行へ折り返しています。続きの行は項目として読まれず値が途中で切れるため、1項目は1行に収めてください。",
    });
  }
  return findings;
}

/**
 * 「実行するデバイス」に端末が複数書かれているとき、手順の文頭で端末が決まっているか（#2052）。
 *
 * **複数書かれていること自体は指摘しない。** 手順ごとに`（サブPC）`と書いてあるなら、
 * 前提条件に両方の端末が並んでいるのは正しい情報である。落ちるのは**デバイスの無い手順**の方で、
 * そこは既定値が決まらない（`where.defaultDevice`が`null`）ため代行の対象から外れる。
 */
function checkDevice(guide: ReturnType<typeof parseManualStepGuide>): ManualStepBodyFinding[] {
  const found = matchManualStepDeviceNames(guide.where.device);
  if (found.length < 2) return [];

  const missing = guide.steps.filter((step) => step.device === null);
  if (missing.length === 0) return [];

  return [
    {
      rule: "multiple-devices",
      severity: "error",
      message: `「実行するデバイス」に端末が複数書かれている（${found.join("・")}）のに、どこで実行するか書かれていない手順が${missing.length}件あります。どの端末で実行するかが決まらないため、その手順は代行実行の対象から外れます。\`- [ ] （サブPC）…\`のように各手順の文頭へ端末を書いてください。`,
    },
  ];
}

/** `## やること`がチェックリストで割れているか・1手順のコードブロックが1つか */
function checkTodo(
  sections: ReturnType<typeof splitManualStepSections>,
  guide: ReturnType<typeof parseManualStepGuide>,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => entry.key === "todo");
  if (!section) return [];

  const findings: ManualStepBodyFinding[] = [];
  const hasChecklist = section.lines.some((line) => /^\s*[-*+]\s+\[[ xX]\]/.test(line));
  if (!hasChecklist) {
    // チェックリストが無い本文は節ごと1ステップになる（docs/multi-agent/labels.md）。
    // コードブロックが2つ以上あるなら、手順が2つ以上あるのに割れていないと分かる
    if (collectShellBlocks(section.lines.join("\n")).length >= 2) {
      findings.push({
        rule: "todo-not-checklist",
        severity: "warning",
        message: "`## やること`が`- [ ]`のチェックリストで割れていません。手順が2つ以上あるときは1手順＝1項目にしないと、画面では節まるごとが1ステップになり、途中まで進めた記録も残せません。",
      });
    }
    return findings;
  }

  const crowded = guide.steps.filter((step) => collectShellBlocks(step.markdown).length >= 2);
  if (crowded.length > 0) {
    findings.push({
      rule: "multiple-blocks-in-step",
      severity: "error",
      message: `1つの手順にコードブロックが2つ以上あります（${crowded.length}件）。「どれを実行したのか」がチェック1つに対応しないため、その手順は代行実行の対象から外れます。手順を分けるか、1つのブロックにまとめてください。`,
    });
  }
  return findings;
}

/**
 * `## 完了の確認方法`に、機械的に確かめられるコマンドが置かれているか（#2256）。
 *
 * **チェックを付ける操作と、実際に効いたかの検証は別物である。** `aide-bot`の立ち上げでは
 * 1Passwordへの登録がチェック済みのままcloseされ、初回デプロイが`DB_NAME is required`で
 * 落ちた（`guchi-apps/aide-bot#8`）。そのIssueの確認方法は「`dig`がIPを返し、左メニューに
 * 並べば完了」で、**登録されたかを見ていなかった**。
 *
 * 落ちる機能は2つ。確認節のコマンドは手作業アシスタントの代行実行（#1869）で流せ、
 * 読み取りだけなら定期巡回（#2008）が1日1回流して「完了済みの可能性」を画面へ出す。
 * 1つも無い本文は、そのどちらにも乗らない。
 *
 * **`warning`にとどめる。** 画面の操作でしか確かめようのない手作業（管理画面での設定など）は
 * 実際にあり、`error`にすると直しようのない指摘が正しい本文へ出続ける。
 */
function checkVerification(
  sections: ReturnType<typeof splitManualStepSections>,
  guide: ReturnType<typeof parseManualStepGuide>,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => entry.key === "verification");
  if (!section) return [];
  if (collectShellBlocks(section.lines.join("\n")).length > 0) return [];
  // 手順そのものにコマンドが1つも無い本文（画面での操作だけの手作業）は、確認もコマンドに
  // ならないのが自然。指摘するのは「実行するコマンドがあるのに確認だけ散文」のときに絞る
  if (guide.steps.every((step) => collectShellBlocks(step.markdown).length === 0)) return [];

  return [
    {
      rule: "verification-without-command",
      severity: "warning",
      message: "`## 完了の確認方法`に実行できるコマンド（```bash のコードブロック）がありません。ここに置いたコマンドだけが代行実行と定期巡回の対象になり、「チェックは付いているが実施されていない」を画面から拾えます。手順と1対1で、効いていなければ終了コードが0にならないコマンドを並べてください。",
    },
  ];
}

/**
 * 1Passwordを扱うコマンドが、サブPCで実際に通る書き方になっているか（#2401・#2417）。
 *
 * **サブPCでは`op`の書き込みが常に失敗する。** `~/.profile.local`（`guchi-apps/subpc`が配る
 * managed block）が`~/.config/op/service-account-token`を`OP_SERVICE_ACCOUNT_TOKEN`へ常時
 * exportしており、そのサービスアカウントは`apps`ボールトへ**read権限しか持たない**。`op`は
 * 環境変数のサービスアカウントを最優先するため、`op signin`しても勝てず、`op read`は通るのに
 * `op item edit`だけが`Couldn't update the item.`で落ちる（`knowledge/common-gotchas.md`）。
 * 代行実行も`subpc-dispatch-poller.sh`が`/bin/bash -lc`で起こす＝同じ`~/.profile.local`を
 * 読み直すので、人が実行しても代行させても結果は同じ。
 *
 * そこで規約を**「値の登録は1Passwordアプリで人が行い、CLIは同期と確認だけを担う」**に寄せた。
 * 書き込み権限つきのサービスアカウント（`~/.config/issue-deck/op-writer.env`）は
 * `provision-secret.sh`が`load_writer`で明示的に読み込むときだけ効く（#1874）ので、生の
 * `op item edit`をIssueへ書くと必ず落ちる。
 *
 * **どれも`warning`にとどめる。** read専用トークンを持たない端末（メインPC）では今の書き方でも
 * 動くため、`error`にすると直しようのない指摘が正しい本文へ出続ける。
 *
 * **`op signin`の判定は`findInteractiveCommand`をそのまま通す**（自前で文字列を見ない）。画面の
 * 代行可否と別の条件をここに持つと、「指摘は出ないのに押せない」が生まれる。
 */
function checkSecretCommands(
  sections: ReturnType<typeof splitManualStepSections>,
  guide: ReturnType<typeof parseManualStepGuide>,
): ManualStepBodyFinding[] {
  const commands = guide.steps.flatMap((step) => collectShellBlocks(step.markdown));
  const verification = sections.find((entry) => entry.key === "verification");
  if (verification) commands.push(...collectShellBlocks(verification.lines.join("\n")));

  const findings: ManualStepBodyFinding[] = [];

  const signin = commands.filter((command) => findInteractiveCommand(command) === "op signin");
  if (signin.length > 0) {
    findings.push({
      rule: "op-signin-in-command",
      severity: "warning",
      message: `\`op signin\`を含むコマンドが${signin.length}件あります。対話が要るコマンドはその項目まるごとが代行実行から外れるうえ、サブPCでは環境変数のサービスアカウントが優先されるためサインインしても書き込みは通りません。値の登録は1Passwordアプリで行い、GitHubのsecretへの同期は\`cd ~/apps/issue-deck && scripts/provision-secret.sh --repo <owner/repo> --key <KEY> --sync-only\`、読み取りは\`set -a; . ~/.config/issue-deck/op-writer.env; set +a; op read '<op://…>'\`で書いてください。`,
    });
  }

  // 生のopで1Passwordを書き換える手順。サブPCのread専用トークンでは人が実行しても落ちる
  const opWrite = commands.filter((command) => OP_WRITE_COMMAND.test(command));
  if (opWrite.length > 0) {
    findings.push({
      rule: "op-write-command",
      severity: "warning",
      message: `\`op\`で1Passwordを書き換えるコマンドが${opWrite.length}件あります。サブPCの全シェルには\`apps\`ボールトへ**read権限しか無い**サービスアカウントが常時exportされており（\`~/.profile.local\`）、\`op\`は\`op signin\`よりそちらを優先するため、このコマンドは代行実行でも人の実行でも\`Couldn't update the item.\`で落ちます。値の登録は1Passwordアプリ（ブラウザ・デスクトップ）で行う手順として書き、CLIには同期（\`scripts/provision-secret.sh … --sync-only\`）と確認（\`op read\`）だけを残してください。`,
    });
  }

  const localSync = commands.filter(
    (command) =>
      command.includes("sync-github-secrets.sh") &&
      !command.includes("op-writer.env") &&
      !command.includes("provision-secret.sh"),
  );
  if (localSync.length > 0) {
    findings.push({
      rule: "local-secret-sync",
      severity: "warning",
      message: `\`scripts/sync-github-secrets.sh\`をそのまま実行するコマンドが${localSync.length}件あります。代行実行のシェルには1Passwordのセッションが無いため、サブPCで代行すると「opにサインインしていません」で失敗します。\`scripts/provision-secret.sh --repo <owner/repo> --key <KEY> --sync-only\`（書き込み用トークンを読み込んで同じ同期を行う）へ書き換えるか、画面の「シークレットの同期」から実行してください。`,
    });
  }

  return findings;
}

/** `## 関連`の参照が`#番号`形式か（URLは参照抽出に一致しない） */
function checkRelatedReferences(
  sections: ReturnType<typeof splitManualStepSections>,
  repositoryFullName?: string,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => normalize(entry.heading ?? "").includes("関連"));
  if (!section) return [];

  const urls: string[] = [];
  for (const line of section.lines) {
    // 同じ行に`#番号`があるなら参照は拾えている。URLは補足として置かれているだけ
    if (/(?:[\w.-]+\/[\w.-]+)?#\d+/.test(line)) continue;
    for (const match of line.matchAll(GITHUB_REFERENCE_URL)) {
      const [, owner, repo, number] = match;
      const full = `${owner}/${repo}`;
      urls.push(full === repositoryFullName ? `#${number}` : `${full}#${number}`);
    }
  }
  if (urls.length === 0) return [];

  return [
    {
      rule: "reference-not-hash-form",
      severity: "error",
      message: `\`## 関連\`の参照がURLで書かれています。\`manual-step-prerequisites.ts\`の参照抽出は\`#番号\`（別リポジトリは\`owner/repo#番号\`）にしか一致せず、実施順序の表示から落ちます。${urls.join("・")} と書き換えてください。`,
    },
  ];
}

/**
 * 指摘をIssueコメントの本文へ組み立てる。
 *
 * **文面をここに置くのは、規則と直し方が同じ場所にあるほうが古びないため。** ワークフロー側の
 * YAMLで組み立てると、規則を足したときに文面だけ取り残される。
 *
 * 先頭のマーカーで、次に本文が編集されたときに同じコメントを見つけて更新・削除する
 * （`reusable-issue-labels.yml`の`manual-step-body-check`ジョブ）。
 */
export const MANUAL_STEP_BODY_CHECK_MARKER = "<!-- issue-deck-source:manual-step-body-check -->";

const TEMPLATE_LINK =
  "https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/manual-step-body-template.md";

export function renderManualStepBodyCheckComment(
  findings: ManualStepBodyFinding[],
): string | null {
  if (findings.length === 0) return null;

  // errorを先に出す。画面の機能が落ちているものから直してほしい
  const ordered = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );

  return [
    MANUAL_STEP_BODY_CHECK_MARKER,
    "⚠️ 本文の書式が、issue-deckの手作業アシスタントが読む形から外れています。**このIssueの起票を止めるものではありません**が、直さないと下記の機能がそのIssueでは働きません。",
    "",
    ...ordered.map((finding) => `- ${finding.severity === "error" ? "❌" : "⚠️"} ${finding.message}`),
    "",
    `本文を編集するとこのコメントは自動で更新され、指摘が無くなれば消えます。雛形は [manual-step-body-template.md](${TEMPLATE_LINK}) にあります。`,
  ].join("\n");
}
