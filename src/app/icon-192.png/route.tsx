import { ImageResponse } from "next/og";

const SIZE = 192;

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
          color: "#fafafa",
          fontSize: SIZE * 0.48,
          fontWeight: 700,
        }}
      >
        ID
      </div>
    ),
    { width: SIZE, height: SIZE }
  );
}
