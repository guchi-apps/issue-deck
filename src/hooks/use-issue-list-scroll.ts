"use client";

import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  collectIssueListScrollAnchors,
  computeCenteredIssueListScrollTop,
  computeRestoredIssueListScrollTop,
  type IssueListItemOffset,
  type IssueListScrollPosition,
} from "@/lib/issue-list-scroll";

const STORAGE_KEY_PREFIX = "issue-deck:list-scroll:";

/**
 * localStorageではなくsessionStorageを使う。スクロール位置はタブ内での作業の続きを表す
 * 一時的な状態で、次回アクセス時まで持ち越すとむしろ意図しない位置から始まるため。
 * リロード（`window.location.reload()`を伴う再同期など）では保持される。
 */
function readPosition(scrollKey: string): IssueListScrollPosition | null {
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${scrollKey}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { anchors, scrollTop } = parsed as Partial<IssueListScrollPosition>;
    if (!Array.isArray(anchors) || typeof scrollTop !== "number") return null;
    return {
      anchors: anchors.filter(
        (anchor) =>
          typeof anchor?.issueId === "string" && typeof anchor?.offsetFromTop === "number",
      ),
      scrollTop,
    };
  } catch {
    // sessionStorageが使えない環境（Safariのプライベートモード等）・不正なJSONでは
    // 復元を諦めるだけで、一覧の表示自体は従来どおり継続する
    return null;
  }
}

function writePosition(scrollKey: string, position: IssueListScrollPosition) {
  try {
    window.sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${scrollKey}`, JSON.stringify(position));
  } catch {
    // 保存できなくても実害は「次回に位置が復元されない」だけのため握り潰す
  }
}

type UseIssueListScrollParams = {
  /** 一覧の文脈ごとの識別子。nullの場合は保存・復元を行わない */
  scrollKey: string | null;
  /** 表示順のIssue ID一覧 */
  issueIds: string[];
  /** 保存済み位置が無い場合に中央寄せする対象 */
  selectedIssueId: string | null;
  listRef: RefObject<HTMLUListElement | null>;
  itemRefs: RefObject<Map<string, HTMLLIElement>>;
};

/**
 * Issue一覧のスクロール位置をsessionStorageへ保存し、再マウント時に復元する（#773）。
 *
 * スマホではIssue詳細へ遷移した時点で一覧がアンマウントされるため、`<ul>`のscrollTopは
 * 失われる。「実装を開始」等でラベルが変わると開いていたIssue自身がビューの絞り込みから
 * 外れることもあるため、単一のIssueではなく上から数件をアンカーとして記録し、残っている
 * 最初のIssueを基準に復元する。
 */
export function useIssueListScroll({
  scrollKey,
  issueIds,
  selectedIssueId,
  listRef,
  itemRefs,
}: UseIssueListScrollParams) {
  // 復元を終えたscrollKey。復元前のscrollTop（=0）を保存してしまわないためのガードも兼ねる。
  const restoredKeyRef = useRef<string | null>(null);
  const issueIdsRef = useRef(issueIds);

  useEffect(() => {
    issueIdsRef.current = issueIds;
  }, [issueIds]);

  const collectItemOffsets = useCallback((): IssueListItemOffset[] => {
    const offsets: IssueListItemOffset[] = [];
    for (const issueId of issueIdsRef.current) {
      const element = itemRefs.current?.get(issueId);
      if (element) offsets.push({ issueId, offsetTop: element.offsetTop });
    }
    return offsets;
  }, [itemRefs]);

  // 復元。行が描画されるまでは何もせず、次のレンダリングで再試行する。
  useEffect(() => {
    if (!scrollKey || restoredKeyRef.current === scrollKey) return;
    const list = listRef.current;
    if (!list || issueIds.length === 0) return;

    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    const position = readPosition(scrollKey);

    if (position) {
      list.scrollTop = computeRestoredIssueListScrollTop(
        position,
        (issueId) => itemRefs.current?.get(issueId)?.offsetTop,
        maxScrollTop,
      );
    } else {
      // 保存済み位置が無い一覧。詳細画面をURLで直接開いた場合などに備え、選択中のIssueが
      // 一覧にあれば中央に寄せる。無ければ先頭から表示する（絞り込みを切り替えた直後に、
      // 前の一覧のscrollTopがそのまま残らないようにする）。
      const target = selectedIssueId ? itemRefs.current?.get(selectedIssueId) : undefined;
      list.scrollTop = target
        ? computeCenteredIssueListScrollTop(
            target.offsetTop,
            target.clientHeight,
            list.clientHeight,
            maxScrollTop,
          )
        : 0;
    }

    restoredKeyRef.current = scrollKey;
  }, [scrollKey, issueIds, selectedIssueId, listRef, itemRefs]);

  // 保存。スクロールのたびに全行を走査するため、requestAnimationFrameで1フレームに
  // 1回へ間引く。一覧は仮想化していないので走査はO(表示件数)になる。
  useEffect(() => {
    const list = listRef.current;
    if (!list || !scrollKey || issueIds.length === 0) return;

    const key = scrollKey;
    let frameId = 0;

    function handleScroll() {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        // 復元前のscrollTopを保存すると、復元対象の位置を0で上書きしてしまう
        if (restoredKeyRef.current !== key) return;
        const target = listRef.current;
        if (!target) return;
        writePosition(key, {
          anchors: collectIssueListScrollAnchors(collectItemOffsets(), target.scrollTop),
          scrollTop: target.scrollTop,
        });
      });
    }

    list.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", handleScroll);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [scrollKey, issueIds.length, listRef, collectItemOffsets]);
}
