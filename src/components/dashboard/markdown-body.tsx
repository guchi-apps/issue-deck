"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { copyText } from "@/lib/copy-text";
import { hastToCopyText } from "@/lib/hast-text";
import { rehypeAbsolutizeRelativeUrls } from "@/lib/rehype-absolutize-relative-urls";
import { rehypeLinkifyIssueRefs } from "@/lib/rehype-linkify-issue-refs";
import {
  rehypeTaskListItems,
  TASK_ITEM_ATTRIBUTE,
  TASK_LINE_ATTRIBUTE,
} from "@/lib/rehype-task-list-items";
import { remarkTrimCjkAutolink } from "@/lib/remark-trim-cjk-autolink";
import { cn } from "@/lib/utils";

// 一覧⇔詳細の行き来で再マウントされた際に画像の読み込みに失敗しても、代替テキストが
// 空だと何も表示されず「画像の部分が消えた」ように見えてしまう。読み込み失敗を
// 目に見える形で示し、再読み込みもできるようにする（#326）。
function MarkdownImage({ alt, src, ...props }: ComponentProps<"img">) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (failed) {
    return (
      <span className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
        画像を読み込めませんでした{alt ? `（${alt}）` : ""}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        >
          再読み込み
        </button>
      </span>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      key={attempt}
      src={src}
      alt={alt ?? ""}
      className="max-w-full rounded-md border"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );

  // 本文中の画像は表示幅が狭く内容を確認しづらいので、クリックで原寸を別タブに開けるようにする（#384）。
  if (typeof src !== "string" || src === "") return image;

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      title="画像を新しいタブで開く"
      className="inline-block cursor-zoom-in"
    >
      {image}
    </a>
  );
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
  },
};

const LINK_CLASS = "text-primary underline underline-offset-2";

/**
 * 本文・コメント中のリンク。GitHubのIssue・PRを指すものはIssueDeckの画面内で開き、
 * それ以外（外部サイト・Actionsのログなど）は従来どおり別タブで開く（#1260）。
 * `#123`形式の参照は`rehypeLinkifyIssueRefs`が既にGitHubのURLへ展開しているので、
 * ここでは区別せず同じ扱いになる。
 */
function MarkdownLink({ children, href, title }: ComponentProps<"a">) {
  // 受け取ったpropsをまとめて流さないのは、react-markdownがhastのノード（node）も渡してくるため。
  // DOMへ流すと無効な属性になる。リンクとして必要なのはhrefとtitleだけで、target・relは
  // GithubReferenceLinkが決める。
  if (typeof href !== "string" || href === "") {
    return (
      <a title={title} className={LINK_CLASS}>
        {children}
      </a>
    );
  }

  return (
    <GithubReferenceLink href={href} title={title} rel="noreferrer" className={LINK_CLASS}>
      {children}
    </GithubReferenceLink>
  );
}

export type TaskToggleHandler = (line: number, checked: boolean) => void;

const TASK_CHECKBOX_CLASS = "mr-1.5 size-3.5 shrink-0 translate-y-[0.15em] accent-primary";

/**
 * クリックできるタスクリストのチェックボックス（#1486）。
 *
 * `onToggle`にはこの項目が書かれている**元Markdownの行番号**を渡す（`rehypeTaskListItems`が
 * 付けたもの）。呼び出し側はその行だけを書き換えてIssue本文を更新する。
 */
function TaskCheckbox({
  line,
  checked,
  disabled,
  onToggle,
}: {
  line: number;
  checked: boolean;
  disabled: boolean;
  onToggle: TaskToggleHandler;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onToggle(line, event.target.checked)}
      aria-label={checked ? "このタスクのチェックを外す" : "このタスクにチェックを付ける"}
      className={cn(
        TASK_CHECKBOX_CLASS,
        "cursor-pointer disabled:cursor-progress disabled:opacity-60",
      )}
    />
  );
}

/**
 * フェンス付きコードブロック。右上のボタンでワンクリックコピーできる（#1726）。
 *
 * 手作業Issue（`71.manual-step`）の「やること」に並ぶコマンドを、スマホから手で範囲選択して
 * 取り出すのが実質不可能だったのが発端。横スクロールするブロックでは選択ハンドルが端まで
 * 届かない。
 *
 * **ホバーで出す方式にしない。** 主戦場がスマホでホバーが無いため、常に表示する。
 */
function CodeBlock({ node, children }: ComponentProps<"pre"> & { node?: unknown }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // 中身はhastから取る。`children`はReact要素なので文字列化できない
  const text = hastToCopyText(node as Parameters<typeof hastToCopyText>[0]);

  async function handleCopy() {
    const ok = await copyText(text);
    // コピーできていないのに成功表示を出さない（`dispatch-job-status.tsx`と同じ扱い）
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  const label =
    state === "copied" ? "コピーしました" : state === "failed" ? "コピーできませんでした" : "コードをコピー";

  // 中身が空のブロックにはコピーする相手がいない
  if (text === "") {
    return (
      <pre className="mb-3 overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem] last:mb-0">{children}</pre>
    );
  }

  return (
    <div className="relative mb-3 last:mb-0">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-11 text-[0.8125rem]">{children}</pre>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={label}
        title={label}
        className={cn(
          "absolute top-1.5 right-1.5 inline-flex size-7 cursor-pointer items-center justify-center",
          // 背景は不透明にする。横スクロール中はボタンの下にコードの続きが来るため、
          // 透かすと重なって読めなくなる
          "rounded-md border bg-background text-muted-foreground transition hover:text-foreground",
          state === "copied" && "text-primary",
          state === "failed" && "text-destructive",
        )}
      >
        {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {/* 押した結果は色とアイコンだけでは読み上げに乗らないので、状態を文字でも持たせる */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "idle" ? "" : label}
      </span>
    </div>
  );
}

const components: Components = {
  a: (props) => <MarkdownLink {...props} />,
  // `node`を捨てているのは、react-markdownがhastのノードも渡してくるため。そのままDOMへ
  // 流すと`node="[object Object]"`という無効な属性になる（#1499）。MarkdownImageは残りの
  // propsを`<img>`へ流すので、ここで落とす必要がある。
  img: ({ node, ...props }) => <MarkdownImage {...props} />,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  // `img`と同じく`node`を捨てる（#1499）。
  code: ({ node, className, children, ...props }) => (
    <code {...props} className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem]", className)}>
      {children}
    </code>
  ),
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  h1: ({ children }) => <h3 className="mb-2 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold">{children}</h3>,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  // タスク項目は箇条書きのマーカーを消し、チェックボックスを行頭に置く（GitHubと同じ見た目）。
  // 親の`ul`が`pl-5`なので、消したマーカーのぶんだけインデントを戻す。
  li: ({ children, node }) =>
    node?.properties?.[TASK_ITEM_ATTRIBUTE] === true ? (
      <li className="-ml-5 list-none">{children}</li>
    ) : (
      <li>{children}</li>
    ),
  // トグルを渡されていない場合（コメント・PR本文・AI要約）は表示のみ。`rehypeSanitize`の
  // 既定スキーマが`input`へ`disabled`を強制するので、ここでも読み取り専用のまま描く。
  input: ({ node, ...props }) =>
    typeof node?.properties?.[TASK_LINE_ATTRIBUTE] === "number" ? (
      <input type="checkbox" checked={props.checked === true} disabled readOnly className={TASK_CHECKBOX_CLASS} />
    ) : (
      <input {...props} />
    ),
};

type MarkdownBodyProps = {
  content: string;
  className?: string;
  repositoryFullName?: string;
  /**
   * タスクリストのチェックをクリックできるようにする（#1486）。渡さない場合は表示のみ。
   * 引数は元Markdownでの行番号と、クリック後のチェック状態。
   */
  onToggleTask?: TaskToggleHandler;
  /** トグルの送信中。連打で本文の更新が競合しないよう、その間はチェックを受け付けない */
  isTaskToggling?: boolean;
};

export function MarkdownBody({
  content,
  className,
  repositoryFullName,
  onToggleTask,
  isTaskToggling = false,
}: MarkdownBodyProps) {
  const mergedComponents = useMemo<Components>(() => {
    if (!onToggleTask) return components;
    return {
      ...components,
      input: ({ node, ...props }) => {
        const line = node?.properties?.[TASK_LINE_ATTRIBUTE];
        if (typeof line !== "number") return <input {...props} />;
        return (
          <TaskCheckbox
            line={line}
            checked={props.checked === true}
            disabled={isTaskToggling}
            onToggle={onToggleTask}
          />
        );
      },
    };
  }, [onToggleTask, isTaskToggling]);

  return (
    <div className={cn("font-body text-[0.9375rem] leading-[1.9] break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkTrimCjkAutolink, remarkBreaks]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeLinkifyIssueRefs, { repositoryFullName }],
          rehypeAbsolutizeRelativeUrls,
          [rehypeSanitize, sanitizeSchema],
          // sanitizeの後に置く。`hast-util-sanitize`は`position`を保つので行番号を取れ、
          // 後から付けるのでスキーマへ`data-task-line`の許可を足さずに済む（#1486）
          rehypeTaskListItems,
        ]}
        components={mergedComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
