"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  Loader2,
  MessageCircleQuestion,
  Pencil,
  Plus,
} from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  clearIssueDraft,
  readRestorableIssueDraft,
  resolveInitialIssueDraft,
  useIssueDraftAutosave,
  type IssueDraft,
  type IssueDraftKind,
} from "@/hooks/use-issue-draft";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueQuickSuggest } from "@/hooks/use-issue-quick-suggest";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { askClaudeCommentBody, buildAskRepoQuestionTitle } from "@/lib/github/ask-claude";
import { composeIssueBody } from "@/lib/github/followup-issue";
import {
  isSelectableLabelName,
  startImplementationDisabledReason,
} from "@/lib/github/start-implementation";
import { isAutoAssignableLabelName } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import {
  AUTO_REPOSITORY_VALUE,
  buildRepositoryChoices,
  canProceedFromInput,
  resolveInitialQuickStep,
  type QuickIssueStep,
} from "@/lib/quick-issue";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/**
 * リポジトリ選択欄で、claude-issue-dispatch.ymlが導入済み（IssueDeckの自動化に対応済み）の
 * リポジトリを先頭に、未導入のリポジトリをその下にまとめる。各グループ内の順序は維持する。
 */
export function groupRepositoriesByWorkflowStatus(
  repositories: ConnectedRepository[],
): { registered: ConnectedRepository[]; unregistered: ConnectedRepository[] } {
  return {
    registered: repositories.filter((repo) => repo.hasClaudeWorkflow),
    unregistered: repositories.filter((repo) => !repo.hasClaudeWorkflow),
  };
}

/**
 * 「タイトル・ラベルを自動生成」実行時の選択ラベルを算出する。
 *
 * **リセットするのは自動付与の対象になるラベル（30〜89番台。71番台を除く。#1662）だけ。**
 * 生成結果に出てこないラベル——進捗管理用・実装オプション用に加えて、人が手で選んだ
 * `11.local`や`90.Close: *`——までリセットすると、自動生成のたびに黙って消え、
 * 生成結果からは二度と復活しない。
 */
export function mergeSuggestedLabels(prev: string[], suggested: string[]): string[] {
  return [
    ...prev.filter((name) => !isAutoAssignableLabelName(name)),
    ...new Set(suggested.filter(isAutoAssignableLabelName)),
  ];
}

/**
 * 種別を切り替えたときに選び直すリポジトリを決める（#1641）。
 *
 * **質問は`claude-issue-dispatch.yml`が導入済みのリポジトリでしか成立しない**（回答するのが
 * GitHub Actionsのmode=askのため）。Issueへ戻すときは絞り込みが無いので、選択をそのまま残す。
 *
 * **未選択（＝「自動で決める」）は選び直さない**（#1733）。入力ステップにリポジトリ欄が出た
 * 以上、種別を押しただけで1件目が勝手に入ると、選んでいないものを選んだように見える。
 */
export function resolveKindRepository(
  kind: IssueDraftKind,
  repositories: ConnectedRepository[],
  current: string,
): string {
  if (kind === "issue" || current === "") return current;
  const askable = repositories.filter((repo) => repo.hasClaudeWorkflow);
  return askable.some((repo) => repo.fullName === current) ? current : (askable[0]?.fullName ?? "");
}

/**
 * 推定されたリポジトリ候補のうち、いまの種別で実際に選べるものだけを残す（#1710）。
 *
 * **選べないものを候補として出さない。** 押しても切り替わらないチップは、押した本人からは
 * 壊れているようにしか見えない。非表示にしているリポジトリや、質問で選べない
 * `claude-issue-dispatch.yml`未導入のリポジトリがこれに当たる。
 */
export function selectableSuggestedRepositories(
  kind: IssueDraftKind,
  repositories: ConnectedRepository[],
  candidates: string[],
): string[] {
  const selectable = new Set(
    repositories
      .filter((repo) => kind === "issue" || repo.hasClaudeWorkflow)
      .map((repo) => repo.fullName),
  );
  return candidates.filter((candidate) => selectable.has(candidate));
}

const DEFAULT_ASSIGNEE = "m-guchi";

/**
 * Claudeが決めた値であることを示すバッジ（#1605）。
 * **人が触った項目からは消す**——直した後まで「自動」と書かれていると、自分の入力が
 * 残っているのかどうかが読めなくなる。
 */
function AutoBadge() {
  return (
    <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary">
      自動
    </span>
  );
}

/**
 * 値の出どころが「開いていた画面」であることを示すバッジ（#1710）。
 * **`自動`と書き分ける。** リポジトリ別の画面から開くと内容を読まずにそのリポジトリが入るため、
 * 「Claudeが内容から決めた」と誤解されると、違っていても疑われないまま作成まで進む。
 */
function PageBadge() {
  return (
    <span className="ml-1.5 rounded border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      表示中のリポジトリ
    </span>
  );
}

/** 推定が終わるまでの入れ物。項目名は出したまま、値の場所だけを空けておく */
function FieldSkeleton() {
  return <div className="h-9 animate-pulse rounded-md border border-input bg-muted/60" />;
}

/**
 * リポジトリの選択肢。入力ステップ（#1733）と確認ステップの2か所で同じものを出す。
 *
 * **並びを2か所で書き分けない。** 先に指定する場所と後で直す場所で順序やグループ名が違うと、
 * 同じリポジトリを探すのに2通りの探し方を覚えることになる。
 * グループ名は片方しか無いときには出さない（見出しだけの意味が無いため）。
 */
function RepositorySelectItems({
  registered,
  unregistered,
}: {
  registered: ConnectedRepository[];
  unregistered: ConnectedRepository[];
}) {
  return (
    <>
      {registered.length > 0 && (
        <SelectGroup>
          {unregistered.length > 0 && <SelectLabel>登録済み</SelectLabel>}
          {registered.map((repo) => (
            <SelectItem key={repo.id} value={repo.fullName}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {unregistered.length > 0 && (
        <SelectGroup>
          {registered.length > 0 && <SelectLabel>未登録</SelectLabel>}
          {unregistered.map((repo) => (
            <SelectItem key={repo.id} value={repo.fullName}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
    </>
  );
}

type CreateIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  defaultTitle?: string | null;
  defaultBody?: string | null;
  /**
   * 本文の先頭に固定で付くテキスト（引き継ぎ元の情報など・#1322）。
   * 入力欄には入れず読み取り専用で表示し、作成時に入力内容の前へ連結する。
   */
  bodyPrefix?: string | null;
  issues: Issue[];
  onCreated: (issue: Issue) => void;
};

/**
 * Issueの作成と、単一リポジトリへの質問（#691）を1つのダイアログにまとめたもの（#1641）。
 *
 * **本文・画像添付・ラベル選択はどちらの種別でも同じもの**で、種別によって変わるのは
 * タイトル（質問は質問文から機械生成）・担当者の有無・作成後の動きだけ。質問側が独自の
 * `Textarea`を持っていたせいで、質問には画像を貼れず`#123`のIssue補完も効かなかった。
 *
 * **横断質問（#1454）はここに含めない。** 回答するのがGitHub ActionsではなくサブPCの質問
 * セッションで、リポジトリの絞り込み条件も実行先の選択も別物になるため、
 * `CrossRepoQuestionDialog`のまま独立した入口に残している。
 *
 * ## 2ステップ（#1605）
 *
 * 開いた直後は**本文の入力欄だけ**（`input`）で、「次へ」を押すとリポジトリ・タイトル・ラベルを
 * Claudeが推定し（`/api/issues/quick-suggest`）、値が入った状態の`confirm`へ移る。`confirm`は
 * 従来のフォームそのもので、推定結果は全部その場で直せる。
 *
 * **推定を挟まずに作成する経路は作らない。** リポジトリを外したまま作成すると、押した本人からは
 * 間違いが見えないまま別リポジトリへIssueが立ち、そのリポジトリの無人実行の母集団に入る。
 * 逆に**推定が失敗しても作成は止めない**——トークン未設定（501）・生成失敗のときは値が空のまま
 * `confirm`へ進み、従来どおり自分で埋められる状態にする。
 */
export function CreateIssueDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  defaultTitle,
  defaultBody,
  bodyPrefix,
  issues,
  onCreated,
}: CreateIssueDialogProps) {
  const { createIssue, isSubmitting: isCreatingIssue, error, setError } = useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();
  const isSubmitting = isCreatingIssue || isCreatingComment;

  const [kind, setKind] = useState<IssueDraftKind>("issue");
  const [step, setStep] = useState<QuickIssueStep>("input");
  /** 入力ステップを経由して確認ステップへ来たか。見出しを「内容を確認」に切り替える判断に使う */
  const [cameFromInput, setCameFromInput] = useState(false);
  /**
   * 確認ステップに出ている値のうち、Claudeが入れたまま人が触っていないもの（#1605）。
   * `自動`バッジを出す対象で、ユーザーが直した時点でその項目は外れる。
   */
  const [autoFilled, setAutoFilled] = useState<{
    repository: boolean;
    title: boolean;
    labels: boolean;
  }>({ repository: false, title: false, labels: false });
  /**
   * 内容から推定したリポジトリ候補（確からしい順・#1710）。確認ステップにチップとして並べる。
   * 推定を呼んでいないとき（「自分で入力する」・下書きの復元）は空のまま＝チップを出さない。
   */
  const [repositoryCandidates, setRepositoryCandidates] = useState<string[]>([]);
  /**
   * 推定はできたのにラベルが1つも決まらなかったか（#1710）。
   * **黙って空のまま進めない。** 空欄と「決められなかった」は画面上で見分けが付かず、
   * ラベルの付いていないIssueがそのまま作られていた。
   */
  const [labelSuggestionMissed, setLabelSuggestionMissed] = useState(false);
  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  /**
   * リポジトリを**人が指定したか**（#1733）。入力ステップのリポジトリ欄で選ぶと立つ。
   *
   * **画面から渡された値（リポジトリ別の画面から開いた場合）とは区別する。** どちらも
   * `repositoryFullName`に入るが、渡されただけのものは「そこを開いていた」という理由でしか
   * ないため、推定も候補チップも従来どおり行う（#1710）。指定した場合だけ推定を省く。
   */
  const [hasPickedRepository, setHasPickedRepository] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [restorableDraft, setRestorableDraft] = useState<IssueDraft | null>(null);
  const hasUserSetAssignee = useRef(false);
  /**
   * 「作成+実装開始」で作成したIssue（#1323）。**入っている間だけ「実装を開始」を出す。**
   * このダイアログ自体は閉じているので、そちらはDialogの外側に並べて描画する。
   */
  const [startTargetIssue, setStartTargetIssue] = useState<Issue | null>(null);

  const { labels, assignees, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );
  const { registered: registeredRepositories, unregistered: unregisteredRepositories } = useMemo(
    () => groupRepositoriesByWorkflowStatus(repositories),
    [repositories],
  );
  const isQuestion = kind === "question";
  /**
   * 質問では`claude-issue-dispatch.yml`が導入済みのリポジトリしか選べない（回答するのが
   * GitHub Actionsのmode=askのため）。未導入のグループごと選択肢から落とす。
   */
  const selectableUnregisteredRepositories = isQuestion ? [] : unregisteredRepositories;
  const hasSelectableRepository =
    registeredRepositories.length + selectableUnregisteredRepositories.length > 0;
  // 「作成+実装開始」で作成したIssueの実行先を選ばせるための情報（#1323）。判定の材料は
  // Issue詳細画面（issue-detail.tsx）と同じで、リポジトリ情報が無い場合は塞がない側に倒す
  const startTargetRepository = startTargetIssue
    ? repositories.find((repo) => repo.fullName === startTargetIssue.repositoryFullName)
    : undefined;
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
  );
  /** 確認ステップのリポジトリ欄に並べるチップ（選択中＋推定候補・#1710） */
  const repositoryChoices = useMemo(
    () => buildRepositoryChoices(repositoryFullName, repositoryCandidates),
    [repositoryFullName, repositoryCandidates],
  );
  const {
    isGenerating: isSuggesting,
    error: suggestError,
    notConfigured: suggestNotConfigured,
    generate: generateSuggestion,
  } = useIssueSuggest();
  const {
    isGenerating: isQuickSuggesting,
    error: quickSuggestError,
    notConfigured: quickSuggestNotConfigured,
    generate: generateQuickSuggestion,
  } = useIssueQuickSuggest();
  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを初期状態へ戻す。明示的なプリフィル（引用元テキスト等）が
    // 渡されていればそちらを優先し、それ以外は空の状態にする（保存済みの下書きは自動では
    // 反映せず、readRestorableIssueDraftの結果をユーザーが「復元する」で選んだ場合のみ反映する）。
    // 外部トリガー（開閉）に同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    const draft = resolveInitialIssueDraft({
      defaultRepositoryFullName,
      defaultTitle,
      defaultBody,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKind("issue");
    // 書く内容が渡されているとき（引き継ぎ作成・コメントからの起票）は入力ステップを飛ばす（#1605）
    setStep(resolveInitialQuickStep({ defaultTitle, defaultBody }));
    setCameFromInput(false);
    setAutoFilled({ repository: false, title: false, labels: false });
    setRepositoryCandidates([]);
    setLabelSuggestionMissed(false);
    setRepositoryFullName(draft.repositoryFullName);
    setHasPickedRepository(false);
    setTitle(draft.title);
    setBody(draft.body);
    setSelectedLabels(draft.selectedLabels);
    setAssignee(draft.assignee);
    setIsImageUploading(false);
    setError(null);
    setCommentError(null);
    hasUserSetAssignee.current = draft.assignee !== null;
    // 引き継ぎ（bodyPrefix）は本文の入力欄を空のまま始めるため、保存済み下書きの提示は止めない
    // （#1322）。閉じてしまった引き継ぎ作成の入力を復元でき、復元しても接頭辞は消えない。
    setRestorableDraft(
      readRestorableIssueDraft({ defaultRepositoryFullName, defaultTitle, defaultBody }),
    );
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, setError, setCommentError]);

  useIssueDraftAutosave(open, {
    kind,
    repositoryFullName,
    title,
    body,
    selectedLabels,
    assignee,
  });

  useEffect(() => {
    if (!open || hasUserSetAssignee.current) return;
    if (assignees.includes(DEFAULT_ASSIGNEE)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAssignee(DEFAULT_ASSIGNEE);
    }
  }, [open, assignees]);

  /** 種別を切り替える。質問で選べないリポジトリを選んでいた場合は選び直す（#1641） */
  function selectKind(next: IssueDraftKind) {
    const resolved = resolveKindRepository(next, repositories, repositoryFullName);
    setKind(next);
    setRepositoryFullName(resolved);
    // 選び直された値は本人の指定ではない（#1733）。指定として扱うと、選んでいない
    // リポジトリのまま推定が省かれる。ここで降ろして自動で決め直させる
    if (resolved !== repositoryFullName) setHasPickedRepository(false);
    setRepositoryCandidates((prev) => selectableSuggestedRepositories(next, repositories, prev));
  }

  /** 候補チップを押してリポジトリを選び直す（#1710）。人が選んだので`自動`バッジは外す */
  function handleSelectCandidate(fullName: string) {
    setAutoFilled((prev) => ({ ...prev, repository: false }));
    setHasPickedRepository(true);
    setRepositoryFullName(fullName);
  }

  /**
   * 入力ステップでリポジトリを指定する（#1733）。「自動で決める」を選べば未指定へ戻る。
   * 指定した時点で`hasPickedRepository`が立ち、「次へ」でリポジトリの推定を省く。
   */
  function handleInputRepositoryChange(value: string) {
    const isAuto = value === AUTO_REPOSITORY_VALUE;
    setHasPickedRepository(!isAuto);
    setRepositoryFullName(isAuto ? "" : value);
  }

  function handleRestoreDraft() {
    if (!restorableDraft) return;
    // 下書きは書いていたときの種別ごと戻す（質問の書きかけを復元してIssueとして作らない）
    setKind(restorableDraft.kind);
    const restoredRepository = resolveKindRepository(
      restorableDraft.kind,
      repositories,
      defaultRepositoryFullName ?? restorableDraft.repositoryFullName,
    );
    setRepositoryFullName(restoredRepository);
    // 書いていたときに入っていた値は本人が決めたものとして扱う（#1733）。書き直して「次へ」を
    // 押したときに、いったん決まっていたリポジトリが推定で上書きされないようにする
    setHasPickedRepository(restoredRepository !== "");
    setTitle(restorableDraft.title);
    setBody(restorableDraft.body);
    // 実装オプション用ラベル（`21.plan-required`等）は#1580でこの画面から選べなくなったが、
    // それ以前に保存された下書きには残っている。画面に出ないラベルが黙って付かないよう濾す
    setSelectedLabels(restorableDraft.selectedLabels.filter(isSelectableLabelName));
    setAssignee(restorableDraft.assignee);
    hasUserSetAssignee.current = restorableDraft.assignee !== null;
    setRestorableDraft(null);
    // 書きかけが全部入った状態になるので、1段目へ戻さず確認ステップから続ける（#1605）
    setStep("confirm");
    setCameFromInput(false);
    setAutoFilled({ repository: false, title: false, labels: false });
    setRepositoryCandidates([]);
    setLabelSuggestionMissed(false);
  }

  function resetForm() {
    setKind("issue");
    setStep("input");
    setCameFromInput(false);
    setAutoFilled({ repository: false, title: false, labels: false });
    setRepositoryCandidates([]);
    setLabelSuggestionMissed(false);
    setRepositoryFullName("");
    setHasPickedRepository(false);
    setTitle("");
    setBody("");
    setSelectedLabels([]);
    setAssignee(null);
    hasUserSetAssignee.current = false;
  }

  function toggleLabel(name: string) {
    setAutoFilled((prev) => ({ ...prev, labels: false }));
    setLabelSuggestionMissed(false);
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  function handleAssigneeChange(value: string) {
    hasUserSetAssignee.current = true;
    setAssignee(value === "__none__" ? null : value);
  }

  async function handleGenerateSuggestion() {
    const result = await generateSuggestion(
      body,
      labels.map((label) => ({ name: label.name, description: label.description })),
    );
    if (!result) return;
    setTitle(result.title);
    setSelectedLabels((prev) => mergeSuggestedLabels(prev, result.labels));
    setAutoFilled((prev) => ({ ...prev, title: true, labels: result.labels.length > 0 }));
    setLabelSuggestionMissed(result.labels.length === 0);
  }

  /**
   * 入力ステップの「次へ」（#1605）。
   *
   * リポジトリ・タイトル・ラベルを推定してから確認ステップへ移る。**推定の成否によらず
   * 確認ステップへは必ず進む**——失敗したときに1段目へ留めると、書いた内容を抱えたまま
   * どこにも進めなくなる。空欄のフォームとして続けられる方がよい。
   */
  async function handleProceedToConfirm() {
    if (!canProceedFromInput(body)) return;
    setStep("confirm");
    setCameFromInput(true);

    const result = await generateQuickSuggestion({
      body,
      kind,
      // すでに決まっているリポジトリ（表示中のリポジトリ）は選択状態のまま動かさない。
      // 推定自体は行われ、結果は候補チップとして並ぶ（#1710）
      repositoryFullName: repositoryFullName || null,
      // ただし人が入力ステップで指定した場合は、推定そのものを省く（#1733）
      repositoryPinned: hasPickedRepository,
    });
    if (!result) return;

    // 候補が無い応答（デプロイ直後に古い版のAPIを叩いた場合）でも、決まった1件は候補として扱う。
    // ただし人が指定している場合は候補を出さない（#1733）——押しても変わらないものを並べると、
    // 指定した本人には自分の選択が疑われているようにしか見えない
    const suggested = hasPickedRepository
      ? []
      : (result.repositoryCandidates ??
        (result.repositoryFullName ? [result.repositoryFullName] : []));
    const candidates = selectableSuggestedRepositories(kind, repositories, suggested);
    // 画面がリポジトリを渡していないときだけ、推定の1位を選んだ状態にする
    const isRepositoryAuto = !repositoryFullName && candidates.length > 0;

    setRepositoryCandidates(candidates);
    if (isRepositoryAuto) setRepositoryFullName(candidates[0]);
    if (result.title) setTitle(result.title);
    if (result.labels.length > 0) {
      setSelectedLabels((prev) => mergeSuggestedLabels(prev, result.labels));
    }
    setAutoFilled({
      repository: isRepositoryAuto,
      title: Boolean(result.title),
      labels: result.labels.length > 0,
    });
    // 質問Issueにラベルは付けないため、決まらなかったことを知らせるのはIssueのときだけ
    setLabelSuggestionMissed(kind === "issue" && result.labels.length === 0);
  }

  /**
   * 入力ステップの「自分で入力する」。推定を呼ばずに従来のフォーム（確認ステップ）へ移る。
   * 見出しは「新しいIssueを作成」のままにする（確認するものが無いため）。
   */
  function handleSkipSuggestion() {
    setStep("confirm");
    setCameFromInput(false);
    setRepositoryCandidates([]);
    setLabelSuggestionMissed(false);
  }

  /** 確認ステップから本文の書き直しへ戻る */
  function handleBackToInput() {
    setStep("input");
  }

  function handleRepositoryChange(value: string) {
    setAutoFilled((prev) => ({ ...prev, repository: false }));
    setHasPickedRepository(true);
    setRepositoryFullName(value);
  }

  function handleTitleChange(value: string) {
    setAutoFilled((prev) => ({ ...prev, title: false }));
    setTitle(value);
  }

  async function handleSubmit() {
    if (isQuestion) {
      await handleAskQuestion();
      return;
    }
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee,
    });
    if (issue) {
      resetForm();
      clearIssueDraft();
      onCreated(issue);
      onOpenChange(false);
    }
  }

  /**
   * 種別「質問」での送信（#691の「リポジトリに質問する」をここへ統合したもの・#1641）。
   *
   * Issueを1件作り、続けてGitHub Actions（mode=ask）を起こす質問コメントを投稿する。
   * **タイトルは質問文から機械的に作る**（`[質問] `接頭辞。Claudeは使わない）。この接頭辞が
   * 質問Issueかどうかの唯一の判定材料で、質問ビューとワンボタンクローズがこれを見ている。
   */
  async function handleAskQuestion() {
    if (!repositoryFullName || !body.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title: buildAskRepoQuestionTitle(body),
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee: null,
    });
    if (!issue) return;

    const [owner, repo] = repositoryFullName.split("/");
    const comment = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(body),
    });

    resetForm();
    clearIssueDraft();
    onOpenChange(false);
    onCreated(comment ? { ...issue, commentCount: issue.commentCount + 1 } : issue);
  }

  /**
   * 「作成+実装開始」ボタン押下時（#774・#1323）。
   *
   * Issueを作成したうえで、**実装オプションと実行先を選ぶ「実装を開始」ダイアログへ渡す**。
   * オプションは作成フォームでは選ばせず（#1580）、こちらのダイアログだけで選ぶ。
   * 「計画が必要」の初期値は、作成時に付けた種別ラベル（`50.feature`等）から決まる。
   *
   * **以前はここで直接`@claude`コメントを投稿していた（#774）。** 起動先を選ぶ余地が無く、
   * 作成したIssueは必ずGitHub Actionsで走っていた。サブPCで始めたい場合は、いったん作成して
   * Issue詳細を開き直すしかなかったため、既定がサブPCの実行先選択を挟む（#1323）。
   * 起動そのもの（`@claude`コメント・ジョブの積み込み・進捗の報告）はダイアログ側が行う。
   */
  async function handleCreateAndStart() {
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee,
    });
    if (!issue) return;

    resetForm();
    clearIssueDraft();
    onOpenChange(false);
    onCreated(issue);
    setStartTargetIssue(issue);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (step === "input") {
                void handleProceedToConfirm();
              } else {
                handleSubmit();
              }
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {step === "confirm" && cameFromInput
                ? "内容を確認"
                : isQuestion
                  ? "リポジトリに質問する"
                  : "新しいIssueを作成"}
            </DialogTitle>
            {step === "input" ? (
              <DialogDescription>
                {isQuestion
                  ? "質問内容でIssueを自動作成し、Claudeに質問します。回答はコメントとして返るまで数十秒〜数分かかります。"
                  : hasPickedRepository
                    ? "内容を書くと、タイトル・ラベルを自動で決めます。"
                    : "内容を書くと、リポジトリ・タイトル・ラベルを自動で決めます。"}
              </DialogDescription>
            ) : (
              cameFromInput && (
                <DialogDescription>
                  自動で決めた値です。違っていれば直せます。
                </DialogDescription>
              )
            )}
          </DialogHeader>

          {restorableDraft && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
              <span>保存された下書きがあります</span>
              <Button variant="outline" size="xs" onClick={handleRestoreDraft}>
                復元する
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* 種別（#1641）。**本文の内容からの自動判定は行わない。** 誤判定は押した本人から
                見えないまま、質問のつもりの本文が実装Issueとして無人実行に乗る（逆もある）
                という取り返しの付きにくい間違いになるため、押した時点で確定する形にする。
                #1605で自動化したのはリポジトリ・タイトル・ラベルまでで、ここは対象外 */}
            {step === "input" && (
              <div className="flex flex-col gap-1.5">
                <Label>種別</Label>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    variant={isQuestion ? "outline" : "default"}
                    className="h-9 px-3 text-xs"
                    aria-pressed={!isQuestion}
                    onClick={() => selectKind("issue")}
                  >
                    <Plus />
                    Issue
                  </Button>
                  <Button
                    type="button"
                    variant={isQuestion ? "default" : "outline"}
                    className="h-9 px-3 text-xs"
                    aria-pressed={isQuestion}
                    onClick={() => selectKind("question")}
                  >
                    <MessageCircleQuestion />
                    質問
                  </Button>
                </div>
              </div>
            )}

            {/* リポジトリの先指定（#1733）。**任意で、既定は「自動で決める」。**
                どのリポジトリの話かが書く前から分かっているときに、推定と直しの1往復を
                省くための欄で、選ばなければ「次へ」の挙動は#1605のまま変わらない。
                リポジトリ別の画面から開いたときの値もここに出る——これまでは黙って
                持ち越され、確認ステップの「表示中のリポジトリ」で初めて分かる状態だった */}
            {step === "input" && hasSelectableRepository && (
              <div className="flex flex-col gap-1.5">
                {/* 「任意」は`Label`の外に置く。中に入れるとアクセシブルネームが
                    「リポジトリ任意」になり、項目名で引けなくなる（確認ステップのバッジと同じ理由） */}
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="create-issue-input-repo">リポジトリ</Label>
                  <span className="text-xs text-muted-foreground">任意</span>
                </div>
                <Select
                  value={repositoryFullName || AUTO_REPOSITORY_VALUE}
                  onValueChange={handleInputRepositoryChange}
                >
                  <SelectTrigger id="create-issue-input-repo" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_REPOSITORY_VALUE}>自動で決める（内容から）</SelectItem>
                    <RepositorySelectItems
                      registered={registeredRepositories}
                      unregistered={selectableUnregisteredRepositories}
                    />
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* 推定中の案内（#1605）。何を決めようとしているかは下の項目名が表すので、ここは1行 */}
            {step === "confirm" && isQuickSuggesting && (
              <p className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                内容から、リポジトリ・タイトル・ラベルを決めています
              </p>
            )}

            {step === "confirm" && (
              <div className="flex flex-col gap-1.5">
                {/* バッジは`Label`の外に置く。中に入れるとラベルの文字列（アクセシブルネーム）が
                    「リポジトリ自動」になり、項目名で引けなくなる */}
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="create-issue-repo">リポジトリ</Label>
                  {autoFilled.repository ? (
                    <AutoBadge />
                  ) : (
                    cameFromInput &&
                    !hasPickedRepository &&
                    repositoryFullName !== "" &&
                    repositoryFullName === defaultRepositoryFullName && <PageBadge />
                  )}
                </div>
                {isQuickSuggesting ? (
                  <FieldSkeleton />
                ) : hasSelectableRepository ? (
                  <Select value={repositoryFullName} onValueChange={handleRepositoryChange}>
                    <SelectTrigger id="create-issue-repo" className="w-full">
                      <SelectValue placeholder="リポジトリを選択" />
                    </SelectTrigger>
                    <SelectContent>
                      <RepositorySelectItems
                        registered={registeredRepositories}
                        unregistered={selectableUnregisteredRepositories}
                      />
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {isQuestion
                      ? "claude-issue-dispatch.ymlが導入されているリポジトリがありません。"
                      : "連携しているリポジトリがありません。"}
                  </p>
                )}
                {/* 内容から推定した候補（#1710）。選択中のものを先頭に並べ、1タップで切り替えられる
                    ようにする。**推定を呼んでいないときは出さない**（「自分で入力する」・下書きの復元） */}
                {!isQuickSuggesting && repositoryChoices.length > 1 && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {repositoryChoices.map((fullName) => {
                        const isCurrent = fullName === repositoryFullName;
                        const isFromPage = fullName === defaultRepositoryFullName;
                        const rank = repositoryCandidates.indexOf(fullName);
                        const [owner, name] = fullName.split("/");
                        return (
                          <button
                            key={fullName}
                            type="button"
                            aria-pressed={isCurrent}
                            onClick={() => handleSelectCandidate(fullName)}
                            className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                              isCurrent
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input hover:bg-muted"
                            }`}
                          >
                            <span
                              className={`shrink-0 rounded-full border px-1.5 text-[10px] font-medium ${
                                isCurrent ? "border-primary-foreground/40" : "border-border"
                              }`}
                            >
                              {isFromPage ? "表示中" : `候補${rank + 1}`}
                            </span>
                            <span className="truncate">
                              <span className={isCurrent ? "opacity-70" : "text-muted-foreground"}>
                                {owner}/
                              </span>
                              {name}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      候補は内容から推定したものです。押すと切り替わります。
                    </p>
                  </>
                )}
                {isQuestion && (
                  <p className="text-xs text-muted-foreground">
                    回答するのはGitHub Actionsのため、claude-issue-dispatch.yml導入済みのリポジトリだけ選べます。
                  </p>
                )}
              </div>
            )}

            {step === "confirm" &&
              (isQuestion ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-issue-question-title">タイトル（自動）</Label>
                  <p
                    id="create-issue-question-title"
                    className="rounded-md border border-input px-3 py-2 text-sm break-all text-muted-foreground"
                  >
                    {body.trim() ? buildAskRepoQuestionTitle(body) : "質問内容から自動で作られます"}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="create-issue-title">タイトル</Label>
                    {autoFilled.title && <AutoBadge />}
                  </div>
                  {isQuickSuggesting ? (
                    <FieldSkeleton />
                  ) : (
                    <Input
                      id="create-issue-title"
                      value={title}
                      onChange={(e) => handleTitleChange(e.target.value)}
                      placeholder="Issueのタイトル"
                      className="md:text-sm"
                      autoFocus
                    />
                  )}
                </div>
              ))}

            {/* 本文の入力欄は種別で変えない（#1641）。質問でも画像の貼り付け・ドラッグ&ドロップと
                `#123`のIssue補完が使えるようにするのがこの統合の主目的で、以前の質問ダイアログは
                素のTextareaだったためどちらも使えなかった。
                #1605以降、編集できるのは入力ステップだけ。確認ステップでは畳んだ1行にして
                「内容を編集」で戻す——書く場所を2つ持つと、どちらが本文なのか分からなくなる */}
            {step === "input" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-issue-body">{isQuestion ? "質問内容" : "内容"}</Label>
                {/* 引き継ぎ元などの固定接頭辞は入力欄に入れず、ここに読み取り専用で見せる（#1322）。
                    入力欄は1行目から自分の書きたいことを書ける状態で始まり、消してしまう心配も無い */}
                {bodyPrefix && (
                  <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      以下は本文の先頭に自動で付きます（編集不可）
                    </p>
                    <p className="mt-1 text-xs break-all whitespace-pre-wrap text-foreground">
                      {bodyPrefix.trim()}
                    </p>
                  </div>
                )}
                <MentionTextarea
                  id="create-issue-body"
                  value={body}
                  onChange={setBody}
                  issueSuggestions={issueSuggestions}
                  onUploadingChange={setIsImageUploading}
                  repositoryFullName={repositoryFullName}
                  placeholder={
                    isQuestion ? "質問内容を入力してください" : "何をしたいかを書いてください"
                  }
                  className="min-h-32 md:text-sm"
                  autoFocus
                />
                <div className="flex flex-wrap gap-2">
                  <BodyCleanupButton value={body} onCleaned={setBody} disabled={isSubmitting} />
                </div>
                {/* 何が自動で決まるかは、リポジトリを指定したかどうかで変わる（#1733） */}
                <p className="text-xs text-muted-foreground">
                  {hasPickedRepository
                    ? isQuestion
                      ? "リポジトリは指定したものを使います。質問する前に確認できます。"
                      : "タイトル・ラベルは内容から決めます。リポジトリは指定したものを使います。"
                    : isQuestion
                      ? "リポジトリは内容から決めます。質問する前に確認できます。"
                      : "リポジトリ・タイトル・ラベルは内容から決めます。作成する前に確認できます。"}
                </p>
                {quickSuggestNotConfigured && (
                  <p className="text-xs text-muted-foreground">
                    Claudeのトークンが設定されていないため、自動では決められません。次の画面で自分で選んでください。
                  </p>
                )}
                {quickSuggestError && (
                  <p className="text-xs text-destructive">{quickSuggestError}</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label>{isQuestion ? "質問内容" : "内容"}</Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {body.trim() || "（未入力）"}
                  </span>
                  <Button variant="outline" size="xs" onClick={handleBackToInput}>
                    <Pencil />
                    内容を編集
                  </Button>
                </div>
              </div>
            )}

            {step === "confirm" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Label>ラベル</Label>
                  {autoFilled.labels && <AutoBadge />}
                </div>
                {isQuickSuggesting ? (
                  <FieldSkeleton />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <LabelPicker
                        labels={selectableLabels}
                        selectedNames={selectedLabels}
                        onToggle={toggleLabel}
                        isLoading={isMetaLoading}
                        trigger={
                          <Button variant="outline" className="h-9 w-fit px-3" disabled={isMetaLoading}>
                            {selectedLabels.length > 0
                              ? `ラベル (${selectedLabels.length})`
                              : "ラベルを選択"}
                            <ChevronDown className="size-3.5" />
                          </Button>
                        }
                      />
                      {/* 推定をやり直す口（#1605）。タイトルを機械生成する質問では出さない */}
                      {!isQuestion && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={
                            !body.trim() || !repositoryFullName || isMetaLoading || isSuggesting
                          }
                          onClick={handleGenerateSuggestion}
                        >
                          {isSuggesting ? <Loader2 className="animate-spin" /> : <Bot />}
                          タイトル・ラベルを自動生成
                        </Button>
                      )}
                    </div>
                    {/* ラベルが1つも決まらなかったことを明示する（#1710）。
                        空欄と見分けが付かないままだと、ラベルの付かないIssueがそのまま作られる */}
                    {labelSuggestionMissed && !suggestNotConfigured && (
                      <p className="text-xs text-destructive">
                        ラベルは自動で決められませんでした。選ぶか、生成し直せます。
                      </p>
                    )}
                    {suggestNotConfigured && (
                      <p className="text-xs text-muted-foreground">
                        Claudeのトークンが設定されていません
                      </p>
                    )}
                    {suggestError && <p className="text-xs text-destructive">{suggestError}</p>}
                    {selectedLabels.filter(isSelectableLabelName).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selectedLabels.filter(isSelectableLabelName).map((name) => {
                          const label = labels.find((l) => l.name === name);
                          return (
                            <span
                              key={name}
                              className="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                              style={getLabelBadgeStyle(label?.color ?? "#64748b")}
                            >
                              {name}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 実装オプション（`21.plan-required`等）はここでは選ばせない（#1580）。
                どこでエージェントを止めるかの指定で、実行先が決まって初めて意味が決まるものが
                混ざっている（撮影は無人実行専用・アーティファクトはローカル実行専用）。
                起票の時点では実行先も実施時期も未定なので、「実装を開始」ダイアログで選ぶ */}

            {/* 質問Issueに担当者は要らない（人が引き取る作業ではなく、Claudeが答えて終わる） */}
            {step === "confirm" && !isQuestion && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-issue-assignee">担当者</Label>
                <Select value={assignee ?? "__none__"} onValueChange={handleAssigneeChange}>
                  <SelectTrigger
                    id="create-issue-assignee"
                    className="h-9 w-full"
                    disabled={isMetaLoading}
                  >
                    <SelectValue placeholder="担当者を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未設定</SelectItem>
                    {assignees.map((login) => (
                      <SelectItem key={login} value={login}>
                        {login}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <ApiErrorMessage message={error ?? commentError} />
          </div>

          {step === "input" ? (
            <DialogFooter>
              {/* 推定を挟まず従来のフォームへ行く口。自動生成が失敗したときの行き先でもある */}
              <Button variant="ghost" className="sm:mr-auto" onClick={handleSkipSuggestion}>
                自分で入力する
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                キャンセル
              </Button>
              <Button
                onClick={handleProceedToConfirm}
                disabled={!canProceedFromInput(body) || isImageUploading || isQuickSuggesting}
              >
                {isQuickSuggesting ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                次へ
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button variant="ghost" className="sm:mr-auto" onClick={handleBackToInput}>
                <ArrowLeft />
                戻る
              </Button>
              {/* 質問は実装の対象ではないため「作成+実装開始」を出さない（#1641）。
                  Actionsが使えないリポジトリでもこのボタンは塞がない（#1262と同じ判断・#1323）。
                  実行先の選択がこの先のダイアログにある以上、押せないとサブPCでの起動まで塞がる。
                  理由はダイアログのGitHub Actionsの選択肢の説明として出す */}
              {!isQuestion && (
                <Button
                  variant="secondary"
                  onClick={handleCreateAndStart}
                  disabled={
                    isSubmitting ||
                    isQuickSuggesting ||
                    !repositoryFullName ||
                    !title.trim() ||
                    isImageUploading
                  }
                >
                  {isSubmitting ? "作成中..." : "作成+実装開始"}
                </Button>
              )}
              <Button
                onClick={handleSubmit}
                disabled={
                  isSubmitting ||
                  isQuickSuggesting ||
                  !repositoryFullName ||
                  isImageUploading ||
                  (isQuestion ? !body.trim() : !title.trim())
                }
              >
                {isQuestion
                  ? isSubmitting
                    ? "送信中..."
                    : "質問する"
                  : isSubmitting
                    ? "作成中..."
                    : "作成"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {/* 作成直後のオプション・実行先の選択（#1323・#1580）。実行先の既定はサブPCで、
          GitHub Actionsはフォールバック。作成フォームは閉じているため、Dialogの外側に並べて描画する */}
      {startTargetIssue && (
        <StartImplementationDialog
          issue={startTargetIssue}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setStartTargetIssue(null);
          }}
          // ラベル・コメント数の変化は、作成時と同じ経路（onCreated）で呼び出し側へ渡す。
          // 既存分があれば更新されるため、同じIssueが二重に並ぶことはない
          onIssueUpdated={(updated) => {
            // **閉じた後に届いた更新で開き直さない**（#1434）。この`startTargetIssue`は
            // 表示するIssueと開閉状態を兼ねており、素直に代入すると`null`（閉じた状態）へ
            // 戻したものが復活する。サブPCを選んだ場合、ダイアログはジョブを積めた時点で
            // 閉じ、その後に`11.local`の付与（GitHubへの往復）の結果がここへ届くため、
            // 閉じた1秒ほど後に実行先の選択が出し直されていた。しかも積んだジョブで
            // 選んだホスト自体が塞がるため、選んだ実行先が消えた状態で開き直っていた。
            setStartTargetIssue((prev) => (prev ? updated : prev));
            onCreated(updated);
          }}
          onCommentCreated={() => {}}
          includeDispatchTargets
          actionsDisabledReason={startImplementationDisabledReason(
            startTargetRepository?.hasClaudeWorkflow,
          )}
          localSessionCommand={
            canStartLocalSession(startTargetRepository?.hasLocalStartScript)
              ? buildLocalSessionCommand(
                  startTargetIssue.repositoryFullName,
                  startTargetIssue.number,
                )
              : null
          }
          // 作成した直後なのでコメントも親子関係も無い。「取得していません」と書かせないよう空で渡す
          subIssueRelations={{ parent: null, children: [], childCount: 0 }}
        />
      )}
    </>
  );
}
