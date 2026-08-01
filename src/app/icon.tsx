import { ImageResponse } from "next/og";

import { AppIconGlyph } from "@/lib/app-icon-glyph";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
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
        <AppIconGlyph size={size.width * 0.6} />
      </div>
    ),
    size
  );
}
