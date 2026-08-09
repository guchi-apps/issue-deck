"use client";

import { type RefObject, useEffect, useState } from "react";

import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { computeScrollToLatestTarget, isAtScrollTarget } from "@/lib/scroll-to-latest";
import { cn } from "@/lib/utils";

type ScrollToLatestCommentButtonProps = {
  containerRef: RefObject<HTMLElement | null>;
  targetRef: RefObject<HTMLElement | null>;
  visible: boolean;
  hasUnread: boolean;
  className?: string;
};

export function ScrollToLatestCommentButton({
  containerRef,
  targetRef,
  visible,
  hasUnread,
  className,
}: ScrollToLatestCommentButtonProps) {
  const [reachedTarget, setReachedTarget] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const target = targetRef.current;
    if (!container || !target) return;

    function updateReachedTarget() {
      if (!container || !target) return;
      setReachedTarget(
        isAtScrollTarget({
          containerScrollTop: container.scrollTop,
          containerTop: container.getBoundingClientRect().top,
          targetTop: target.getBoundingClientRect().top,
        }),
      );
    }

    updateReachedTarget();
    container.addEventListener("scroll", updateReachedTarget);
    return () => container.removeEventListener("scroll", updateReachedTarget);
  }, [containerRef, targetRef]);

  if (!visible) return null;

  function handleClick() {
    const container = containerRef.current;
    const target = targetRef.current;
    if (!container || !target) return;
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const top = computeScrollToLatestTarget({
      containerScrollTop: container.scrollTop,
      containerTop,
      targetTop,
      containerScrollHeight: container.scrollHeight,
    });
    container.scrollTo({ top, behavior: "smooth" });
  }

  const label = hasUnread && !reachedTarget ? "未読コメントへ移動" : "コメント欄へ移動";

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={handleClick}
      className={cn("absolute z-10 rounded-full shadow-lg", className)}
    >
      <ArrowDown />
      {label}
    </Button>
  );
}
