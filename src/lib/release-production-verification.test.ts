import { describe, expect, it } from "vitest";

import {
  canAttestProduction,
  classifyProductionTarget,
  decideProductionEvidence,
  evaluateVersionProbe,
  parseAttestationNote,
  parseVersionEndpointUrl,
  type ProductionEvidenceInput,
} from "@/lib/release-production-verification";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";

describe("classifyProductionTarget", () => {
  it("deploy.ymlに稼働SHAの照合があれば従来の方式、無ければHTTP応答のみの方式", () => {
    expect(classifyProductionTarget({ deployWorkflowText: "APP_COMMIT_SHA ... /api/app-version", releaseArtifactsWorkflowText: null })).toBe("deploy_version_check");
    expect(classifyProductionTarget({ deployWorkflowText: "curl -fsS http://127.0.0.1/login", releaseArtifactsWorkflowText: null })).toBe("deploy_without_version_check");
  });

  it("deploy.ymlが無くソース配布のworkflowがあるrepo（pi0w）はソース公開、どちらも無ければ判定不能", () => {
    expect(classifyProductionTarget({ deployWorkflowText: null, releaseArtifactsWorkflowText: "on: push" })).toBe("source_publish_only");
    expect(classifyProductionTarget({ deployWorkflowText: null, releaseArtifactsWorkflowText: null })).toBe("unknown");
  });
});

describe("evaluateVersionProbe", () => {
  const probe = (body: string | null, httpStatus: number | null = 200, version: string | null = "1.4.0") => evaluateVersionProbe({ httpStatus, body, mergeSha: SHA, version });

  it("SHAが一致したときだけ一致にする（短縮SHAは7文字以上の前方一致）", () => {
    expect(probe(JSON.stringify({ sha: SHA }))).toEqual({ status: "match", by: "sha", reported: SHA });
    expect(probe(JSON.stringify({ commit: SHA.slice(0, 7) }))).toMatchObject({ status: "match", by: "sha" });
    expect(probe(JSON.stringify({ sha: SHA.slice(0, 6) }))).toMatchObject({ status: "mismatch" });
  });

  it("旧版のSHAが返ったら、版番号が一致していても不一致にする", () => {
    expect(probe(JSON.stringify({ sha: OLD, version: "1.4.0" }))).toEqual({ status: "mismatch", reportedSha: OLD, reportedVersion: "1.4.0" });
  });

  it("SHAが無いときだけ予約した版と比べる", () => {
    expect(probe(JSON.stringify({ version: "v1.4.0" }))).toMatchObject({ status: "match", by: "version" });
    expect(probe(JSON.stringify({ version: "1.3.9" }))).toEqual({ status: "mismatch", reportedSha: null, reportedVersion: "1.3.9" });
    expect(probe(JSON.stringify({ version: "1.4.0" }), 200, null)).toMatchObject({ status: "unreadable" });
  });

  it("取得できない・200以外・JSONでない・版情報が無い応答は照合できないとして扱う", () => {
    expect(probe(null, null)).toMatchObject({ status: "unreadable" });
    expect(probe("<html>ok</html>", 200)).toMatchObject({ status: "unreadable", detail: "JSONではありません" });
    expect(probe(JSON.stringify({ sha: SHA }), 503)).toMatchObject({ status: "unreadable", detail: "HTTP 503" });
    expect(probe(JSON.stringify({ ok: true }))).toMatchObject({ status: "unreadable" });
  });
});

describe("decideProductionEvidence", () => {
  const base: ProductionEvidenceInput = {
    kind: "deploy_without_version_check",
    deploySucceeded: true,
    versionCheckPassed: false,
    probe: null,
    attested: false,
    sourcePublish: null,
  };

  it("deployが成功していなければ、外部照合・人の確認があっても完了にしない", () => {
    expect(decideProductionEvidence({ ...base, deploySucceeded: false, attested: true, probe: { status: "match", by: "sha", reported: SHA } })).toEqual({
      verified: false,
      reason: "deploy_not_succeeded",
    });
  });

  it("deploy.ymlの照合が通ればその方式で完了にする", () => {
    expect(decideProductionEvidence({ ...base, kind: "deploy_version_check", versionCheckPassed: true })).toEqual({ verified: true, method: "deploy_version_check" });
  });

  it("deployの成功（HTTP 200）だけでは完了にしない", () => {
    expect(decideProductionEvidence(base)).toEqual({ verified: false, reason: "no_evidence" });
  });

  it("公開URLのSHAが一致すれば完了、取得できなければ待つ", () => {
    expect(decideProductionEvidence({ ...base, probe: { status: "match", by: "sha", reported: SHA } })).toEqual({ verified: true, method: "public_version_url" });
    expect(decideProductionEvidence({ ...base, probe: { status: "unreadable", detail: "HTTP 500" } })).toEqual({ verified: false, reason: "probe_unreadable" });
  });

  it("旧版が応答している間は、人の確認があっても完了にしない", () => {
    expect(decideProductionEvidence({ ...base, attested: true, probe: { status: "mismatch", reportedSha: OLD, reportedVersion: null } })).toEqual({
      verified: false,
      reason: "version_mismatch",
    });
  });

  it("外部照合が無い・取得できないrepoは、人の確認で完了にできる", () => {
    expect(decideProductionEvidence({ ...base, attested: true })).toEqual({ verified: true, method: "manual_attestation" });
    expect(decideProductionEvidence({ ...base, attested: true, probe: { status: "unreadable", detail: "x" } })).toEqual({ verified: true, method: "manual_attestation" });
  });

  it("ソース配布のrepoは、workflowの成功とReleaseの公開が揃ったときだけソース公開として完了にする", () => {
    const source = { ...base, kind: "source_publish_only" as const, deploySucceeded: false };
    expect(decideProductionEvidence({ ...source, sourcePublish: { runSucceeded: true, releasePublished: true } })).toEqual({ verified: true, method: "source_publish" });
    expect(decideProductionEvidence({ ...source, sourcePublish: { runSucceeded: true, releasePublished: false } })).toEqual({ verified: false, reason: "source_not_published" });
    // 人の確認ではソース公開を代わりにしない（実機配備の確認とも混ぜない）
    expect(decideProductionEvidence({ ...source, attested: true, sourcePublish: { runSucceeded: false, releasePublished: false } })).toEqual({
      verified: false,
      reason: "source_not_published",
    });
  });

  it("判定不能なrepoは人の確認だけで完了にできる", () => {
    expect(decideProductionEvidence({ ...base, kind: "unknown", deploySucceeded: false })).toEqual({ verified: false, reason: "unknown_target" });
    expect(decideProductionEvidence({ ...base, kind: "unknown", deploySucceeded: false, attested: true })).toEqual({ verified: true, method: "manual_attestation" });
  });
});

describe("canAttestProduction", () => {
  it("本番反映中・稼働確認中で、deployが成功したrepoだけ受け付ける", () => {
    expect(canAttestProduction({ kind: "deploy_without_version_check", deploySucceeded: true, phase: "verifying_production" })).toBe(true);
    expect(canAttestProduction({ kind: "deploy_without_version_check", deploySucceeded: false, phase: "verifying_production" })).toBe(false);
    expect(canAttestProduction({ kind: "deploy_without_version_check", deploySucceeded: true, phase: "completed" })).toBe(false);
    expect(canAttestProduction({ kind: "source_publish_only", deploySucceeded: false, phase: "verifying_production" })).toBe(false);
    expect(canAttestProduction({ kind: "unknown", deploySucceeded: false, phase: "deploying" })).toBe(true);
  });
});

describe("入力の検証", () => {
  it("確認内容は何で確かめたかが読める長さを求める", () => {
    expect(parseAttestationNote("確認した")).toBeNull();
    expect(parseAttestationNote("  画面のフッターに v1.4.0 と表示された  ")).toBe("画面のフッターに v1.4.0 と表示された");
    expect(parseAttestationNote(1)).toBeNull();
  });

  it("公開URLはhttpsの公開ホスト名だけを受け付ける", () => {
    expect(parseVersionEndpointUrl("https://car.example.com/api/app-version")).toBe("https://car.example.com/api/app-version");
    for (const bad of ["http://car.example.com/v", "https://127.0.0.1/v", "https://localhost/v", "https://subpc.tail5210f2.ts.net/v", "https://a.example.com:8443/v", "https://u:p@a.example.com/v", "https://[::1]/v", "ftp://a.example.com"]) {
      expect(parseVersionEndpointUrl(bad)).toBeNull();
    }
  });
});
