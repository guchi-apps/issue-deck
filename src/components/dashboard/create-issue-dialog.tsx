"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  MessageCircleQuestion,
  Plus,
  SquareArrowOutUpRight,
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
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { askClaudeCommentBody, buildAskRepoQuestionTitle } from "@/lib/github/ask-claude";
import { composeIssueBody } from "@/lib/github/followup-issue";
import {
  isSelectableLabelName,
  startImplementationDisabledReason,
} from "@/lib/github/start-implementation";
import { openIssueCreateWindow, type IssueCreateHandoff } from "@/lib/issue-create-window";
import { isAutoAssignableLabelName } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import { cn } from "@/lib/utils";
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
 * 「タイトル・ラベルを付与」実行時の選択ラベルを算出する。
 *
 * **リセットするのは自動付与の対象になるラベル（30〜89番台。71番台を除く。#1662）だけ。**
 * 生成結果に出てこないラベル——進捗管理用・実装オプション用に加えて、人が手で選んだ
 * `11.local`や`90.Close: *`——までリセットすると、付与のたびに黙って消え、
 * 生成結果からは二度と復活しない。
 */
export function mergeSuggestedLabels(prev: string[], suggested: string[]): string[] {
  return [
    ...prev.filter((name) => !isAutoAssignableLabelName(name)),
    ...new Set(suggested.filter(isAutoAssignableLabelName)),
  ];
}

/**
 * 種別を切り替えたときに残すリポジトリを決める（#1641）。
 *
 * **質問は`claude-issue-dispatch.yml`が導入済みのリポジトリでしか成立しない**（回答するのが
 * GitHub Actionsのmode=askのため）。Issueへ戻すときは絞り込みが無いので、選択をそのまま残す。
 *
 * **質問で選べない値だったときは、代わりを入れずに未選択へ戻す**（#1884）。以前は導入済みの
 * 先頭1件を入れていたが、リポジトリを人が決める形にした以上、種別を押しただけで選んでいない
 * リポジトリが入る経路は残せない（入った印を出す手立ても無くなった）。
 */
export function resolveKindRepository(
  kind: IssueDraftKind,
  repositories: ConnectedRepository[],
  current: string,
): string {
  if (kind === "issue" || current === "") return current;
  const askable = repositories.filter((repo) => repo.hasClaudeWorkflow);
  return askable.some((repo) => repo.fullName === current) ? current : "";
}

/**
 * 「内容から質問のようです」の行の状態（#1890）。`switched`だけが、戻すときの行き先として
 * 切り替える前のリポジトリを持つ。**質問では選べないリポジトリが未選択へ戻される**
 * （`resolveKindRepository`）ため、`fullName`だけでなく「人が選んだ値か」も一緒に覚えておく
 * ——戻したときに`表示中のリポジトリ`バッジの出方まで元へ揃える。
 */
type QuestionHint =
  | { phase: "suggested" }
  | { phase: "switched"; previousRepository: { fullName: string; picked: boolean } };

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

/**
 * リポジトリの選択肢。
 *
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

/**
 * 出し方（#1728）。`window`はこのフォームだけを表示する別ウィンドウ（`/issues/new`）の中身。
 * **項目も手順も共通で、変わるのは外枠と「キャンセル」の意味だけ。**
 */
export type CreateIssuePresentation = "dialog" | "window";

/**
 * 別ウィンドウ用の外枠（#1728）。Radixの`DialogTitle`等はダイアログの文脈の外では使えないため、
 * 見た目を合わせた素の要素へ差し替える。上下の帯を固定し、中身だけがスクロールする。
 */
function WindowHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 border-b px-4 py-3", className)} {...props} />;
}

function WindowTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1 className={cn("font-heading text-base leading-none font-medium", className)} {...props} />
  );
}

function WindowDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

function WindowFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

type Chrome = {
  Header: ComponentType<{ className?: string; children?: React.ReactNode }>;
  Title: ComponentType<{ className?: string; children?: React.ReactNode }>;
  Description: ComponentType<{ className?: string; children?: React.ReactNode }>;
  Footer: ComponentType<{ className?: string; children?: React.ReactNode }>;
};

// レンダーのたびに作ると中身ごと作り直しになる（入力中のフォーカスが飛ぶ）ため、モジュールで持つ
const DIALOG_CHROME: Chrome = {
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Footer: DialogFooter,
};

const WINDOW_CHROME: Chrome = {
  Header: WindowHeader,
  Title: WindowTitle,
  Description: WindowDescription,
  Footer: WindowFooter,
};

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
  /** 出し方（#1728）。既定はダイアログ */
  presentation?: CreateIssuePresentation;
  /**
   * 別ウィンドウへ移したときに引き継ぐ入力内容（#1728）。渡されたときは保存済み下書きの
   * 提示（「復元する」）を出さない——移してきた内容がすでに入っているため、選ばせる意味が無い。
   */
  initialHandoff?: IssueCreateHandoff | null;
  /** 取り消しボタンの文言。別ウィンドウでは閉じ方が変わるため差し替える */
  cancelLabel?: string;
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
 * ## 1画面（#1884）
 *
 * 種別・リポジトリ・内容・タイトル・ラベル・担当者を**すべて1画面に並べる**。#1605で入れた
 * 2ステップ（内容だけを書く`input` → 推定結果を確かめる`confirm`）は廃止した。
 *
 * **自動で決めるのはタイトルとラベルだけで、それも押したときにしか動かない。** タイトルが
 * 空のあいだは主ボタンが「タイトル・ラベルを付与」になり、押すと同じ画面の欄が埋まる
 * （`POST /api/issues/suggest`）。埋まったら主ボタンは「作成」へ戻り、付け直しはラベル欄の
 * 横に出る——同じことをする口を2つ同時に出さない。
 *
 * **リポジトリは人が決める**（#1884）。初期値になるのは「開いていた画面のリポジトリ」だけで、
 * 分からなければ未選択のまま選ばせる。内容からの推定（`/api/issues/quick-suggest`）は廃止した。
 * 推定を挟むと、押した本人が読んでいない先へIssueが立ち、そのリポジトリの無人実行の母集団に入る。
 *
 * ## 別ウィンドウ（#1728）
 *
 * `presentation="window"`のときは、外枠だけを差し替えて`/issues/new`のページ本体になる。
 * **項目・手順・作成後の動きは共通のまま**にする——別ウィンドウ用にフォームをもう一つ作ると、
 * 以降の変更を2か所へ入れ続けることになり、片方だけ古くなる。
 *
 * 移す入口はこのダイアログの中（見出し右の「別ウィンドウで開く」）だけで、ヘッダー等からは
 * 開かない。書き始めてから移りたくなるのが元の使い方で、入口を増やすと同じ物を作る導線が並ぶ。
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
  presentation = "dialog",
  initialHandoff = null,
  cancelLabel,
}: CreateIssueDialogProps) {
  const isWindow = presentation === "window";
  const Chrome = isWindow ? WINDOW_CHROME : DIALOG_CHROME;
  const { createIssue, isSubmitting: isCreatingIssue, error, setError } = useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();
  const isSubmitting = isCreatingIssue || isCreatingComment;

  const [kind, setKind] = useState<IssueDraftKind>("issue");
  /**
   * 画面に出ている値のうち、Claudeが入れたまま人が触っていないもの（#1605）。
   * `自動`バッジを出す対象で、ユーザーが直した時点でその項目は外れる。
   */
  const [autoFilled, setAutoFilled] = useState<{ title: boolean; labels: boolean }>({
    title: false,
    labels: false,
  });
  /**
   * 付与を押したのにラベルが1つも決まらなかったか（#1710）。
   * **黙って空のまま進めない。** 空欄と「決められなかった」は画面上で見分けが付かず、
   * ラベルの付いていないIssueがそのまま作られていた。
   */
  const [labelSuggestionMissed, setLabelSuggestionMissed] = useState(false);
  /**
   * 内容が質問だと判定されたときに、種別の下へ出す行（#1890）。
   *
   * - `suggested` … 判定しただけの状態。**種別もリポジトリも変えていない。** 押さなければ従来どおりIssueとして作られる
   * - `switched` … 「質問に切り替える」を押した後。戻したときの行き先として、押す前のリポジトリを持つ
   *
   * **判定で種別を勝手に変えない**のが要点。#1641が本文からの自動判定を見送ったのは、誤判定が
   * 押した本人から見えないまま実装フローに乗るためで、提案にとどめればその状態は作れない。
   */
  const [questionHint, setQuestionHint] = useState<QuestionHint | null>(null);
  /**
   * 提案を出したときに、そこまで画面を寄せるための参照（#1890）。
   *
   * **判定を起こすボタン（「タイトル・ラベルを付与」）はフッターにあり、提案を出す種別欄は
   * フォームの先頭にある。** ダイアログは中身ごとスクロールする（`DialogContent`の
   * `overflow-y-auto`）ため、本文が長いときやスマホ幅では、押した時点で種別欄は画面外にある。
   * 提案が見えないまま作成まで進めると、#1641が避けたかった「押した本人から見えない」に戻る。
   * `block: "nearest"`なので、すでに見えているときは動かない。
   */
  const questionHintRef = useRef<HTMLDivElement>(null);
  /**
   * いま開いている回のぶんの初期化を済ませたか（#2354）。
   *
   * **フォームを初期状態へ戻してよいのは、閉じた状態から開いた瞬間だけ。** 開いている
   * あいだに初期値（`defaultRepositoryFullName`等）が変わっても入力へ触らない。
   */
  const initializedForOpenRef = useRef(false);
  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  /**
   * リポジトリを**人が選び直したか**（#1710・#1884）。`表示中のリポジトリ`バッジを消す判断に使う。
   * 開いていた画面から渡された値は「そこを開いていた」という理由でしかないため、人が触るまでは
   * 出どころを示したままにする。
   */
  const [hasPickedRepository, setHasPickedRepository] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [restorableDraft, setRestorableDraft] = useState<IssueDraft | null>(null);
  /** 別ウィンドウがブラウザに止められたか（#1728）。黙って何も起きないと壊れて見える */
  const [popOutBlocked, setPopOutBlocked] = useState(false);
  /**
   * 「作成+実装開始」で作成したIssue（#1323）。**入っている間だけ「実装を開始」を出す。**
   * このダイアログ自体は閉じているので、そちらはDialogの外側に並べて描画する。
   */
  const [startTargetIssue, setStartTargetIssue] = useState<Issue | null>(null);

  const { labels, isLoading: isMetaLoading } = useIssueRepoMeta(
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
  const {
    isGenerating: isSuggesting,
    error: suggestError,
    notConfigured: suggestNotConfigured,
    generate: generateSuggestion,
  } = useIssueSuggest();
  /**
   * タイトルが空か（#1884）。**主ボタンが「付与」か「作成」かを決める唯一の材料。**
   * 質問はタイトルを質問文から機械生成するため、この分岐に入らない。
   */
  const needsTitle = !isQuestion && !title.trim();
  /** 「タイトル・ラベルを付与」を押せるか。材料（本文）と付け先（リポジトリのラベル一覧）が要る */
  const canSuggest =
    Boolean(body.trim()) && Boolean(repositoryFullName) && !isMetaLoading && !isSuggesting;

  useEffect(() => {
    if (!open) {
      // 閉じた時点で「次に開いたら初期化する」へ戻す
      initializedForOpenRef.current = false;
      return;
    }
    // **開いている間は二度と初期化しない**（#2354）。以前は初期値（画面のリポジトリ・
    // プリフィル）が変わるたびにここが走り、書いている最中でも選んだリポジトリと本文が
    // 初期状態へ戻せる作りだった。人が選び直したリポジトリがひとりでに変わる、という
    // 現象の唯一のコード上の経路がここで、押した本人には何が起きたのか見えない。
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;
    // ダイアログを開くたびにフォームを初期状態へ戻す。明示的なプリフィル（引用元テキスト等）が
    // 渡されていればそちらを優先し、それ以外は空の状態にする（保存済みの下書きは自動では
    // 反映せず、readRestorableIssueDraftの結果をユーザーが「復元する」で選んだ場合のみ反映する）。
    // 外部トリガー（開閉）に同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    // 別ウィンドウへ移してきた内容があればそれを正とする（#1728）
    const draft =
      initialHandoff ??
      resolveInitialIssueDraft({
        defaultRepositoryFullName,
        defaultTitle,
        defaultBody,
      });
    setKind(draft.kind);
    // 移してきた値は「人が書いたもの」として扱う。`自動`の出どころは移す前の画面に残っており、
    // ここで復元すると、直したはずの項目まで自動と書かれかねない
    setAutoFilled({ title: false, labels: false });
    setLabelSuggestionMissed(false);
    setQuestionHint(null);
    setRepositoryFullName(draft.repositoryFullName);
    // 移してきたリポジトリは、移す前の画面で人が選んだものかどうかまでは分からない。
    // 触っていない扱いにすると`表示中のリポジトリ`が出るが、`defaultRepositoryFullName`も
    // 同じ値で渡ってくるため表示は移す前と揃う
    setHasPickedRepository(false);
    setTitle(draft.title);
    setBody(draft.body);
    setSelectedLabels(draft.selectedLabels);
    setIsImageUploading(false);
    setError(null);
    setCommentError(null);
    setPopOutBlocked(false);
    // 引き継ぎ（bodyPrefix）は本文の入力欄を空のまま始めるため、保存済み下書きの提示は止めない
    // （#1322）。閉じてしまった引き継ぎ作成の入力を復元でき、復元しても接頭辞は消えない。
    setRestorableDraft(
      initialHandoff
        ? null
        : readRestorableIssueDraft({ defaultRepositoryFullName, defaultTitle, defaultBody }),
    );
  }, [
    open,
    defaultRepositoryFullName,
    defaultTitle,
    defaultBody,
    initialHandoff,
    setError,
    setCommentError,
  ]);

  // 担当者は画面の状態として持たない（#1929）。下書きにも入れない——開いて何も書かずに
  // 閉じただけの下書きが「空ではない」と判定され、次に開いたとき「復元する」が出てしまう
  useIssueDraftAutosave(open, {
    kind,
    repositoryFullName,
    title,
    body,
    selectedLabels,
    assignee: null,
  });

  // 提案が出たら、押した人の視線がある場所からでも見えるところまで寄せる（#1890）
  useEffect(() => {
    if (questionHint?.phase !== "suggested") return;
    questionHintRef.current?.scrollIntoView({ block: "nearest" });
  }, [questionHint?.phase]);

  /**
   * 種別を切り替える。質問で選べないリポジトリを選んでいた場合は未選択へ戻す（#1641・#1884）。
   * 戻した後は選ばせる側なので、「人が選んだ」印は降ろす。
   */
  function selectKind(next: IssueDraftKind) {
    const resolved = resolveKindRepository(next, repositories, repositoryFullName);
    setKind(next);
    setRepositoryFullName(resolved);
    if (resolved !== repositoryFullName) setHasPickedRepository(false);
    // 種別を人が決めた時点で提案は役目を終える（#1890）。切り替え・戻すの各ボタンは、
    // これを呼んだあとで自分の状態を立て直す
    setQuestionHint(null);
  }

  /** 提案の「質問に切り替える」（#1890）。戻す先として、切り替える前のリポジトリを覚えておく */
  function handleSwitchToQuestion() {
    const previousRepository = { fullName: repositoryFullName, picked: hasPickedRepository };
    selectKind("question");
    setQuestionHint({ phase: "switched", previousRepository });
  }

  /**
   * 提案の「Issueに戻す」（#1890）。種別を戻すだけでは、質問で選べず未選択になった
   * リポジトリが空のまま残るため、押す前の値を入れ直す。
   */
  function handleRevertToIssue() {
    const previous = questionHint?.phase === "switched" ? questionHint.previousRepository : null;
    selectKind("issue");
    if (previous) {
      setRepositoryFullName(previous.fullName);
      setHasPickedRepository(previous.picked);
    }
  }

  /**
   * 書いている内容ごと別ウィンドウへ移す（#1728）。
   *
   * **開けたときだけダイアログを閉じる。** ポップアップを止められたときに閉じてしまうと、
   * 書いていた内容の行き先が画面から消える（下書きには残るが、それは人が復元を選ぶもの）。
   */
  function handlePopOut() {
    const opened = openIssueCreateWindow({
      kind,
      repositoryFullName,
      title,
      body,
      selectedLabels,
      assignee: null,
      bodyPrefix: bodyPrefix ?? null,
    });
    if (!opened) {
      setPopOutBlocked(true);
      return;
    }
    onOpenChange(false);
  }

  function handleRestoreDraft() {
    if (!restorableDraft) return;
    // 下書きは書いていたときの種別ごと戻す（質問の書きかけを復元してIssueとして作らない）
    setKind(restorableDraft.kind);
    // **書いていたときに選んでいたリポジトリを優先する**（#2354）。以前は開いていた画面の
    // リポジトリが優先されており、別のリポジトリで書いた下書きを復元すると、中身だけが
    // 別のリポジトリへ入った状態になっていた。連携が外れて選択肢に無い値は、欄が空に見えるのに
    // 値だけ残るのを避けるため開いていた画面の値へ落とす
    const draftRepository = repositories.some(
      (repo) => repo.fullName === restorableDraft.repositoryFullName,
    )
      ? restorableDraft.repositoryFullName
      : (defaultRepositoryFullName ?? "");
    const restoredRepository = resolveKindRepository(
      restorableDraft.kind,
      repositories,
      draftRepository,
    );
    setRepositoryFullName(restoredRepository);
    // 書いていたときに入っていた値は本人が決めたものとして扱う（#1733）
    setHasPickedRepository(restoredRepository !== "");
    setTitle(restorableDraft.title);
    setBody(restorableDraft.body);
    // 実装オプション用ラベル（`21.plan-required`等）は#1580でこの画面から選べなくなったが、
    // それ以前に保存された下書きには残っている。画面に出ないラベルが黙って付かないよう濾す
    setSelectedLabels(restorableDraft.selectedLabels.filter(isSelectableLabelName));
    // 担当者は下書きから戻さない（#1929）。固定値をeffectが入れ直す
    setRestorableDraft(null);
    setAutoFilled({ title: false, labels: false });
    setLabelSuggestionMissed(false);
    setQuestionHint(null);
  }

  function resetForm() {
    setKind("issue");
    setAutoFilled({ title: false, labels: false });
    setLabelSuggestionMissed(false);
    setQuestionHint(null);
    setRepositoryFullName("");
    setHasPickedRepository(false);
    setTitle("");
    setBody("");
    setSelectedLabels([]);
  }

  function toggleLabel(name: string) {
    setAutoFilled((prev) => ({ ...prev, labels: false }));
    setLabelSuggestionMissed(false);
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  function handleRepositoryChange(value: string) {
    setHasPickedRepository(true);
    setRepositoryFullName(value);
  }

  function handleTitleChange(value: string) {
    setAutoFilled((prev) => ({ ...prev, title: false }));
    setTitle(value);
  }

  /**
   * 「タイトル・ラベルを付与」（#1884）。タイトルが空のあいだは主ボタン、入っていれば
   * ラベル欄の横の「付け直す」から呼ばれる。**画面は切り替わらず、同じ欄が埋まるだけ。**
   *
   * 失敗しても作成は止めない——値が空のまま自分で書ける状態が残る。
   */
  async function handleGenerateSuggestion() {
    const result = await generateSuggestion(
      body,
      labels.map((label) => ({ name: label.name, description: label.description })),
    );
    if (!result) return;
    setTitle(result.title);
    setSelectedLabels((prev) => mergeSuggestedLabels(prev, result.labels));
    setAutoFilled({ title: true, labels: result.labels.length > 0 });
    setLabelSuggestionMissed(result.labels.length === 0);
    // 内容が質問だと判定されたときだけ提案を出す（#1890）。**ここでは種別を変えない。**
    // この関数はタイトルが空のIssue（主ボタン）か「付け直す」からしか呼ばれないので、
    // 種別が「質問」の状態で通ることはない
    if (result.kind === "question") setQuestionHint({ phase: "suggested" });
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
      assignee: DEFAULT_ASSIGNEE,
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
      assignee: DEFAULT_ASSIGNEE,
    });
    if (!issue) return;

    resetForm();
    clearIssueDraft();
    // 別ウィンドウでは`onOpenChange(false)`がウィンドウを閉じる操作なので、ここでは呼ばない
    // （#1728）。閉じると、この後に出す実行先の選択ごと消える。閉じるのは選択が終わった時点
    if (!isWindow) onOpenChange(false);
    onCreated(issue);
    setStartTargetIssue(issue);
  }

  /**
   * Cmd/Ctrl+Enterでの確定（#1884）。**タイトルが空のときは付与を走らせる。**
   * 画面の主ボタンと同じものが動く形にしておかないと、押した結果が予想できない。
   */
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (needsTitle) {
      if (canSuggest) void handleGenerateSuggestion();
      return;
    }
    void handleSubmit();
  }

  /**
   * 見出し（#1929）。**Issueのときは説明文を画面に出さない。** 「内容を書いて作成します」は
   * 画面を見れば分かることをスマホで2行使って書いていた。質問は作成後の動き（回答が
   * コメントで返るまで待つ）が画面から読めないため、そちらだけ残す。
   *
   * 消すのは見た目だけで、要素は`sr-only`で残す——`DialogContent`の説明として読み上げに
   * 使われており、無くすとRadixが警告を出す。
   */
  const header = (
    <Chrome.Header>
      <Chrome.Title>{isQuestion ? "リポジトリに質問する" : "新しいIssueを作成"}</Chrome.Title>
      <Chrome.Description className={isQuestion ? undefined : "sr-only"}>
        {isQuestion
          ? "質問内容でIssueを自動作成し、Claudeに質問します。回答はコメントとして返るまで数十秒〜数分かかります。"
          : "内容を書いて作成します。タイトル・ラベルは押したときだけ自動で付きます。"}
      </Chrome.Description>
    </Chrome.Header>
  );

  const fields = (
    <>
      {restorableDraft && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
          <span>保存された下書きがあります</span>
          <Button variant="outline" size="xs" onClick={handleRestoreDraft}>
            復元する
          </Button>
        </div>
      )}

      {/* 項目の間隔は`gap-3`（#1929）。スマホで一画面に収めるための詰めで、
          1項目あたり4pxでも6項目ぶん積まれると見出しの説明文1行ぶんに相当する */}
      <div className="flex flex-col gap-3">
        {/* 種別（#1641）。**本文の内容で勝手に切り替えない。** 誤判定は押した本人から
            見えないまま、質問のつもりの本文が実装Issueとして無人実行に乗る（逆もある）
            という取り返しの付きにくい間違いになるため、決めるのは押した人にする。
            判定して「質問に切り替えますか」と提案するところまでは行う（下の`questionHint`・#1890）

            見出しとボタンは同じ行に置く（#1929）。選択肢が2つで横幅が余っており、
            見出しだけで1行使う理由が無い */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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

        {/* 内容が質問だと判定されたときの提案（#1890）。**種別のすぐ下に置く。**
            提案しているのは種別の変更で、押した結果が変わるのも真上のボタンなので、
            離して置くと何が切り替わったのかが読めない。色は質問コメント
            （comment-thread.tsx）と揃えて青にし、画面をまたいで「青い囲み＝質問」で読めるようにする */}
        {questionHint?.phase === "suggested" && (
          <div
            ref={questionHintRef}
            className="flex flex-col gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2.5"
          >
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">内容から質問のようです</span>
              <p className="text-xs text-muted-foreground">
                「質問」にすると、コードは変更されず回答コメントだけが返ります。Issueのままにすると、
                これまでどおり実装の対象になります。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" onClick={handleSwitchToQuestion}>
                質問に切り替える
              </Button>
              <Button variant="outline" size="xs" onClick={() => setQuestionHint(null)}>
                Issueのままにする
              </Button>
            </div>
          </div>
        )}

        {/* 切り替えた直後だけ出す（#1890）。種別の見た目も変わっているが、押した操作を
            1タップで取り消せる口をその場に残す */}
        {questionHint?.phase === "switched" && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">質問に切り替えました。</span>
            <Button variant="outline" size="xs" onClick={handleRevertToIssue}>
              Issueに戻す
            </Button>
          </div>
        )}

        {/* リポジトリ（#1884）。**初期値になるのは開いていた画面のリポジトリだけで、
            内容からの推定はしない。** 分からなければ未選択のまま選ばせる——押した本人が
            読んでいない先へIssueが立つと、そのリポジトリの無人実行の母集団に入る */}
        <div className="flex flex-col gap-1.5">
          {/* バッジは`Label`の外に置く。中に入れるとアクセシブルネームが
              「リポジトリ表示中のリポジトリ」になり、項目名で引けなくなる */}
          <div className="flex items-center gap-1.5">
            <Label htmlFor="create-issue-repo">リポジトリ</Label>
            {!hasPickedRepository &&
              repositoryFullName !== "" &&
              repositoryFullName === defaultRepositoryFullName && <PageBadge />}
          </div>
          {hasSelectableRepository ? (
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
          {/* 補足文は質問のときだけ出す（#1929）。「どのリポジトリの話かを選んでください」は
              選択欄の`リポジトリを選択`と同じことしか言っておらず、`表示中のリポジトリ`の説明も
              バッジの文字がそのまま説明になっている。質問は**選択肢が減っている理由**という
              画面から読めないことを書いているため残す */}
          {hasSelectableRepository && isQuestion && (
            <p className="text-xs text-muted-foreground">
              回答するのはGitHub Actionsのため、claude-issue-dispatch.yml導入済みのリポジトリだけ選べます。
            </p>
          )}
        </div>

        {/* タイトルはリポジトリと内容の間に置く（#1929）。**「どこへ」→「何を」→「詳しく」の
            順に並べる。** 内容の下にあると、付与で埋まったタイトルを確かめるのに書き終えた本文を
            越えて下へ探しに行くことになり、スマホでは本文の長さぶんだけ離れる */}
        {isQuestion ? (
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
            {/* 空のままでも行き止まりにしない（#1884）。**下の主ボタンが何をするかは、
                補足の行ではなくプレースホルダで示す**（#1929）——空欄のときにだけ出る点は
                同じで、行が増えない */}
            <Input
              id="create-issue-title"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="空欄なら「タイトル・ラベルを付与」で作れます"
              className="md:text-sm"
            />
          </div>
        )}

        {/* 本文の入力欄は種別で変えない（#1641）。質問でも画像の貼り付け・ドラッグ&ドロップと
            `#123`のIssue補完が使えるようにするのがこの統合の主目的で、以前の質問ダイアログは
            素のTextareaだったためどちらも使えなかった */}
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
            placeholder={isQuestion ? "質問内容を入力してください" : "何をしたいかを書いてください"}
            className="min-h-32 md:text-sm"
            // 「画像を添付」と同じ行へ寄せる（#1929）。プレビューは出さない——貼った画像は
            // サムネイルで見えており、書きかけを切り替えて確かめる場面が無い
            showPreviewToggle={false}
            toolbarExtra={
              <BodyCleanupButton value={body} onCleaned={setBody} disabled={isSubmitting} />
            }
            autoFocus
          />
        </div>

        {/* ラベル（#1929）。見出し・選ぶ口・選んだ結果を同じ行にまとめる。
            数が増えれば折り返るので、選んだぶんだけ縦に伸びる */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-1.5">
              <Label>ラベル</Label>
              {autoFilled.labels && <AutoBadge />}
            </div>
            <LabelPicker
              labels={selectableLabels}
              selectedNames={selectedLabels}
              onToggle={toggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <Button variant="outline" className="h-9 w-fit px-3" disabled={isMetaLoading}>
                  {selectedLabels.length > 0 ? `ラベル (${selectedLabels.length})` : "ラベルを選択"}
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            {/* 付け直す口（#1884）。**主ボタンが「付与」になっている間は出さない**——
                同じことをする口が2つ並ぶと、どちらを押すのが正しいのか読めなくなる */}
            {!isQuestion && !needsTitle && (
              <Button
                variant="outline"
                size="xs"
                disabled={!canSuggest}
                onClick={handleGenerateSuggestion}
              >
                {isSuggesting ? <Loader2 className="animate-spin" /> : <Bot />}
                付け直す
              </Button>
            )}
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
          {/* ラベルが1つも決まらなかったことを明示する（#1710）。
              空欄と見分けが付かないままだと、ラベルの付かないIssueがそのまま作られる */}
          {labelSuggestionMissed && !suggestNotConfigured && (
            <p className="text-xs text-destructive">
              ラベルは自動で決められませんでした。選ぶか、付け直せます。
            </p>
          )}
          {suggestNotConfigured && (
            <p className="text-xs text-muted-foreground">
              Claudeのトークンが設定されていないため、自動では決められません。自分で入力してください。
            </p>
          )}
          {suggestError && <p className="text-xs text-destructive">{suggestError}</p>}
        </div>

        {/* 実装オプション（`21.plan-required`等）はここでは選ばせない（#1580）。
            どこでエージェントを止めるかの指定で、実行先が決まって初めて意味が決まるものが
            混ざっている（撮影は無人実行専用・アーティファクトはローカル実行専用）。
            起票の時点では実行先も実施時期も未定なので、「実装を開始」ダイアログで選ぶ */}

        {/* 担当者は`m-guchi`固定にし、選択欄は出さない（#1929）。選べる相手が実質1人しかおらず、
            毎回そのまま作成していた。**値は画面の状態として持たず、作成時に定数を送る。**
            以前は`/api/issues/meta`が返した割り当て可能ユーザーに`m-guchi`が居たときだけ
            入る初期値だったため、欄を消すと取得の失敗・遅延がそのまま「担当者なしのIssue」に
            なり、画面からは気づけなくなる。別の人に割り当てたい場合はIssue詳細かGitHub側で変える。
            質問Issueにはもともと担当者を付けない（人が引き取る作業ではなく、Claudeが答えて終わる） */}

        {/* 別ウィンドウを開けなかったときだけ出す（#1728）。押しても何も起きないと、
            ボタンが壊れているのか自分の環境の設定なのかが分からない */}
        {popOutBlocked && (
          <p className="text-xs text-destructive">
            ブラウザが別ウィンドウを止めました。このサイトのポップアップを許可してください。
          </p>
        )}

        <ApiErrorMessage message={error ?? commentError} />
      </div>
    </>
  );

  /**
   * 操作ボタン（#1884）。**並べる順は「キャンセル → 副 → 主」で固定する。**
   * フッターはスマホで`flex-col-reverse`（DOMの先頭が最下段）になるため、この順に置くと
   * 縦積みの一番上が主ボタン、一番下がキャンセルになる。
   */
  const footer = (
    <Chrome.Footer>
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        {cancelLabel ?? (isWindow ? "閉じる" : "キャンセル")}
      </Button>
      {/* 質問は実装の対象ではないため「作成+実装開始」を出さない（#1641）。
          Actionsが使えないリポジトリでもこのボタンは塞がない（#1262と同じ判断・#1323）。
          実行先の選択がこの先のダイアログにある以上、押せないとサブPCでの起動まで塞がる。
          理由はダイアログのGitHub Actionsの選択肢の説明として出す。
          タイトルが空のあいだは主ボタンが「付与」なので、こちらも出さない（#1884） */}
      {!isQuestion && !needsTitle && (
        <Button
          variant="secondary"
          onClick={handleCreateAndStart}
          disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
        >
          {isSubmitting ? "作成中..." : "作成+実装開始"}
        </Button>
      )}
      {needsTitle ? (
        <Button onClick={handleGenerateSuggestion} disabled={!canSuggest || isImageUploading}>
          {isSuggesting ? <Loader2 className="animate-spin" /> : <Bot />}
          タイトル・ラベルを付与
        </Button>
      ) : (
        <Button
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
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
      )}
    </Chrome.Footer>
  );

  return (
    <>
      {isWindow ? (
        // 別ウィンドウ（#1728）。ウィンドウ全体がこのフォームなので、見出しと操作を上下に固定し、
        // 項目だけをスクロールさせる。実行先の選択（作成+実装開始）が出ている間は、その後ろに
        // 作り終わったフォームを残さない
        !startTargetIssue && (
          <div className="flex h-full flex-col text-sm" onKeyDown={handleKeyDown}>
            {header}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{fields}</div>
            {footer}
          </div>
        )
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg" onKeyDown={handleKeyDown}>
            {header}
            {/* 書いている内容ごと別ウィンドウへ移す（#1728）。**スマホでは出さない**——
                ブラウザにウィンドウを並べる概念が無く、押しても別タブが開くだけで、
                一覧を見ながら書くという目的が成立しない */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-11 hidden md:inline-flex"
              title="別ウィンドウで開く"
              aria-label="別ウィンドウで開く"
              onClick={handlePopOut}
            >
              <SquareArrowOutUpRight />
            </Button>
            {fields}
            {footer}
          </DialogContent>
        </Dialog>
      )}
      {/* 作成直後のオプション・実行先の選択（#1323・#1580）。実行先の既定はサブPCで、
          GitHub Actionsはフォールバック。作成フォームは閉じているため、Dialogの外側に並べて描画する */}
      {startTargetIssue && (
        <StartImplementationDialog
          issue={startTargetIssue}
          open
          onOpenChange={(nextOpen) => {
            if (nextOpen) return;
            setStartTargetIssue(null);
            // 別ウィンドウでは、実行先を選び終えた（または閉じた）時点でウィンドウごと閉じる
            // （#1728）。作り終わったフォームだけが残っても、そこからできることは無い
            if (isWindow) onOpenChange(false);
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
