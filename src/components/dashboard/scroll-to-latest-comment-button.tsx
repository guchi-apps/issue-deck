"use client";

import type { RefObject } from "react";

import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { computeScrollTopToRevealTarget } from "@/lib/scroll-to-latest";
import { cn } from "@/lib/utils";

type ScrollToLatestCommentButtonProps = {
  containerRef: RefObject<HTMLElement | null>;
  targetRef: RefObject<HTMLElement | null>;
  visible: boolean;
  className?: string;
};

export function ScrollToLatestCommentButton({
  containerRef,
  targetRef,
  visible,
  className,
}: ScrollToLatestCommentButtonProps) {
  if (!visible) return null;

  function handleClick() {
    const container = containerRef.current;
    const target = targetRef.current;
    if (!container || !target) return;
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const top = computeScrollTopToRevealTarget(container.scrollTop, containerTop, targetTop);
    container.scrollTo({ top, behavior: "smooth" });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={handleClick}
      aria-label="最新のコメントに移動"
      className={cn("absolute z-10 rounded-full bg-background shadow-lg", className)}
    >
      <ArrowDown />
    </Button>
  );
}
