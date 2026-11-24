"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { DISPATCH_AGENT_OPTIONS, type AiExecutionProvider } from "@/lib/app-settings";
import { cn } from "@/lib/utils";

/**
 * AI・モデル区分の見た目の部品（#5643）。
 *
 * 設定は「①共通（プロバイダー）→ ②実行場所ごと（ローカル・GitHub Actions・アプリ内AI）→
 * ③工程ごとの個別設定」の順に並べ、どのカードにも「どこで効くか」を見出しのチップで出す。
 * 値の保持・保存は`ExecutionSettingsSection`が持ち、ここは描画だけを持つ。
 */

export function providerName(provider: AiExecutionProvider) {
  return provider === "claude" ? "Claude" : "Codex";
}

type ChipTone = "primary" | "amber" | "green" | "violet" | "muted";

const CHIP_TONES: Record<ChipTone, string> = {
  primary: "bg-primary/10 text-primary",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  muted: "border bg-muted text-muted-foreground",
};

export function ScopeChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold", CHIP_TONES[tone])}>
      {children}
    </span>
  );
}

function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 設定欄へ移動してフォーカスする。畳まれた「工程ごとの個別設定」の中にある欄は、先に開いてから移る。
 * 一覧表の「設定へ」・見出しチップ・自動化区分からのリンクで共有する。
 */
export function scrollToSetting(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const details = target.closest("details") ?? target.querySelector("details");
  if (details && !details.open) details.open = true;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

export type AiSectionNavItem = { id: string; label: string };

/** 各カードへ飛ぶ見出しチップ。縦に長い区分を、スクロールせずに目的のカードへ移れるようにする */
export function AiSectionNav({ items }: { items: readonly AiSectionNavItem[] }) {
  return (
    <nav aria-label="AI・モデル設定の見出し" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => scrollToSetting(item.id)}
          className="shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** ① 共通：AI実行プロバイダー。すべての実行場所の既定を一括で切り替える */
export function ProviderCard({
  provider, savedProvider, onChange,
}: { provider: AiExecutionProvider; savedProvider: AiExecutionProvider; onChange: (provider: AiExecutionProvider) => void }) {
  const dirty = provider !== savedProvider;
  return (
    <section id="ai-provider-settings" tabIndex={-1} aria-labelledby="ai-execution-provider" className="scroll-mt-2 rounded-lg border bg-card p-4 outline-none">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <StepNumber>1</StepNumber>
            <h3 id="ai-execution-provider" className="font-medium">AI実行プロバイダー</h3>
            <ScopeChip tone="muted">すべての場所に効く</ScopeChip>
          </div>
          <p className="text-xs text-muted-foreground">
            ローカル・GitHub Actions・アプリ内AIの既定を一括で切り替えます。③で個別に固定した工程は変わりません。
          </p>
        </div>
        <div role="group" aria-label="AI実行プロバイダー" className="grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-grid">
          {DISPATCH_AGENT_OPTIONS.map((option) => {
            const selected = provider === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange(option.value)}
                className={cn(
                  "rounded-md px-6 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {providerName(option.value)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {dirty
          ? <><span className="font-semibold text-amber-700 dark:text-amber-300">未保存</span>：保存すると{providerName(provider)}に切り替わります。</>
          : <>現在: {providerName(provider)}。</>}
        切替は次に開始する処理から適用されます。
      </p>
    </section>
  );
}

/** ②・③の見出し付きカード。見出しの横に「どこで効くか」のチップを置く */
export function SettingsCard({
  id, step, icon: Icon, iconClassName, title, scope, description, aside, children,
}: {
  id: string;
  step: string;
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  scope?: ReactNode;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section id={id} tabIndex={-1} aria-labelledby={titleId} className="scroll-mt-2 rounded-lg border bg-card p-4 outline-none">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-md", iconClassName)}>
            <Icon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <StepNumber>{step}</StepNumber>
              <h3 id={titleId} className="font-medium">{title}</h3>
              {scope}
            </div>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {aside && <div className="w-full shrink-0 sm:w-56">{aside}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * 「Claudeのとき／Codexのとき」の2列。いま実際に使われる側を枠で強調し、もう一方は
 * 「切り替えたときに使う」値として薄く見せる（値は保持されるので、切り替えて戻しても失われない）。
 * スマホでは使われる側を上にして縦に積む。
 */
export function ProviderColumns({
  active, claude, codex,
}: { active: AiExecutionProvider; claude: ReactNode; codex: ReactNode }) {
  const columns = [
    { provider: "claude" as const, title: "Claude Code のとき", body: claude },
    { provider: "codex" as const, title: "Codex CLI のとき", body: codex },
  ];
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {columns.map((column) => {
        const isActive = column.provider === active;
        return (
          <div
            key={column.provider}
            data-active={isActive}
            className={cn(
              "flex flex-col gap-3 rounded-md border p-3",
              isActive ? "order-first border-primary ring-1 ring-primary sm:order-none" : "bg-muted/20",
            )}
          >
            <div className="flex items-center justify-between gap-2 text-xs font-semibold">
              <span>{column.title}</span>
              {isActive ? <ScopeChip tone="primary">いま使用中</ScopeChip> : <ScopeChip tone="muted">切替時に使用</ScopeChip>}
            </div>
            {column.body}
          </div>
        );
      })}
    </div>
  );
}

/** ラベル・常時表示の短い説明・入力欄の組。変更した欄は橙の枠で示す */
export function SettingField({
  id, label, hint, help, changed, badge, children, className,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  help?: ReactNode;
  changed?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-changed={changed || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 [&[data-changed]_[data-slot=select-trigger]]:border-amber-500",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <InfoHint label={label}>{hint}</InfoHint>}
        {badge}
      </div>
      {help && <p className="-mt-1 text-[11px] text-muted-foreground">{help}</p>}
      {children}
    </div>
  );
}

/**
 * 区分の下に固定する保存バー。縦に長い区分でも、未保存の変更があることと保存ボタンが常に見える。
 * 未保存の項目名を出し、元に戻すで編集前の値へ戻せる。
 */
export function StickySaveBar({
  dirtyLabels, isSubmitting, canSave, isSaved, onSave, onReset,
}: {
  dirtyLabels: readonly string[];
  isSubmitting: boolean;
  canSave: boolean;
  isSaved: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const dirty = dirtyLabels.length > 0;
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Button onClick={onSave} disabled={isSubmitting || !canSave || !dirty}>
        {isSubmitting ? "保存中..." : "保存"}
      </Button>
      <p className="min-w-0 flex-1 text-xs" aria-live="polite">
        {dirty && !isSubmitting && (
          <span className="text-amber-700 dark:text-amber-300">
            未保存の変更があります（{dirtyLabels.length}件：{dirtyLabels.join("・")}）
          </span>
        )}
        {isSaved && !dirty && <span className="text-muted-foreground">保存しました</span>}
      </p>
      {dirty && (
        <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={isSubmitting}>
          元に戻す
        </Button>
      )}
    </div>
  );
}
