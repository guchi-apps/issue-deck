import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyDeployVersionCheck, stripYamlComments } from "@/lib/deploy-version-check";

const GATE = `
      # APP_COMMIT_SHA は guchi-apps/vps#298 のgateが /api/app-version と照合する
      - name: Send environment variables
        env:
          APP_COMMIT_SHA: \${{ github.sha }}
        run: |
          {
            printf '%s\\n' "APP_COMMIT_SHA=\${APP_COMMIT_SHA}"
          } | ssh -p "\${SSH_PORT}" "\${USERNAME}@\${HOST}" env
      - name: Deploy and restart
        run: ssh -p "\${SSH_PORT}" "\${USERNAME}@\${HOST}" deploy
`;

// gateへ移す前（#4804より前）のissue-deck自身のヘルスチェックの形
const SELF = `
          script: |
            for i in $(seq 1 30); do
              body="$(curl -fsS "http://127.0.0.1:\${PORT}/api/app-version" 2>/dev/null || true)"
              if [ -n "$body" ] && printf '%s' "$body" | grep -qF "\\"sha\\":\\"\${APP_COMMIT_SHA}\\""; then
                exit 0
              fi
              sleep 2
            done
            exit 1
`;

describe("classifyDeployVersionCheck（#4757）", () => {
  it("issue-deck自身のdeploy.ymlはgateへ委譲する（gate。#4804）", () => {
    expect(classifyDeployVersionCheck(readFileSync(".github/workflows/deploy.yml", "utf-8"))).toBe("gate");
  });

  it("deploy.yml自身が/api/app-versionを引いてshaを比べ、不一致で失敗させる形はself", () => {
    expect(classifyDeployVersionCheck(SELF)).toBe("self");
  });

  it("gateへAPP_COMMIT_SHAをenvで渡してdeployを呼ぶ形はgate", () => {
    expect(classifyDeployVersionCheck(GATE)).toBe("gate");
  });

  it("コメントを書き換えても判定は変わらない", () => {
    expect(classifyDeployVersionCheck(GATE.replace(/^\s*#.*$/m, "      # 別の説明"))).toBe("gate");
    expect(classifyDeployVersionCheck(GATE.replace(/^\s*#.*$/m, ""))).toBe("gate");
  });

  it("コメントやechoに2語を書いただけの照合なしは none", () => {
    const text = `
      # APP_COMMIT_SHA と /api/app-version を照合する（つもり）
      - run: echo "check /api/app-version against APP_COMMIT_SHA"
      - run: curl -fsS http://127.0.0.1:3000/login
`;
    expect(classifyDeployVersionCheck(text)).toBe("none");
  });

  it("コメント行だけでgateの形を装っても none", () => {
    const text = GATE.split("\n").map((l) => (l.trim() ? `# ${l}` : l)).join("\n");
    expect(classifyDeployVersionCheck(text)).toBe("none");
  });

  it("deployを呼ばない（envを渡すだけ）は none", () => {
    expect(classifyDeployVersionCheck(GATE.replace(/ deploy\n/, " restart\n"))).toBe("none");
  });

  it("stripYamlCommentsは行末コメントも落とす", () => {
    expect(stripYamlComments("a: 1 # c\n# d\nb: 2")).toBe("a: 1\n\nb: 2");
  });
});
