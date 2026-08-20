import {
  resolveManualStepExecutionRejection,
  type DispatchHostView,
  type ManualStepExecutionRejection,
} from "@/lib/dispatch/dispatch-job";
import {
  extractManualStepCommands,
  extractVerificationCommands,
  findInteractiveCommand,
  isSubpcManualStepDevice,
  type ManualStepCommandKind,
} from "@/lib/manual-step-command";
import { parseManualStepGuide, type ManualStepGuide } from "@/lib/manual-step-guide";

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
  /** 実行するコマンド。代行できない項目では`null` */
  command: string | null;
  /** 手順のチェック状態。確認にはチェックが無いので常に`false` */
  checked: boolean;
  /**
   * このコマンドに含まれる、対話が要るコマンドの表記（#2025）。`null`なら無い。
   * **止まった理由を画面へ出すために持ち回る**（`rejection`だけでは何が引っかかったのか
   * 分からず、人はどのコマンドを自分で実行すればよいのか判断できない）。
   */
  interactiveCommand: string | null;
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
    host: Pick<DispatchHostView, "online" | "manualStepCapable"> | null | undefined;
    isManualStepIssue: boolean;
    /** そのIssueに未処理の代行実行があるか（`activeKey`はIssue単位） */
    hasActiveJob?: boolean;
  },
): ManualStepRunPlan {
  const isSubpcDevice = isSubpcManualStepDevice(guide.where.device);
  const stepCommands = new Map(
    extractManualStepCommands(body, guide).map((entry) => [entry.stepLine, entry.command]),
  );
  const steps = guide.steps.filter((step) => step.line !== null);
  const verifications = extractVerificationCommands(body, guide);

  const reject = (
    hasCommand: boolean,
    interactiveCommand: string | null,
  ): ManualStepExecutionRejection | null =>
    resolveManualStepExecutionRejection({
      host: context.host,
      isManualStepIssue: context.isManualStepIssue,
      isSubpcDevice,
      hasCommand,
      interactiveCommand,
      hasActiveJob: context.hasActiveJob ?? false,
    });

  const entries: ManualStepRunEntry[] = [
    ...steps.map((step, index): ManualStepRunEntry => {
      const command = stepCommands.get(step.line as number) ?? null;
      const interactiveCommand = findInteractiveCommand(command);
      return {
        kind: "step",
        order: index + 1,
        total: steps.length,
        line: step.line as number,
        text: step.text,
        command,
        checked: step.checked,
        interactiveCommand,
        rejection: reject(command !== null, interactiveCommand),
      };
    }),
    ...verifications.map((entry, index): ManualStepRunEntry => {
      const interactiveCommand = findInteractiveCommand(entry.command);
      return {
        kind: "verification",
        order: index + 1,
        total: verifications.length,
        line: entry.stepLine,
        text: verifications.length > 1 ? `完了の確認 ${index + 1}` : "完了の確認",
        command: entry.command,
        checked: false,
        interactiveCommand,
        rejection: reject(true, interactiveCommand),
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
