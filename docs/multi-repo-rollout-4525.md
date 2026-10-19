# 作業Issueフロー（#4520）の全リポジトリ展開 — 対象調査と進捗（#4525）

#4525 の記録。**このドキュメントの調査結果は取得時点（2026-10-18）のスナップショット**で、
配布状況の正はcallerファイル（[supported-repositories.md](supported-repositories.md)の注記と同じ）。
配り方の一般論は [multi-repo-changes.md](multi-repo-changes.md)。

## 現在の到達点（2026-10-19 更新）

| 前提 | 状態 | 影響 |
|---|---|---|
| #4521・#4522・#4523・#4524 | **`main`へ反映済み**（#4723・#4734・#4737・#4749）。タグ`workflows/v54`はこれらすべてを含む（`git merge-base --is-ancestor`で確認） | 新仕様のタグを配れる |
| guchi-apps/docs#226 | PR #236はマージ済み、Issueはclosed。`standards/work-issues.md`・`agent-rules/implementation.md`・`agent-rules/review.md`が追加された | Actions（`.shared-context/`）・ローカル（`~/apps/_docs`）が読む索引に載っている。ローカルの`_docs`チェックアウトは`git pull`していないため古く、反映確認は実セッションで行う（後述） |
| 参照タグの配布 | `claude-review-develop.yml`・`release-develop-to-main.yml`は**導入済み全リポジトリが`workflows/v54`**（再調査の手順で確認。`db-console`・`morrow`の`v52`はコメント内の記述で、実際の`uses:`は`v54`。当初の「混在」の指摘は誤検出） | 参照更新は完了 |

## 対象の全体像（guchi-apps の非アーカイブ 27 リポジトリ）

取得は `gh repo list guchi-apps --no-archived`（privateは権限内で確認。取得不能は無かった）。
直近のpush日では絞っていない（最終pushが2026-06〜07のものも含めて分類した）。

### A. 導入済み（`claude-review-develop.yml`等のcallerを持つ）— 19

`issue-deck`（ローカルパス参照）・`meisai-lab`・`yoteiflow`・`car-care`・`solitaire`・`pi0w`・
`asset-manager`・`status-hub`・`stockly`・`kurashio`・`work-relay`・`db-console`・`morrow`・
`clip-hive`・`signaly`・`aide`（以上public）。`aide-ios`は今回の一覧（非アーカイブのguchi-apps）に現れなかったため、
別org／別名の有無を[supported-repositories.md](supported-repositories.md)で要確認。

| 観点 | 結果 |
|---|---|
| `claude-review-develop.yml`・`release-develop-to-main.yml`のuses | 全て`workflows/v54`（初回調査時の`v52`/`v53`混在はコメント内記述の誤検出。上の到達点を参照） |
| `claude-issue-dispatch.yml`のuses／`prompts-ref` | **全て`v52`**。IssueのActions実装は#4680で廃止済みのため、このcallerはタグ配布の対象にせず、旧タグで動く配布先向けの互換扱い |
| 異常 | `signaly`の`claude-issue-dispatch.yml`にある`workflows/v10`はコメント内の記述で参照ではない。廃止済みの実装callerなので配布対象外 |
| `CLAUDE.md`の固有ルール | `meisai-lab`・`car-care`・`status-hub`・`db-console`は11バイト（実質空）。`yoteiflow`（約353KB）・`morrow`（約273KB）・`kurashio`（約105KB）は大きく、旧「手作業は起案時に固定」の記述が残っていないかの個別確認が要る（後述） |

### B. 無人実行を持たない運用リポジトリ — 6

`docs`・`vps`・`subpc`（private・main運用）、`question`・`ideas`・`claude-config`（private）。
いずれも無人実装を入れない判断（[supported-repositories.md](supported-repositories.md)）。
共通フローの対象は「共有知識（`docs`）とローカルセッションが読むルール」で、`docs`は#226が窓口。

### C. 共通自動化を使わない（`.github/workflows`なし）— 5

| リポジトリ | 理由・扱い |
|---|---|
| `gucchii-os`・`uptime-kuma`・`wifi-speed` | ワークフロー・`CLAUDE.md`とも無し。説明も無く用途不明。**導入するか対象外かの判断が要る**（セットアップIssue or 対象外の記録のどちらかをユーザーが決める） |
| `sensor_260531`（リビング設置中）・`sensor_260218`（設置なし）| ラズパイセンサー。private・`master`/`main`運用。実機運用でコードの共通フロー対象外が自然だが、**未確認のため暫定**扱い |

## 確認結果と残る作業

| 項目 | 結果 |
|---|---|
| 参照タグの配布 | 完了（上記）。実装callerの`v52`は#4680で廃止済みのため意図的に残す |
| 大きい固有`CLAUDE.md`の矛盾 | `yoteiflow`・`morrow`・`kurashio`・`stockly`・`signaly`・`asset-manager`の「手作業」「`71.manual-step`」を検索。ラベル表や個別の手作業の記述のみで、「手作業は起案時に固定する」ように新方式を妨げる記述は見つからなかった（旧`71.manual-step`は互換として読み続ける方針と整合）。個別Issueは起票しない |
| 新規アプリ雛形 | `src/lib/new-app/scaffold.ts`は`workflowTag`を呼び出し側から受け取る作りで、固定タグを持たない。最新タグが渡れば新方式で届く |
| 追加Issue | 固有コード・caller・実行ホスト設定の変更が必要と確認できた対象は無く、起票していない |
| 共通自動化なし5件 | **全て対象外**（ユーザー判断 2026-10-19）。`uptime-kuma`は他リポジトリをクローンして使う死活監視ツールで更新対象が無い。`gucchii-os`はユーザーの学習用。`wifi-speed`は現在使っていない。`sensor_260531`・`sensor_260218`は実機運用。セットアップIssueは起票しない |

### 未了（成功扱いにしない）

1. **代表実走（Web・iOS含む・実機デプロイ・private運用）**: 未実施。ユーザーは「既に色々実施済みで問題が出ていないため、改めての実走は不要」との見解（2026-10-19）。ただし完了条件に含まれるため、実走を省く扱いにするかは親Epicで確定する。実環境でIssue起案→AI実行→リリース前後の依存待ち→本番確認を通す作業で、本番反映と人の確認を伴うため、このPRでは行っていない。実施したら設定整合確認と区別して記録する
2. **docs#226の共通ルールの実参照**: 静的な参照経路は確認済み（2026-10-19）。`guchi-apps/docs`の`main`の`CLAUDE.md`が`agent-rules/implementation.md`・`review.md`・`standards/work-issues.md`を索引し、`implementation.md`も`work-issues.md`へリンクする。Actionsは`reusable-claude-review-develop.yml`が`.shared-context/`へcheckoutする。**未確認**: 実セッションが実際にこれらを読んで従った証跡（ローカル`~/apps/_docs`は未pullのため古い。`git pull`は指示があるまで行わない）
3. **新旧混在の互換**: 旧`71.manual-step`本文・進行中セッションの継続と、未対応ホストへ新ジョブを送らないことは、実機のホスト構成を見ないと確かめられない。未確認
4. ~~共通自動化なし5件の扱い~~: 全て対象外で確定（上の表）
5. **親Epic #4520への反映**: 上記1〜4を残作業として記載する

## 再調査の手順

```bash
for r in $(gh repo list guchi-apps --limit 200 --no-archived --json name -q '.[].name'); do
  b=$(gh api repos/guchi-apps/$r --jq .default_branch)
  gh api "repos/guchi-apps/$r/contents/.github/workflows/claude-review-develop.yml?ref=$b" --jq .content 2>/dev/null \
    | base64 -d | grep -oE 'workflows/v[0-9]+' | sort -u | sed "s/^/$r /"
done
```
