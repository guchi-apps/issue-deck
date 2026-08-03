"use client";

import { useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { rehypeLinkifyIssueRefs } from "@/lib/rehype-linkify-issue-refs";
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

  return (
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
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
  },
};

const components: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  img: (props) => <MarkdownImage {...props} />,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => (
    <code {...props} className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem]", className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem] last:mb-0">{children}</pre>
  ),
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
};

type MarkdownBodyProps = {
  content: string;
  className?: string;
  repositoryFullName?: string;
};

export function MarkdownBody({ content, className, repositoryFullName }: MarkdownBodyProps) {
  return (
    <div className={cn("font-body text-[0.9375rem] leading-[1.9] break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkTrimCjkAutolink, remarkBreaks]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeLinkifyIssueRefs, { repositoryFullName }],
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
