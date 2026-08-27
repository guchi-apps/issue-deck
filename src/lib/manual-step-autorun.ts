import {
  resolveManualStepExecutionRejection,
  type DispatchHostView,
  type ManualStepExecutionRejection,
} from "@/lib/dispatch/dispatch-job";
import {
  extractManualStepCommands,
  extractVerificationCommands,
  fillManualStepPlaceholders,
  findInteractiveCommand,
  findPlaceholder,
  isSubpcManualStepDevice,
  listManualStepPlaceholders,
  type ManualStepCommandKind,
} from "@/lib/manual-step-command";
import {
  parseManualStepGuide,
  resolveManualStepDevice,
  type ManualStepGuide,
} from "@/lib/manual-step-guide";

/**
 * 手作業アシスタント（#1826）を、承認1回で最後まで流すための実行計画（#1869）。
 *
 * これまでは手順ごとに「承認して実行」を押していた（#1828）。押す1回の射程を
 * 「1手順」から「1つの手作業Issueの手順列＋完了の確認」へ広げるにあたって、
 * **何が実行され、何が実行されないのか**を押す前に1つの並びとして出せるようにする。
 *
 * ここは解析と判定だけの純粋関数で、実行そのものは既存の経路
 * （`POST /api/dispatch` → `enqueueManualStepJob` → poller）をそのまま使う。
 * **代行できるかどうかの判定は`resolveManualStepExecutionRejection`をそのまま呼ぶ**——
 * ここに条件を書き足すと、画面で押せるのにAPIが拒否する（その逆も）が生まれる。
 */

/** 実行計画の1件（手順1つ、または完了の確認のコマンド1つ） */
export type ManualStepRunEntry = {
  kind: ManualStepCommandKind;
  /** その種別の中での通し番号（1始まり） */
  order: number;
  /** その種別の総数 */
  total: number;
  /**
   * 本文の行番号（1始まり）。手順なら`- [ ]`の行、確認ならコードブロックの開きフェンスの行
   * （`ManualStepCommand.stepLine`と同じ）。ジョブ・画面・pollerはこの番号で同じものを指す。
   */
  line: number;
  /** 一覧に出す見出し */
  text: string;
  /**
   * 実行するコマンド。代行できない項目では`null`。
   *
   * **`<…>`が入ったままのテンプレート**（#2403）。承認・照合・ジョブへの保存はすべてこちらで、
   * 人が埋めた値を差し込んだものは`filledCommand`に持つ。
   */
  command: string | null;
  /**
   * 人が埋めた値を差し込んだコマンド（#2403）。埋める値が無ければ`command`と同じ。
   *
   * **画面に出す・コピーさせるのはこちら**で、値はシェルの引用で包まれている。
   * ジョブへ載せるのは`command`（テンプレート）のままで、こちらは送らない。
   */
  filledCommand: string | null;
  /**
   * このコマンドに含まれる、名前の付くプレースホルダの表記（#2403。`<控えたkey>`）。
   *
   * **画面が埋める欄を出すためのもので、代行の可否には使わない。** 可否は差し込んだ後の
   * 文字列に`findPlaceholder`（4種）を掛けた`placeholder`が持つ——ここが空でも
   * `***`・`…`・`xxx`が残っていることがある。
   */
  placeholders: string[];
  /**
   * この項目を実行する端末（#2052）。手順に書かれていればそれ、無ければ手作業の既定値
   * （`resolveManualStepDevice`）。**代行の可否はこの値で決まる**ので、画面の理由文・チップも
   * ここを見る（Issue単位の`where.device`を各所で読み直すと、判定と表示がずれる）。
   */
  device: string | null;
  /** 手順のチェック状態。確認にはチェックが無いので常に`false` */
  checked: boolean;
  /**
   * このコマンドに含まれる、対話が要るコマンドの表記（#2025）。`null`なら無い。
   * **止まった理由を画面へ出すために持ち回る**（`rejection`だけでは何が引っかかったのか
   * 分からず、人はどのコマンドを自分で実行すればよいのか判断できない）。
   */
  interactiveCommand: string | null;
  /**
   * このコマンドに含まれる、人が値を埋めるプレースホルダの表記（#2051）。`null`なら無い。
   * `interactiveCommand`と同じく、**止まった理由を画面へ出すために持ち回る**。
   */
  placeholder: string | null;
  /** 代行できない理由。`null`なら押せる */
  rejection: ManualStepExecutionRejection | null;
};

export type ManualStepRunPlan = {
  entries: ManualStepRunEntry[];
  /** いま自動実行で流せる件数（未チェックかつ代行できるもの） */
  runnable: number;
  /** 人が自分で実行する件数（未チェックで代行できないもの） */
  blocked: number;
};

/**
 * 本文から実行計画を作る。並びは**実行する順**（手順1..n → 完了の確認）。
 *
 * `hasTemplate`でない本文（`## やること`がチェックリストになっていない）には手順が無いので、
 * 確認だけが並ぶ。承認の単位と実行の単位をずらさないため、節全体をまとめて1コマンドとして
 * 実行することはしない（`extractManualStepCommands`と同じ方針）。
 */
export function buildManualStepRunPlan(
  body: string | null,
  guide: ManualStepGuide = parseManualStepGuide(body),
  context: {
    host:
      | Pick<DispatchHostView, "online" | "manualStepCapable" | "manualStepValuesCapable">
      | null
      | undefined;
    isManualStepIssue: boolean;
    /** そのIssueに未処理の代行実行があるか（`activeKey`はIssue単位） */
    hasActiveJob?: boolean;
    /**
     * 人が埋めたプレースホルダの値（#2403。`<控えたkey>`の表記 → 値）。
     *
     * **渡すと、埋まった項目は代行できる側へ変わる**（レールの印・承認パネル・自動実行の
     * 件数がまとめて追従する）。渡さない経路——サーバー側の自動実行（`lib/manual-step-run.ts`）
     * ——では、これまでどおり穴の空いた項目で止まる（サーバーは値を持っていない）。
     */
    values?: Readonly<Record<string, string>> | null;
  },
): ManualStepRunPlan {
  const stepCommands = new Map(
    extractManualStepCommands(body, guide).map((entry) => [entry.stepLine, entry.command]),
  );
  const steps = guide.steps.filter((step) => step.line !== null);
  const verifications = extractVerificationCommands(body, guide);

  // 代行の可否は**項目ごと**に判定する（#2052）。「ブラウザの手順は人、サブPCの手順は代行」が
  // 同じ手作業の中で混在しうるため、Issue単位で1回だけ判定すると必ずどちらかを取り違える
  const reject = (
    device: string | null,
    hasCommand: boolean,
    interactiveCommand: string | null,
    placeholder: string | null,
    usesPlaceholderValues: boolean,
  ): ManualStepExecutionRejection | null =>
    resolveManualStepExecutionRejection({
      host: context.host,
      isManualStepIssue: context.isManualStepIssue,
      isSubpcDevice: isSubpcManualStepDevice(device),
      hasCommand,
      interactiveCommand,
      placeholder,
      usesPlaceholderValues,
      hasActiveJob: context.hasActiveJob ?? false,
    });

  /**
   * 値を差し込んだ結果と、差し込みが起きたかどうか（#2403）。
   *
   * **穴の有無を見るのは差し込んだ後の文字列**で、判定は`findPlaceholder`（4種）に任せる。
   * 「`<…>`を全部埋めたか」で代用すると、`***`・`…`・`xxx`が残ったまま素通りする。
   */
  const fill = (command: string | null): { filled: string | null; used: boolean } => {
    if (command === null) return { filled: null, used: false };
    const values = context.values;
    if (!values) return { filled: command, used: false };
    const filled = fillManualStepPlaceholders(command, values);
    return { filled, used: filled !== command };
  };

  const entries: ManualStepRunEntry[] = [
    ...steps.map((step, index): ManualStepRunEntry => {
      const command = stepCommands.get(step.line as number) ?? null;
      const { filled, used } = fill(command);
      const interactiveCommand = findInteractiveCommand(command);
      const placeholder = findPlaceholder(filled);
      const device = resolveManualStepDevice(guide.where, step);
      return {
        kind: "step",
        order: index + 1,
        total: steps.length,
        line: step.line as number,
        text: step.text,
        command,
        filledCommand: filled,
        placeholders: listManualStepPlaceholders(command),
        device,
        checked: step.checked,
        interactiveCommand,
        placeholder,
        rejection: reject(device, command !== null, interactiveCommand, placeholder, used),
      };
    }),
    // **完了の確認に手順ごとのデバイスは無い。** `## 完了の確認方法`は節ひとつで、どの端末で
    // 確かめるかを書く場所がないため、手作業の既定値をそのまま使う
    ...verifications.map((entry, index): ManualStepRunEntry => {
      const { filled, used } = fill(entry.command);
      const interactiveCommand = findInteractiveCommand(entry.command);
      const placeholder = findPlaceholder(filled);
      const device = guide.where.defaultDevice;
      return {
        kind: "verification",
        order: index + 1,
        total: verifications.length,
        line: entry.stepLine,
        text: verifications.length > 1 ? `完了の確認 ${index + 1}` : "完了の確認",
        command: entry.command,
        filledCommand: filled,
        placeholders: listManualStepPlaceholders(entry.command),
        device,
        checked: false,
        interactiveCommand,
        placeholder,
        rejection: reject(device, true, interactiveCommand, placeholder, used),
      };
    }),
  ];

  const pending = entries.filter((entry) => !entry.checked);
  return {
    entries,
    runnable: pending.filter((entry) => entry.rejection === null).length,
    blocked: pending.length - pending.filter((entry) => entry.rejection === null).length,
  };
}

/**
 * 次に自動実行する項目を選ぶ。
 *
 * **チェック済みの手順は飛ばす**（人が手元で実行して「実行した・次へ」を押した手順、
 * 前回の自動実行で終わった手順のどちらも対象外）。**確認にはチェックが無い**ので、
 * この実行で流し終えた行を`doneLines`で受け取って飛ばす。
 *
 * 代行できない項目（`rejection !== null`）も返す。**そこで止まって人へ返すのは呼び出し側の仕事**
 * で、ここが飛ばしてしまうと、人が実行する前提の手順を跨いで次のコマンドが走る。
 */
export function findNextManualStepEntry(
  plan: ManualStepRunPlan,
  doneLines: ReadonlySet<number> = new Set(),
): ManualStepRunEntry | null {
  return (
    plan.entries.find((entry) => !entry.checked && !doneLines.has(entry.line)) ?? null
  );
}

/** 実行計画の1件を引く（画面が開いている手順・確認に対応する行を出すのに使う） */
export function findManualStepEntry(
  plan: ManualStepRunPlan,
  line: number,
): ManualStepRunEntry | null {
  return plan.entries.find((entry) => entry.line === line) ?? null;
}

/**
 * 「承認してN件を自動実行」のNの説明。**手順と確認の内訳まで出す**——押す人にとって
 * 「3件」の中身が手順3件なのか、手順2件＋確認1件なのかは、押してよいかの判断に効く。
 */
export function describeManualStepRunPlan(plan: ManualStepRunPlan): string {
  const pending = plan.entries.filter((entry) => !entry.checked && entry.rejection === null);
  const steps = pending.filter((entry) => entry.kind === "step").length;
  const verifications = pending.length - steps;
  if (pending.length === 0) return "自動実行できる項目はありません";
  if (verifications === 0) return `手順${steps}件`;
  if (steps === 0) return `完了の確認${verifications}件`;
  return `手順${steps}件・確認${verifications}件`;
}
