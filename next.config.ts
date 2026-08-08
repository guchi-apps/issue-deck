import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // WSLのIPはWSL再起動のたびに変わるため、個別IPではなくsslip.ioサブドメイン全体を許可する
  // （Next.jsのallowedDevOriginsは "*.example.com" 形式のワイルドカードに対応している）。
  allowedDevOrigins: ["*.sslip.io", "127.0.0.1", "localhost"],
  // Fly.io Machines上のプレビュー環境をDocker化する際に必要な単体実行可能な出力形式。
  output: "standalone",
};

export default nextConfig;
