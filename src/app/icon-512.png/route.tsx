import { ImageResponse } from "next/og";

import { AppIconGlyph } from "@/lib/app-icon-glyph";

const SIZE = 512;

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#171717",
        }}
      >
        <AppIconGlyph size={SIZE * 0.6} />
      </div>
    ),
    { width: SIZE, height: SIZE }
  );
}
