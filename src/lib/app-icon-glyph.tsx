// アプリのアイコンの図形。PNGを書き出すImageResponse（satori）でもDOMでも同じものを使う。
// satoriはclassNameを解釈しないため、色はTailwindではなくfillで受け取る。
export function AppIconGlyph({ size, fill = "#fafafa" }: { size: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <rect width="7" height="9" x="3" y="3" rx="1.5" />
      <rect width="7" height="5" x="14" y="3" rx="1.5" />
      <rect width="7" height="9" x="14" y="12" rx="1.5" />
      <rect width="7" height="5" x="3" y="16" rx="1.5" />
    </svg>
  );
}
