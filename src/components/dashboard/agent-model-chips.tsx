import { Loader2, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";

import {
  describeClaudeModel,
  describeCodexModel,
  parseClaudeLocalModel,
  parseCodexLocalModel,
} from "@/lib/app-settings";
import type { ModelPickResult } from "@/lib/claude/model-pick";
import { CODEX_LIMITATIONS, type DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { cn } from "@/lib/utils";

/**
 * エージェント・モデルの選択チップ。「実装を開始」ダイアログ（`start-implementation-dialog.tsx`）と
 * 「別のAIで続ける」ダイアログ（`session-handoff-dialog.tsx`）で共有する（#3496）。
 * 見た目の正はここに1つだけ置き、2つのダイアログで並びと配色を揃える。
 */

/**
 * エージェントの選択肢1件（#2505）。**オプションのチップ（`StartOptionChip`）と同じ形にする。**
 *
 * 実行先（アイコン中心・正方形のタイル）とわざと形を変えているのは、実行先の並びと
 * 見分けがつかなくなるのを避けるため。**押した結果は選択（ラジオ）で、オプションのような
 * ON/OFFではない**ので、チェックの代わりに選択中の枠と背景で示す。
 */
export function AgentChip({
  icon: Icon,
  label,
  isDefault,
  selected,
  onSelect,
  hint,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  /** 既定のエージェントか。選んでいないときだけ「既定」と添える */
  isDefault: boolean;
  selected: boolean;
  onSelect: () => void;
  /**
   * 「既定」の代わりに右端へ添える短い補足（「5時間枠 12%使用」など。#3496）。
   * 引き継ぎダイアログが、選ぶ前にそのエージェントの枠の様子を見せるために使う。
   */
  hint?: string | null;
  /** 選べないときはtrue（枠を使い切っているエージェントなど）。押せず、薄く出す */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-[46px] items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-left",
        selected ? "border-primary bg-accent" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
      )}
    >
      <Icon
        className={cn("size-4 shrink-0", selected ? "text-foreground" : "text-muted-foreground")}
      />
      <span className="text-xs font-medium leading-tight">{label}</span>
      {hint ? (
        <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>
      ) : (
        isDefault &&
        !selected && <span className="ml-auto text-[11px] text-muted-foreground">既定</span>
      )}
    </button>
  );
}

/**
 * モデルの選択肢1件（#2717・#2723）。**2行で、名前の下に「向いている作業」を出す。**
 *
 * 以前は名前と1件あたりの目安金額を3列で並べていたが、金額は何の金額か画面から決まらず、
 * FableとOpusがほぼ同額のため見比べても選べなかった（#2723）。**押す理由は用途**なので
 * そちらを出し、幅を確保するために3列→2列にした（1枚110px→172px前後）。「設定に従う」を
 * 削除した#3106で選ぶ3つが残り、**再び3列**に戻した（スマホでは2行目が折り返す）。
 * Codexは4つ選べるため、スマホ幅だけ横2×縦2に変える（#3252。列数の分岐はグリッド側のclassNameで行う）。
 *
 * 角を`rounded-full`にしないのは2行になったため。先頭のアイコン（`icon`）を取るのは「おまかせ」
 * （全幅）だけで、ここが**issue-deckが選ぶ唯一の選択肢**であることを他の3枚と見分けるために付ける。
 *
 * **`picked`は「おまかせ」が選んだモデル**（#3154）。手動で選んだ`selected`より薄い枠と背景に、
 * 名前の横の小さなスパークル（「おまかせ」のアイコンと同じ）を付ける。濃いか薄いかで
 * 「自分で選んだ／おまかせが選んだ」を見分ける。**`aria-checked`は変えない**（選んでいるのは
 * 「おまかせ」のチップで、ここは選ばれた結果を示すだけ）。押せば手動選択になり、印は外れる。
 */
export function ModelChip({
  icon: Icon,
  label,
  fit,
  selected,
  picked = false,
  probability,
  onSelect,
}: {
  icon?: LucideIcon;
  label: string;
  /** 2行目に出す「向いている作業」 */
  fit: string;
  selected: boolean;
  /** 「おまかせ」がこのモデルを選んだ状態（手動で選んだときとは別の見た目にする） */
  picked?: boolean;
  /** Jevによる候補別の確率。無い経路では表示しない */
  probability?: number;
  onSelect: () => void;
}) {
  const highlighted = selected || picked;
  const percent = probability === undefined ? null : toPercent(probability);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      title={picked ? "おまかせが選んだモデル" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-h-[46px] items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left",
        selected
          ? "border-primary bg-accent"
          : picked
            ? "border-primary/40 bg-accent/60"
            : "hover:bg-accent",
      )}
    >
      {Icon && (
        <Icon
          aria-hidden
          className={cn("size-4 shrink-0", selected ? "text-foreground" : "text-muted-foreground")}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1 text-xs leading-tight font-semibold">
          {label}
          {picked && (
            <>
              <Sparkles aria-hidden className="size-3 shrink-0 opacity-80" />
              <span className="sr-only">（おまかせで選択）</span>
            </>
          )}
        </span>
        <span
          className={cn(
            "text-[11px] leading-tight",
            highlighted ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {fit}
        </span>
        {percent !== null && (
          <span className="mt-1 flex items-center gap-1.5 border-t pt-1.5">
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-muted-foreground/60"
                style={{ width: `${percent}%` }}
              />
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{percent}%</span>
          </span>
        )}
      </span>
    </button>
  );
}

/** APIからの確率を表示用の0〜100整数へ丸める。範囲外の値でもUIを崩さない */
function toPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** 「おまかせ」が選んだモデルの表示名。エージェントの候補に無い値なら、そのまま出す */
export function describePickedModel(agent: DispatchAgent, model: string): string {
  if (agent === "codex") {
    const codex = parseCodexLocalModel(model);
    return codex ? describeCodexModel(codex) : model;
  }
  const claude = parseClaudeLocalModel(model);
  return claude ? describeClaudeModel(claude) : model;
}

/**
 * 「おまかせ」の判定の様子（#2723）。**判定中・結果・失敗の3つを同じ場所に出す。**
 *
 * 結果には**必ず理由を添える。** 選んだのはissue-deckで、押した人はまだ何も知らない状態から
 * 「Opusで起動します」とだけ言われても、妥当なのか判断できない。
 *
 * ルールへ倒れた場合（AIを呼べなかった・応答を読めなかった）はその旨も出す。同じ「選ばれた」
 * でも、AIが内容を読んだのか、ラベルと分量だけで決めたのかで、結果の重みが違う。
 *
 * **Jevで選んだときだけは、結果の行を出さない**（#3255）。Jevは文章を返さないので、出せるのは
 * コードが組み立てた説明（「難しさ◯/3・原因の調査から始まる見込み◯%と判定したためです」）と
 * 確信度だけだった。**この2つはモデルの選択に使っておらず**、選ばれた根拠として読むと誤りに
 * なる。Jevの根拠は候補ごとの確率で、そちらは各モデルカードに出ている（#3231）。
 */
export function ModelPickNotice({
  agent,
  isPicking,
  result,
  error,
}: {
  /** どのエージェントの判定か。選ばれたモデルの名前（`Opus`・`Sol`）の引き方が変わる（#3192） */
  agent: DispatchAgent;
  isPicking: boolean;
  result: ModelPickResult | null;
  error: string | null;
}) {
  if (isPicking) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
        Issueの内容からモデルを選んでいます…
      </p>
    );
  }
  if (result) {
    // Jevは説明を出さない（#3255）。選ばれたモデルはカードの印、根拠は確率バーが示す
    if (result.source === "jev") return null;
    const modelName = describePickedModel(agent, result.model);
    return (
      <div className="flex items-start gap-1 text-xs text-muted-foreground">
        {/* 2行までにする（#3119）。理由はAIが書く長文になりがちで、全文を出すとスマホで
            ダイアログが縦に伸びる。**理由を出す方針は変えない**ので、全文は`title`に残す */}
        <p
          className="line-clamp-2 min-w-0"
          title={`${modelName}${result.reason ? ` — ${result.reason}` : "で起動します。"}`}
        >
          <span className="font-medium text-foreground">{modelName}</span>
          {result.reason ? ` — ${result.reason}` : "で起動します。"}
          {result.source === "rule" && "（AIを呼べなかったため、ラベルと分量から選びました）"}
        </p>
      </div>
    );
  }
  if (error) {
    return <p className="text-xs text-muted-foreground">{error}。別のモデルを選んでください。</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Issueのタイトル・本文・ラベル・承認済みの計画から、issue-deckがモデルを選びます。
    </p>
  );
}

/**
 * Codex CLIを選んだ時点で出す注意（#2505）。**選んだ時点で出す**——Codexでは入力待ちの通知・質問への
 * 回答・Remote Controlが動かない（#2509で停止の通知、#2545で計画の承認パネルは動くようになった）。
 * 起動してから気づくと、届かない通知を待ち続けるか不具合として報告することになる。文面の正は
 * `CODEX_LIMITATIONS`。配色は確認待ちの表示（`CheckUserReasonNotice`）に合わせてamberで揃える。
 * **Claude Codeでは何も出さない**（#3119。通知・承認・Remote Controlが使えるのは既定の動作で、
 * 毎回読ませる文ではない）。「実装を開始」と「別のAIで続ける」（#3496）で共有する。
 */
export function CodexLimitationsNotice() {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-amber-500/15 px-2.5 py-2 ring-1 ring-inset ring-amber-500/40">
      <p className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        Codex CLIでは画面からの連携が一部効きません
      </p>
      <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
        {CODEX_LIMITATIONS.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </div>
  );
}
