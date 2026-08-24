"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Rocket,
  Send,
  TriangleAlert,
} from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useNewAppLaunch, type PreflightResult } from "@/hooks/use-new-app-launch";
import {
  CONSULT_OPENING_MESSAGE,
  MAX_CONSULT_TURNS,
  countConsultTurns,
  type ConsultMessage,
  type NewAppDraft,
} from "@/lib/claude/new-app-consult";
import { EXISTING_LAUNCH_ISSUE_REASON_LABELS } from "@/lib/new-app/launch-marker";
import {
  buildNewAppPlan,
  type NewAppArtifact,
  type NewAppCreatedRef,
  type NewAppPlanOptions,
} from "@/lib/new-app/plan";
import {
  NEW_APP_AUTH_LABELS,
  NEW_APP_BASE_DOMAIN,
  NEW_APP_KINDS,
  NEW_APP_ORG,
  NEW_APP_THEME_COLOR_PRESETS,
  appearanceSummary,
  databaseNameFor,
  emptyNewAppSpec,
  hostnameFor,
  isAppearanceDefault,
  newAppKindProfile,
  supportsUnattendedScreenshot,
  publicUrlFor,
  validateNewAppSpec,
  NEW_APP_SPEC_ERROR_MESSAGES,
  type NewAppAuth,
  type NewAppKind,
  type NewAppSpec,
} from "@/lib/new-app/spec";
import { cn } from "@/lib/utils";

/**
 * 新規アプリの立ち上げ（#2188）。
 *
 * **相談（Step 0）と設定（Step 1〜3）を同じ画面に混ぜない。** 会話しながら横で仕様が
 * 埋まっていく形も考えたが、スマホでは会話と設定の両方を1画面に収めることになる。
 * 相談を先に終えて値を引き渡す形なら、どちらのステップも393pxに素直に収まる。
 *
 * **押す前に「自動 / 代行できる / あなたが実行」の内訳を出す**（Step 3）。この機能は
 * 「ほぼ全自動」を謳うが、DNSのAレコードのようにAPIが無くて自動化できないものが残る。
 * どこまでが自動かを実行前に読み取れるようにしておく。
 */

type WizardStep = "consult" | "basic" | "placement" | "confirm" | "done";

const STEP_LABELS: { key: WizardStep; label: string; badge: string }[] = [
  { key: "consult", label: "相談", badge: "0" },
  { key: "basic", label: "基本", badge: "1" },
  { key: "placement", label: "配置", badge: "2" },
  { key: "confirm", label: "確認", badge: "3" },
];

const AUTOMATION_STYLES: Record<NewAppArtifact["automation"], { label: string; className: string }> = {
  auto: {
    label: "自動",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  proxy: {
    label: "代行できる",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  manual: {
    label: "あなたが実行",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

type NewAppDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewAppDialog({ open, onOpenChange }: NewAppDialogProps) {
  const [step, setStep] = useState<WizardStep>("consult");
  const [spec, setSpec] = useState<NewAppSpec>(emptyNewAppSpec);
  const [messages, setMessages] = useState<ConsultMessage[]>([
    { role: "assistant", content: CONSULT_OPENING_MESSAGE },
  ]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<NewAppDraft | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [created, setCreated] = useState<NewAppCreatedRef[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [launchFailed, setLaunchFailed] = useState(false);

  const { consult, preflight: runPreflight, launch, isConsulting, isChecking, isLaunching, error, setError } =
    useNewAppLaunch();

  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // jsdomは`scrollIntoView`を持たないので、有無を見てから呼ぶ
    chatEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages]);

  const reset = useCallback(() => {
    setStep("consult");
    setSpec(emptyNewAppSpec());
    setMessages([{ role: "assistant", content: CONSULT_OPENING_MESSAGE }]);
    setInput("");
    setDraft(null);
    setPreflight(null);
    setCreated([]);
    setLaunchFailed(false);
    setError(null);
  }, [setError]);

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const send = async () => {
    const content = input.trim();
    if (!content) return;
    const next: ConsultMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    const result = await consult(next);
    if (!result) return;
    setMessages([...next, { role: "assistant", content: result.reply }]);
    if (result.draft) setDraft(result.draft);
  };

  /** 相談で決まった値だけを設定へ移す。**決まっていない項目は空のままにする。** */
  const applyDraft = () => {
    setSpec((current) => {
      if (!draft) return current;
      const repositoryName = draft.repositoryName ?? current.repositoryName;
      const kind: NewAppKind =
        draft.kind ?? (draft.usesDatabase === false ? "next" : current.kind);
      const profile = newAppKindProfile(kind);
      return {
        ...current,
        displayName: draft.displayName ?? current.displayName,
        repositoryName,
        summary: draft.summary ?? current.summary,
        kind,
        subdomain: draft.subdomain ?? (repositoryName || current.subdomain),
        auth: draft.auth ?? current.auth,
        databaseName:
          profile.usesDatabase && repositoryName ? databaseNameFor(repositoryName) : null,
      };
    });
    setStep("basic");
  };

  /** 空き確認。**設定ステップへ入るたびに実物を読み直す**（押す前に古い判定を出さない）。 */
  const check = useCallback(
    async (target: NewAppSpec) => {
      const result = await runPreflight({
        repositoryName: target.repositoryName,
        hostname: target.urlMode === "subdomain" ? hostnameFor(target) : "",
        kind: target.kind,
      });
      if (!result) return;
      setPreflight(result);
      if (result.port.suggested !== null) {
        setSpec((current) =>
          current.port === null ? { ...current, port: result.port.suggested } : current,
        );
      }
    },
    [runPreflight],
  );

  const goToPlacement = async () => {
    setStep("placement");
    await check(spec);
  };

  const start = async () => {
    const result = await launch(spec);
    setCreated(result.created);
    setWarnings(result.warnings);
    setLaunchFailed(result.failed);
    if (result.created.length > 0) setStep("done");
  };

  const specErrors = validateNewAppSpec(spec);
  const repositoryTaken = preflight?.repository.taken === true && preflight.repository.name === spec.repositoryName;
  const hostnameTaken =
    spec.urlMode === "subdomain" &&
    preflight?.hostname.taken === true &&
    preflight.hostname.value === hostnameFor(spec);
  const canProceed = specErrors.length === 0 && !repositoryTaken && !hostnameTaken;
  // 払い出す帯はpreflightが実物の対応表から決める。まだ読めていなければ値を出さない。
  // GitHub Appのインストール対象への追加も、preflightが読んだ`repository_selection`で決まる
  // （#2248。押した時点でサーバーがもう一度確かめるので、ここは表示のためだけ）
  const planOptions = {
    localPortBase: preflight?.localPortBand?.base ?? null,
    githubAppNeedsRepositoryAdd: preflight?.githubApp?.needsRepositoryAdd ?? false,
  };
  const parentIssue = created.find((ref) => ref.kind === "parent-issue");
  const turns = countConsultTurns(messages);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-4" />
            {spec.displayName ? `${spec.displayName}を立ち上げる` : "新規アプリを立ち上げる"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            相談で構想を固めてから、リポジトリの作成と残りの作業のIssue起票までを行います。
          </DialogDescription>
          {step !== "done" && <StepIndicator current={step} />}
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {step === "consult" && (
            <ConsultStep
              messages={messages}
              draft={draft}
              input={input}
              onInputChange={setInput}
              onSend={send}
              isSending={isConsulting}
              turns={turns}
              chatEndRef={chatEndRef}
            />
          )}

          {step === "basic" && (
            <BasicStep
              spec={spec}
              onChange={setSpec}
              preflight={preflight}
              isChecking={isChecking}
              onCheck={() => check(spec)}
            />
          )}

          {step === "placement" && (
            <PlacementStep
              spec={spec}
              onChange={setSpec}
              preflight={preflight}
              isChecking={isChecking}
              onRecheck={(next) => check(next)}
            />
          )}

          {step === "confirm" && (
            <ConfirmStep spec={spec} preflight={preflight} planOptions={planOptions} />
          )}

          {step === "done" && (
            <DoneStep spec={spec} created={created} warnings={warnings} failed={launchFailed} />
          )}

          {specErrors.length > 0 && step === "confirm" && (
            <ul className="flex flex-col gap-1 text-sm text-destructive">
              {specErrors.map((code) => (
                <li key={code}>{NEW_APP_SPEC_ERROR_MESSAGES[code]}</li>
              ))}
            </ul>
          )}
          <ApiErrorMessage message={error} />
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {step === "consult" && (
            <>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                キャンセル
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  相談は{MAX_CONSULT_TURNS}往復まで（{turns}/{MAX_CONSULT_TURNS}）
                </span>
                <Button onClick={applyDraft}>
                  設定に進む
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
            </>
          )}

          {step === "basic" && (
            <>
              <Button variant="outline" onClick={() => setStep("consult")}>
                戻る
              </Button>
              <Button onClick={goToPlacement} disabled={!spec.repositoryName || repositoryTaken}>
                次へ
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          )}

          {step === "placement" && (
            <>
              <Button variant="outline" onClick={() => setStep("basic")}>
                戻る
              </Button>
              <Button onClick={() => setStep("confirm")} disabled={!canProceed}>
                次へ
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          )}

          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={() => setStep("placement")} disabled={isLaunching}>
                戻る
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {buildNewAppPlan(spec, planOptions).length}件を作成します
                </span>
                <Button onClick={start} disabled={!canProceed || isLaunching}>
                  {isLaunching ? <Loader2 className="animate-spin" /> : <Rocket />}
                  立ち上げを開始
                </Button>
              </div>
            </>
          )}

          {step === "done" && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                閉じる
              </Button>
              {parentIssue && (
                <Button asChild>
                  <a href={parentIssue.url} target="_blank" rel="noreferrer">
                    親Issueを開く
                    <ExternalLink data-icon="inline-end" />
                  </a>
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ current }: { current: WizardStep }) {
  const currentIndex = STEP_LABELS.findIndex((step) => step.key === current);
  return (
    <ol className="flex items-center gap-2">
      {STEP_LABELS.map((step, index) => (
        <li key={step.key} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              index === currentIndex ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full border text-[10px] tabular-nums",
                index === currentIndex && "border-primary bg-primary text-primary-foreground",
                index < currentIndex && "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
              )}
            >
              {index < currentIndex ? <Check className="size-2.5" /> : step.badge}
            </span>
            {step.label}
          </span>
          {index < STEP_LABELS.length - 1 && <span className="h-px flex-1 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

function ConsultStep({
  messages,
  draft,
  input,
  onInputChange,
  onSend,
  isSending,
  turns,
  chatEndRef,
}: {
  messages: ConsultMessage[];
  draft: NewAppDraft | null;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isSending: boolean;
  turns: number;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const exhausted = turns >= MAX_CONSULT_TURNS;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {messages.map((message, index) => (
          <p
            key={index}
            className={cn(
              "max-w-[86%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
              message.role === "assistant"
                ? "self-start border bg-muted/60"
                : "self-end bg-primary text-primary-foreground",
            )}
          >
            {message.content}
          </p>
        ))}
        {isSending && (
          <p className="self-start text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            考えています…
          </p>
        )}
        <div ref={chatEndRef} />
      </div>

      {draft && <DraftCard draft={draft} />}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={exhausted ? "相談は上限に達しました。設定へ進んでください。" : "続けて相談する…"}
          rows={2}
          disabled={exhausted}
          className="min-h-16"
        />
        <Button
          size="icon"
          onClick={onSend}
          disabled={!input.trim() || isSending || exhausted}
          aria-label="送信"
        >
          {isSending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        構想が固まっていれば、相談せずそのまま「設定に進む」を押しても構いません。
      </p>
    </div>
  );
}

function DraftCard({ draft }: { draft: NewAppDraft }) {
  const candidates: [string, string | null][] = [
    ["アプリ名", draft.displayName],
    ["リポジトリ", draft.repositoryName],
    ["種別", draft.kind ? newAppKindProfile(draft.kind).label : null],
    ["公開URL", draft.subdomain ? `${draft.subdomain}.${NEW_APP_BASE_DOMAIN}` : null],
    ["認証", draft.auth ? NEW_APP_AUTH_LABELS[draft.auth] : null],
  ];
  const rows = candidates.filter((row): row is [string, string] => row[1] !== null);

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
      <p className="text-xs font-semibold">仕様案（設定ステップで直せます）</p>
      <dl className="grid grid-cols-[6.5em_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BasicStep({
  spec,
  onChange,
  preflight,
  isChecking,
  onCheck,
}: {
  spec: NewAppSpec;
  onChange: (updater: (current: NewAppSpec) => NewAppSpec) => void;
  preflight: PreflightResult | null;
  isChecking: boolean;
  onCheck: () => void;
}) {
  const taken = preflight?.repository.taken === true && preflight.repository.name === spec.repositoryName;
  const free = preflight?.repository.taken === false && preflight.repository.name === spec.repositoryName;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-app-name">アプリ名</Label>
        <Input
          id="new-app-name"
          value={spec.displayName}
          onChange={(event) =>
            onChange((current) => ({ ...current, displayName: event.target.value }))
          }
          placeholder="家計レポート"
        />
        <p className="text-xs text-muted-foreground">画面やIssueのタイトルに出る名前です。</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-app-repo">リポジトリ</Label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{NEW_APP_ORG}/</span>
          <Input
            id="new-app-repo"
            value={spec.repositoryName}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                repositoryName: event.target.value.trim(),
                subdomain: current.subdomain || event.target.value.trim(),
                databaseName: newAppKindProfile(current.kind).usesDatabase
                  ? databaseNameFor(event.target.value.trim())
                  : null,
              }))
            }
            onBlur={onCheck}
            className="font-mono"
            placeholder="kakei-report"
          />
        </div>
        {isChecking && <p className="text-xs text-muted-foreground">空きを確認しています…</p>}
        {!isChecking && free && (
          <p className="flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            この名前は空いています
          </p>
        )}
        {!isChecking && taken && (
          <p className="flex items-center gap-1 text-xs font-semibold text-destructive">
            <TriangleAlert className="size-3" />
            すでに使われています。別の名前にしてください
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold">公開範囲</legend>
        {(
          [
            ["private", "Private", "自分だけが読める。organizationはteamプランなので無人実行もブランチ保護も効く"],
            ["public", "Public", "Actionsのログが誰でも読める。接続先の構成情報はvariableに置かない"],
          ] as const
        ).map(([value, label, note]) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="new-app-visibility"
              className="mt-1"
              checked={spec.visibility === value}
              onChange={() => onChange((current) => ({ ...current, visibility: value }))}
            />
            <span className="flex flex-col">
              <span>{label}</span>
              <span className="text-xs text-muted-foreground">{note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-app-summary">概要</Label>
        <Textarea
          id="new-app-summary"
          value={spec.summary}
          onChange={(event) => onChange((current) => ({ ...current, summary: event.target.value }))}
          rows={2}
          placeholder="家計の月次推移をZaimのデータから作る"
        />
        <p className="text-xs text-muted-foreground">
          リポジトリの説明と、vpsのアプリ一覧に載る説明にもなります。
        </p>
      </div>
    </div>
  );
}

function PlacementStep({
  spec,
  onChange,
  preflight,
  isChecking,
  onRecheck,
}: {
  spec: NewAppSpec;
  onChange: (updater: (current: NewAppSpec) => NewAppSpec) => void;
  preflight: PreflightResult | null;
  isChecking: boolean;
  onRecheck: (next: NewAppSpec) => void;
}) {
  const profile = newAppKindProfile(spec.kind);
  const hostname = hostnameFor(spec);
  const hostTaken = preflight?.hostname.taken === true && preflight.hostname.value === hostname;
  const hostFree = preflight?.hostname.taken === false && preflight.hostname.value === hostname;

  const update = (updater: (current: NewAppSpec) => NewAppSpec, recheck = false) => {
    onChange((current) => {
      const next = updater(current);
      if (recheck) onRecheck(next);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>種別</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {NEW_APP_KINDS.map((kind) => {
            const kindProfile = newAppKindProfile(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() =>
                  update(
                    (current) => ({
                      ...current,
                      kind,
                      port: null,
                      databaseName: kindProfile.usesDatabase
                        ? databaseNameFor(current.repositoryName)
                        : null,
                    }),
                    true,
                  )
                }
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left",
                  spec.kind === kind ? "border-foreground ring-1 ring-foreground" : "hover:bg-muted",
                )}
              >
                <span className="text-xs font-semibold">{kindProfile.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {kindProfile.runtimeSetup}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold">公開URL</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="new-app-url-mode"
            className="mt-1"
            checked={spec.urlMode === "subdomain"}
            onChange={() => update((current) => ({ ...current, urlMode: "subdomain" }), true)}
          />
          <span className="flex flex-col">
            <span className="font-mono text-xs">
              {spec.subdomain || "（サブドメイン）"}.{NEW_APP_BASE_DOMAIN}
            </span>
            <span className="text-xs text-muted-foreground">
              サブドメイン直下。ApacheのVirtualHostを新しく作る
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="new-app-url-mode"
            className="mt-1"
            checked={spec.urlMode === "path"}
            onChange={() =>
              update(
                (current) => ({
                  ...current,
                  urlMode: "path",
                  basePath: current.basePath || current.repositoryName,
                }),
                true,
              )
            }
          />
          <span className="flex flex-col">
            <span className="font-mono text-xs">
              {NEW_APP_BASE_DOMAIN}/{spec.basePath || spec.repositoryName || "（パス）"}
            </span>
            <span className="text-xs text-muted-foreground">
              既存サイト配下のパス。VirtualHostは増えないが basePath が要る
            </span>
          </span>
        </label>

        {spec.urlMode === "subdomain" ? (
          <Input
            value={spec.subdomain}
            onChange={(event) =>
              onChange((current) => ({ ...current, subdomain: event.target.value.trim() }))
            }
            onBlur={() => onRecheck(spec)}
            className="font-mono"
            placeholder="kakei-report"
            aria-label="サブドメイン"
          />
        ) : (
          <Input
            value={spec.basePath}
            onChange={(event) =>
              onChange((current) => ({ ...current, basePath: event.target.value.trim() }))
            }
            className="font-mono"
            placeholder="kakei-report"
            aria-label="パス"
          />
        )}

        {spec.urlMode === "subdomain" && !isChecking && hostFree && (
          <p className="flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            vpsに同じホスト名のVirtualHostはありません
          </p>
        )}
        {spec.urlMode === "subdomain" && !isChecking && hostTaken && (
          <p className="flex items-center gap-1 text-xs font-semibold text-destructive">
            <TriangleAlert className="size-3" />
            {hostname} はすでに使われています
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {profile.usesPort && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-app-port">本番ポート</Label>
            <Input
              id="new-app-port"
              value={spec.port ?? ""}
              inputMode="numeric"
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                onChange((current) => ({
                  ...current,
                  port: Number.isFinite(value) ? value : null,
                }));
              }}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {preflight?.vpsRead === false
                ? "guchi-apps/vps を読めなかったため、空き番号を提案できません。手で決めてください。"
                : (preflight?.port.note ??
                  `${profile.portRange?.from}〜${profile.portRange?.to} の空き番号を割り当てます`)}
            </p>
          </div>
        )}

        {profile.usesDatabase && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-app-db">データベース</Label>
            <Input
              id="new-app-db"
              value={spec.databaseName ?? ""}
              onChange={(event) =>
                onChange((current) => ({ ...current, databaseName: event.target.value.trim() }))
              }
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">MariaDB。リポジトリ名から決めました。</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-app-auth">認証</Label>
        <select
          id="new-app-auth"
          value={spec.auth}
          onChange={(event) =>
            onChange((current) => ({ ...current, auth: event.target.value as NewAppAuth }))
          }
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {(Object.keys(NEW_APP_AUTH_LABELS) as NewAppAuth[]).map((auth) => (
            <option key={auth} value={auth}>
              {NEW_APP_AUTH_LABELS[auth]}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
        <input
          type="checkbox"
          checked={spec.multiAgent}
          onChange={(event) =>
            onChange((current) => ({ ...current, multiAgent: event.target.checked }))
          }
        />
        <span className="flex flex-col">
          <span className="text-xs font-semibold">マルチエージェント運用に対応させる</span>
          <span className="text-xs text-muted-foreground">
            ラベル一式・共有ワークフローのcaller・CLAUDE.mdを初期化Issueに含める
          </span>
        </span>
      </label>

      <AppearancePanel spec={spec} onChange={onChange} />
    </div>
  );
}

/**
 * 体裁と運用（#2254）。**畳んだ状態を既定にする。**
 *
 * 共有知識のチェックリストは計画段階でこの5項目も決めるとしているが、入力欄として並べると
 * 立ち上げの手数がそのぶん増える。すべてに標準の既定値を持たせ、**決まった値を1行で見せて
 * 「次へ」を押せる形**にし、標準から外すときだけ開く。
 */
function AppearancePanel({
  spec,
  onChange,
}: {
  spec: NewAppSpec;
  onChange: (updater: (current: NewAppSpec) => NewAppSpec) => void;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold">体裁と運用</span>
          {isAppearanceDefault(spec) && (
            <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-400">
              標準どおり
            </span>
          )}
        </button>
        <Button variant="outline" size="sm" onClick={() => setOpen((current) => !current)}>
          {open ? "閉じる" : "変更する"}
        </Button>
      </div>

      {!open && <p className="text-xs text-muted-foreground">{appearanceSummary(spec)}</p>}

      {open && (
        <div className="flex flex-col gap-4 border-t pt-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-app-app-title">表示名</Label>
            <Input
              id="new-app-app-title"
              value={spec.appTitle}
              placeholder={spec.displayName}
              onChange={(event) =>
                onChange((current) => ({ ...current, appTitle: event.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              ブラウザのタブとホーム画面に出る名前（<code>title</code> /{" "}
              <code>applicationName</code> / <code>appleWebApp.title</code>）。空ならアプリ名を
              そのまま使います。
            </p>
          </div>

          {spec.pwa && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-semibold">アイコンとテーマカラー</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="new-app-icon-plan"
                  className="mt-1"
                  checked={spec.iconPlan === "provisional"}
                  onChange={() => onChange((current) => ({ ...current, iconPlan: "provisional" }))}
                />
                <span className="flex flex-col">
                  <span className="text-sm">暫定で始める</span>
                  <span className="text-xs text-muted-foreground">
                    テーマカラー1色のアイコンで作り、差し替えは親Issueの「後で決めること」に残します
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="new-app-icon-plan"
                  className="mt-1"
                  checked={spec.iconPlan === "prepared"}
                  onChange={() => onChange((current) => ({ ...current, iconPlan: "prepared" }))}
                />
                <span className="flex flex-col">
                  <span className="text-sm">用意してから始める</span>
                  <span className="text-xs text-muted-foreground">
                    初期化Issueが完成版のアイコンを待ちます
                  </span>
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {NEW_APP_THEME_COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`テーマカラー ${color}`}
                    onClick={() => onChange((current) => ({ ...current, themeColor: color }))}
                    style={{ backgroundColor: color }}
                    className={cn(
                      "size-6 rounded-md border",
                      spec.themeColor.toLowerCase() === color.toLowerCase() &&
                        "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                    )}
                  />
                ))}
                <Input
                  value={spec.themeColor}
                  onChange={(event) =>
                    onChange((current) => ({ ...current, themeColor: event.target.value.trim() }))
                  }
                  className="h-8 w-28 font-mono text-xs"
                  aria-label="テーマカラー"
                />
              </div>
            </fieldset>
          )}

          <div className="flex flex-col gap-2">
            <Label>PWA対応</Label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={spec.pwa}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    pwa: event.target.checked,
                    // PWA対応しないアプリでオフラインだけ残しても意味を持たない
                    offline: event.target.checked ? current.offline : false,
                  }))
                }
              />
              <span className="flex flex-col">
                <span className="text-sm">
                  PWA対応する（<code>manifest</code>＋アイコン）
                </span>
                <span className="text-xs text-muted-foreground">
                  標準方針。ホーム画面に追加できるようになります
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={spec.offline}
                disabled={!spec.pwa}
                onChange={(event) =>
                  onChange((current) => ({ ...current, offline: event.target.checked }))
                }
              />
              <span className="flex flex-col">
                <span className="text-sm">オフラインでも開けるようにする</span>
                <span className="text-xs text-muted-foreground">
                  Service Workerでキャッシュします。標準は「対応しない」
                </span>
              </span>
            </label>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={spec.changelog}
              onChange={(event) =>
                onChange((current) => ({ ...current, changelog: event.target.checked }))
              }
            />
            <span className="flex flex-col">
              <span className="text-sm">更新履歴（changelog）を持つ</span>
              <span className="text-xs text-muted-foreground">
                リリース時に生成された文面を <code>RELEASE_CHANGELOG</code> で受け取り、アプリの
                画面に出します
              </span>
            </span>
          </label>

          {spec.auth !== "none" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={spec.screenshotBypass}
                onChange={(event) =>
                  onChange((current) => ({ ...current, screenshotBypass: event.target.checked }))
                }
              />
              <span className="flex flex-col">
                <span className="text-sm">CI撮影の認証バイパスを用意する</span>
                <span className="text-xs text-muted-foreground">
                  {supportsUnattendedScreenshot(spec.kind)
                    ? "無人実行のスクリーンショット（24.screenshot-required）が成立する条件。後付けが効きにくいのでここで決めます"
                    : `${newAppKindProfile(spec.kind).label}ではPlaywrightが入らないため、無人実行での撮影は成立しません。ローカルでの画面確認用として用意します`}
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmStep({
  spec,
  preflight,
  planOptions,
}: {
  spec: NewAppSpec;
  preflight: PreflightResult | null;
  planOptions: NewAppPlanOptions;
}) {
  const artifacts = buildNewAppPlan(spec, planOptions);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(["auto", "proxy", "manual"] as const).map((automation) => (
          <span key={automation} className="flex items-center gap-1.5">
            <AutomationChip automation={automation} />
            {automation === "auto" && "issue-deckが作る"}
            {automation === "proxy" && "手作業アシスタントが流せる"}
            {automation === "manual" && "画面での操作が要る"}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">公開URL: {publicUrlFor(spec)}</p>
      {/* 同じ対象のIssueが`guchi-apps/vps`に開いていれば、押す前に知らせる（#2250） */}
      {preflight?.existingVpsIssue && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            <a
              href={preflight.existingVpsIssue.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline"
            >
              {preflight.existingVpsIssue.reference}
            </a>
            {` に同じ対象のIssueが開いています（${EXISTING_LAUNCH_ISSUE_REASON_LABELS[preflight.existingVpsIssue.reason]}）。VirtualHostのIssueは新しく作らず、このIssueへ書き足します。`}
          </span>
        </div>
      )}
      {preflight?.localPortBand && (
        <p className="text-xs text-muted-foreground">
          ローカルセッションのポート帯: {preflight.localPortBand.note}
        </p>
      )}
      {/* 体裁のパネルを開かずに通した人も、押す前に決まった値を読めるようにする（#2254） */}
      <p className="text-xs text-muted-foreground">体裁と運用: {appearanceSummary(spec)}</p>
      <ul className="flex flex-col gap-2">
        {artifacts.map((artifact) => (
          <li key={artifact.kind} className="flex items-start gap-2 rounded-lg border p-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-xs font-semibold break-words">{artifact.title}</span>
              {artifact.target && (
                <span className="font-mono text-[10px] text-muted-foreground">{artifact.target}</span>
              )}
              <span className="text-xs text-muted-foreground">{artifact.description}</span>
            </div>
            <AutomationChip automation={artifact.automation} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AutomationChip({ automation }: { automation: NewAppArtifact["automation"] }) {
  const style = AUTOMATION_STYLES[automation];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function DoneStep({
  spec,
  created,
  warnings,
  failed,
}: {
  spec: NewAppSpec;
  created: NewAppCreatedRef[];
  warnings: string[];
  failed: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1 py-2 text-center">
        <span
          className={cn(
            "grid size-9 place-items-center rounded-full border",
            failed
              ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          )}
        >
          {failed ? <TriangleAlert className="size-4" /> : <Check className="size-4" />}
        </span>
        <p className="text-sm font-semibold">
          {failed
            ? `${spec.displayName}の立ち上げは途中で止まりました`
            : `${spec.displayName}の立ち上げを開始しました`}
        </p>
        <p className="text-xs text-muted-foreground">
          {failed
            ? "ここまでに作られたものです。残りは手で進めてください（同じ内容での押し直しはできません）。"
            : `${created.length}件を作成しました。続きは親Issueから追えます。`}
        </p>
      </div>
      <ul className="flex flex-col">
        {created.map((ref) => (
          <li key={ref.reference} className="border-b py-2 text-sm last:border-b-0">
            <a
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 hover:underline"
            >
              <span className="min-w-0 flex-1 truncate">{ref.title}</span>
              {ref.existing && (
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                  既存
                </span>
              )}
              <span className="font-mono text-xs text-muted-foreground">{ref.reference}</span>
            </a>
          </li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 flex-1">{warning}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
