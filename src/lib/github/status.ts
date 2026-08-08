const GITHUB_STATUS_SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";

/** Statuspage APIのpage.status.indicator。"none"以外は何らかの障害・メンテナンスが発生中 */
export type GithubStatusIndicator = "none" | "minor" | "major" | "critical";

export type GithubStatusComponent = {
  id: string;
  name: string;
  /** "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance" */
  status: string;
};

export type GithubStatusSummary = {
  indicator: GithubStatusIndicator;
  description: string;
  components: GithubStatusComponent[];
};

type GithubStatusSummaryResponse = {
  status: { indicator: string; description: string };
  components: Array<{ id: string; name: string; status: string }>;
};

/** GitHub全体の障害状況（www.githubstatus.com、GitHub管理外の公開Statuspage API）を取得する */
export async function fetchGithubStatusSummary(): Promise<GithubStatusSummary> {
  const res = await fetch(GITHUB_STATUS_SUMMARY_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GitHub Status API request failed: ${res.status} ${GITHUB_STATUS_SUMMARY_URL}`);
  }
  const data: GithubStatusSummaryResponse = await res.json();
  return {
    indicator: isGithubStatusIndicator(data.status.indicator) ? data.status.indicator : "none",
    description: data.status.description,
    components: data.components.map((component) => ({
      id: component.id,
      name: component.name,
      status: component.status,
    })),
  };
}

function isGithubStatusIndicator(value: string): value is GithubStatusIndicator {
  return value === "none" || value === "minor" || value === "major" || value === "critical";
}
