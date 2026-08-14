"use client";

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

import { useGithubReferenceNavigation } from "@/components/dashboard/github-reference-navigation";
import { parseGithubReferenceUrl, type GithubReference } from "@/lib/github-reference";

type GithubReferenceLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  /** リンク先のGitHub URL。アプリ内で開けない場合はこのURLがそのまま使われる */
  href: string;
  /**
   * 参照先。省略した場合は`href`から推定する。PR一覧のように「URLは持っていないが
   * どのPRかは分かっている」場所では明示的に渡す。
   */
  reference?: GithubReference | null;
  children: ReactNode;
};

/**
 * Issue・PRへのリンク（#1260）。
 *
 * `<a href="https://github.com/...">`のまま出しておき、**通常クリックのときだけ**
 * アプリ内遷移へ差し替える。Ctrl/⌘クリック・中クリック・「新しいタブで開く」は
 * 従来どおりGitHubを開けるようにしておきたいため、`<button>`ではなくアンカーにしている
 * （リンクとしてコピーもできる）。
 *
 * 遷移先が分からない場合（`reference`が解決できない、providerが無い）は、素の外部リンクに
 * なるだけで壊れない。
 */
export function GithubReferenceLink({
  href,
  reference,
  children,
  onClick,
  target = "_blank",
  rel = "noopener noreferrer",
  ...props
}: GithubReferenceLinkProps) {
  const navigation = useGithubReferenceNavigation();
  const resolved = reference !== undefined ? reference : parseGithubReferenceUrl(href);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || !resolved || !navigation) return;
    // 修飾キー付き・左ボタン以外は「別で開きたい」意思表示なので、ブラウザに任せる。
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigation.openReference(resolved);
  }

  return (
    <a href={href} target={target} rel={rel} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
