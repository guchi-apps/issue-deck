"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { layoutPie, pieGeometryForWidth } from "@/lib/pie-chart-layout";
import {
  formatUsageUsd,
  type RepositoryPieSlice,
} from "@/lib/session-usage-view";

/**
 * AI使用量の「リポジトリ別」円グラフ（#3060）。金額の上位5件と「その他」を、12時の位置から
 * 時計回りに金額順で並べる。円の内側に「%」と括弧書きの金額、外側に名前を引き出し線でつなぐ。
 *
 * **扇形が狭くて金額が入り切らないときは、割合と金額を円の外の名前の下へ移す**（配置は
 * `layoutPie`が決める）。色は順位ごとの固定5色と、「その他」のグレー（`globals.css`の`--pie-*`）。
 * 他の画面のリポジトリ色（`getRepoColor`のハッシュ色）とは揃えない——隣り合う扇形が同じ色に
 * なると境目が読めなくなるため。
 */

/** 描画前の幅（SSR・計測前）。スマホのカードの中身の幅にそろえてある */
const INITIAL_WIDTH = 337;

const SLICE_COLORS = [
  "var(--pie-1)",
  "var(--pie-2)",
  "var(--pie-3)",
  "var(--pie-4)",
  "var(--pie-5)",
];

function sliceColor(slice: RepositoryPieSlice, rank: number): string {
  return slice.isOther ? "var(--pie-other)" : (SLICE_COLORS[rank] ?? "var(--pie-other)");
}

function percentText(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function RepositoryPieChart({ slices }: { slices: RepositoryPieSlice[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => pieGeometryForWidth(width), [width]);
  const layouts = useMemo(
    () =>
      layoutPie(
        slices.map((slice) => ({
          name: slice.label,
          note: slice.isOther ? `${slice.repositoryCount}リポジトリ` : undefined,
          fraction: slice.fraction,
          percentText: percentText(slice.fraction),
          amountText: formatUsageUsd(slice.costUsd),
        })),
        geometry,
      ),
    [slices, geometry],
  );

  const summary = slices
    .map((slice) => `${slice.label} ${percentText(slice.fraction)}（${formatUsageUsd(slice.costUsd)}）`)
    .join("、");
  const { fontSize } = geometry;

  return (
    <div ref={containerRef} className="w-full">
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label={`リポジトリ別の金額の内訳。${summary}`}
        className="block h-auto w-full overflow-visible"
      >
        {slices.map((slice, index) => {
          const layout = layouts[index];
          const amountText = formatUsageUsd(slice.costUsd);
          const detail = `${slice.label}${slice.isOther ? `（${slice.repositoryCount}リポジトリ）` : ""}: ${percentText(slice.fraction)}（${amountText}）`;
          return (
            <g key={slice.isOther ? "__other" : slice.key}>
              <path
                d={layout.path}
                style={{ fill: sliceColor(slice, index) }}
                className="stroke-card"
                strokeWidth={2}
                strokeLinejoin="round"
              >
                <title>{detail}</title>
              </path>
              {layout.inside && (
                <g
                  textAnchor="middle"
                  style={{ fill: "var(--pie-ink)" }}
                  pointerEvents="none"
                >
                  <text x={layout.inside.x} y={layout.inside.y - 2} fontSize={fontSize} fontWeight={700}>
                    {percentText(slice.fraction)}
                  </text>
                  <text x={layout.inside.x} y={layout.inside.y + fontSize} fontSize={fontSize - 1}>
                    {`(${amountText})`}
                  </text>
                </g>
              )}
              <polyline
                points={layout.label.leader}
                fill="none"
                strokeWidth={1}
                strokeLinejoin="round"
                className="stroke-muted-foreground"
              />
              <text textAnchor={layout.label.anchor}>
                <title>{detail}</title>
                {layout.label.lines.map((line, lineIndex) => (
                  <tspan
                    key={lineIndex}
                    x={layout.label.x}
                    y={layout.label.lineYs[lineIndex]}
                    fontSize={line.strong ? fontSize : fontSize - 1}
                    fontWeight={line.strong ? 600 : 400}
                    className={line.strong ? "fill-foreground" : "fill-muted-foreground"}
                  >
                    {line.text}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
