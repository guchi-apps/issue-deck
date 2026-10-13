import type { RepoCandidate } from "@/lib/slack/candidates";
import type { SlackBlock } from "@/lib/slack/client";

export const ACTION_REPO_SELECT = "slack_repo_select";
export const ACTION_REPO_SEARCH = "slack_repo_search";
export const ACTION_REPO_CONFIRM = "slack_repo_confirm";
export const ACTION_ISSUE_CONFIRM = "slack_issue_confirm";
export const ACTION_ISSUE_CANCEL = "slack_issue_cancel";
export const ACTION_ISSUE_ATTACH = "slack_issue_attach";

/** static_selectで出せる選択肢の上限。超えるときは名称検索（external_select）にする */
export const STATIC_SELECT_LIMIT = 100;

function option(candidate: RepoCandidate) {
  // 表示名と`owner/repo`を併記する（text上限75字）
  const label = candidate.name === candidate.fullName ? candidate.fullName : `${candidate.name} ・ ${candidate.fullName}`;
  return { text: { type: "plain_text", text: label.slice(0, 75) }, value: candidate.fullName };
}

export function repoSelectorBlocks(params: {
  requestId: string;
  candidates: RepoCandidate[];
  selected: string | null;
  guessed: boolean;
}): SlackBlock[] {
  const { requestId, candidates, selected } = params;
  const initial = selected ? candidates.find((c) => c.fullName === selected) : undefined;
  const useStatic = candidates.length <= STATIC_SELECT_LIMIT;
  const select = useStatic
    ? {
        type: "static_select",
        action_id: ACTION_REPO_SELECT,
        placeholder: { type: "plain_text", text: "対象のリポジトリを選ぶ" },
        options: candidates.map(option),
        ...(initial ? { initial_option: option(initial) } : {}),
      }
    : {
        type: "external_select",
        action_id: ACTION_REPO_SELECT,
        placeholder: { type: "plain_text", text: "名前で検索して選ぶ" },
        min_query_length: 0,
        ...(initial ? { initial_option: option(initial) } : {}),
      };
  return [
    ...(params.guessed && selected
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: "本文から推定した候補を選択済みです。違う場合は選び直してください。" }] }]
      : []),
    { type: "actions", block_id: `repo:${requestId}`, elements: [select] },
    {
      type: "actions",
      block_id: `repo_confirm:${requestId}`,
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: ACTION_REPO_CONFIRM,
          text: { type: "plain_text", text: "この対象で起案する" },
          value: requestId,
        },
      ],
    },
  ];
}

/**
 * 対象を絞れないときの選択UI（#4565）。関連候補を少数のメニューで出し、メニューを選ぶだけで調査へ進む
 * （確定ボタンは挟まない）。候補外の許可済みリポジトリは、名称検索のメニューから選べる。
 */
export function targetChoiceBlocks(params: { requestId: string; options: RepoCandidate[] }): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (params.options.length > 0) {
    blocks.push({
      type: "actions",
      block_id: `repo:${params.requestId}`,
      elements: [
        {
          type: "static_select",
          action_id: ACTION_REPO_SELECT,
          placeholder: { type: "plain_text", text: "関連しそうな候補から選ぶ" },
          options: params.options.map(option),
        },
      ],
    });
  }
  blocks.push({
    type: "actions",
    block_id: `repo_search:${params.requestId}`,
    elements: [
      {
        type: "external_select",
        action_id: ACTION_REPO_SEARCH,
        placeholder: { type: "plain_text", text: "他のリポジトリを名前で探す" },
        min_query_length: 0,
      },
    ],
  });
  return blocks;
}

export function proposalBlocks(params: {
  requestId: string;
  duplicates: { number: number; title: string; htmlUrl: string; state: string }[];
}): SlackBlock[] {
  const attach = params.duplicates.slice(0, 3).map((d) => ({
    type: "button",
    action_id: `${ACTION_ISSUE_ATTACH}_${d.number}`,
    text: { type: "plain_text", text: `#${d.number} へ追記する`.slice(0, 75) },
    value: `${params.requestId}:${d.number}`,
  }));
  return [
    {
      type: "actions",
      block_id: `proposal:${params.requestId}`,
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: ACTION_ISSUE_CONFIRM,
          text: { type: "plain_text", text: "この案で起案する" },
          value: params.requestId,
        },
        ...attach,
        { type: "button", action_id: ACTION_ISSUE_CANCEL, text: { type: "plain_text", text: "やめる" }, value: params.requestId },
      ],
    },
  ];
}
