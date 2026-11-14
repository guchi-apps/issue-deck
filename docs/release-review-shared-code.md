# 全体レビューの共有コード資料（#4690）

各アプリの候補が呼ぶ `guchi-apps/issue-deck` の再利用ワークフローは、候補のcheckoutには含まれない。レビューAIにネットワーク取得を任せると読み取り専用環境で取得できず、統合検証が成功していても未確認が残る。

ランナーは候補の `.github/workflows/` から固定タグまたは完全SHAを抽出し、共有リポジトリの該当コミットを別のbare repoで取得する。まずpollerのローカルリポジトリを使い、未取得の参照だけ公式リモートから取る。資料は候補内の一時ディレクトリへ展開し、参照・解決SHA・相対パス・省略したリンクをプロンプトへ渡す。共有コードは実行せず、シンボリックリンクも辿らない。AIの権限は変更しない。

取得は合格の根拠ではない。AIが入力契約や関連コードを実際に読み、確認内容を記録する。取得失敗は資料へ残し、未確認を維持する。共有資料の指紋はバッチ再利用判定に含める。統合検証の証跡が取得不能のときは、従来どおり依存する保存済み結果を再利用しない。

画面では統合検証成功後に残る未確認を「レビューの未確認事項（統合検証は成功）」と表示する。合格条件は変更しない。

この変更はランナーに含まれるため、develop反映後にサブPCの「更新して再起動」を完了し、対象候補の全体レビューを再実行する。サーバー側の表示変更は本番デプロイ後に反映される。
# 参照の抽出

共有workflowの資料はuses行の値から収集する。コメントや説明文に書かれたタグの例は参照として扱わない（#4698）。引用符と行末コメントのあるusesも対象にし、可変ブランチは取得対象外として理由を残す。

# 連携先の実装・運用証跡の自動取得（#4975）

アプリ間連携（例: AIDE→kurashio）の根拠が別repoにあるとき、利用者に資料を送らせない。`scripts/release-review-integrations.py`がランナーから呼ばれ、候補のコミットメッセージと追加行にある `guchi-apps/<repo>#<番号>`（と同repoのissues/pullのURL）だけを連携先として解決する。`#814`のようなrepo無しの番号は拾わない（repoをまたいだ番号の取り違え防止）。許可ownerは既定`guchi-apps`のみで、任意URLは巡回しない。

- Issue/PRの状態、PRのマージコミット（完全SHA）、develop/mainへの取り込み、mainで成功したデプロイ系ワークフローの有無を**別の事実として**記録する。変更ファイルのコードは、実装PRのマージSHA（`codeAtMerge`）と、最新のデプロイworkflow成功runのheadSHA（`codeAtDeployCandidate`。`deploy*`のworkflowだけを対象にし、release-sync・公開準備は除く。**稼働中versionとの照合は別の証拠で、これは稼働SHAの確認ではない**）の2か所で別々に取得する。後続PRがAPIを変えていても、実装PRのコードだけで稼働中の契約を判断しない。取得時刻（`fetchedAt`）・出典・repo/SHAはマニフェストに残る。
- 秘密値らしい行・秘密らしいファイル（`.env*`・鍵）は取得せず、本文もマスクする。共有トークンの値は取得しない。登録有無・利用先は今回の取得では照会しておらず、**「未確認」であって「未登録」ではない**（資格情報の新規発行を前提にしない）。
- 取得失敗は「権限不足」「通信失敗」「資料未取得（許可外・PR無し）」に分類して残す。スクリプトが予期せず異常終了しても空資料にせず、「取得不能」の資料と指紋をレビュー入力へ残す。「実設定不足」「実コードの欠陥」はAIが資料を読んで分類する。
- 指紋（SHA・状態・デプロイ・失敗分類・判定器の版`JUDGE_VERSION`。取得日時は除く）を既存の証跡指紋へ連結する。連携先の証跡があるときは、旧文言を含む全ての未確認が指紋の変化で再評価され、確認済みだけが再利用される（`INTEGRATION_EVIDENCE_ACTIVE`）。指紋が同じなら再利用する。

# 明示参照の無い既存APIの受信口（#5192）

別repoの既存APIを呼ぶ候補には、受信口の実装を指す`owner/repo#番号`が無いことがある（work-relay PR #388のAIDE `POST /api/news-mail/send`。実装はaide#257だが候補は#744しか参照しない）。参照からは受信口のコードに届かないため、`scripts/release-review-integrations.py`の`discover_contracts`が次の**コードと対応表だけ**から特定する。

- **発見の根拠**: 候補が変更したソース（テスト・ドキュメントは除く）の1ファイルが、(1) `.github/secrets-manifest.tsv`で`op://apps/<app>/base-url`（`*-base-url`・`api-url`も可）を指す環境変数を読み、(2) `${式}/api/x`・`式 + "/api/x"`・`new URL("/api/x", 式)`の形で固定パスを足していること。PR本文・コメント・`.md`の記述は発見の材料にしない。提供側は候補と同じowner（許可リスト内）に限り、コード中のURL文字列は辿らない。動的なパス（`/api/x/${id}`）は対象外。`SOURCE`列が提供側の`op://`を指さないリポジトリでは発見されない（取り違えるより取りこぼす側に倒している）。
- **取り違えの防止**: 受信口はファイルベースのルート（`src/app/api/x/route.ts`。ルートグループは無視）か、入口ファイル（`src/server.ts`など）にある**完全一致のパス文字列**だけを根拠にする。入口ファイルからは受信口の直後の数行に現れるimportだけを処理本体とし、別パスの分岐の処理は載せない。1ファイルが複数の提供側を読むときは呼び先を決めつけず取得もしない。
- **取得**: 処理本体から相対importを深さ2・1受信口14ファイルまで（型だけのimportは除く）。受信口は最大6件。省略は`omittedFiles`・`omittedContracts`へ残す。秘密値の行・ファイルの除外は#4975と同じ。
- **2つの時点**: `codeAtDeployCandidate`は最新のデプロイworkflow成功runのSHA（無ければmainの先端で、`deployCandidate.kind`にデプロイ済みと言えないことを書く）。`codeAtImplementation`は処理本体のファイルを最初に追加したコミットを含むPRのマージSHA。どちらも稼働SHAの確認ではない。
- **失敗の扱い**: 権限不足・通信失敗・受信口が見つからない（`資料未取得`）を`classification`に残し、コードは載せない。AIには適合とも欠陥ともしないよう指示する。実送信と稼働SHAは別の証拠が無ければ未確認のまま。
- **再評価**: `apiContracts`は証跡の指紋に入り、`JUDGE_VERSION`も上げてある。poller更新後に全体レビューを再実行すると、保存済みの未確認は指紋の不一致で捨てられて再評価され、確認済みだけが再利用される。指摘0件でも未確認があれば合格にならない条件は変えていない。

実走（2026-11-01、work-relay PR #388 base `6d42f6a7` / head `ed2e1858`）: `guchi-apps/aide#744`の資料に加えて`/api/news-mail/send`を発見元`src/app/api/news-mail/send/route.ts:69`・`AIDE_NEWS_MAIL_URL`で特定し、デプロイ候補`aa55e4bd`と実装時点`76bd2a35`（PR #258）の両方で`src/server.ts`（301行目）・`src/api/news-mail.ts`・`src/api/secret.ts`・`src/core/connectors/news-mail/send.ts`・`idempotency.ts`などを取得した。全体レビューAIによるRC #388自体の再評価は、poller更新後の再実行で行う。

# 設定で指定する連携先リポジトリの固定版（#5223）

アプリ間連携で、候補に連携先への参照もマニフェストの対応付けも無いと、連携先のコードがレビューに渡らず「確認項目が未確認」になる（asset-manager #838がAIDEのmoney APIの`calcFlag`を解釈する変更で、AIDE側の実装が資料に無かった）。

`scripts/release-review-links.json`に「対象リポジトリ → 連携先（`provider`）・取得するパス（`patterns`）・型定義（`types`）・取得の条件（`triggers`。候補の変更ファイルに一致したときだけ）」を書くと、`release-review-integrations.py`が連携先の**本番mainの先端SHA**で次を取得する。

- `linkedRepos[].code`: `patterns`に一致するコード（上限20件。省略は`omittedFiles`）。`types`は`typeDefinitions`と`apiContracts`（`path: "(型定義)"`）にも載せる
- `linkedRepos[].developOnly`: 連携先の`main...develop`の差分のうち対象パスにあるもの。空でなければ「対応がdevelop止まりでmainに無い」疑いとして指摘する（`checked: false`は比較できず未確認）
- 取得できないとき（mainに対象コードが無い・通信失敗・権限不足）は`classification`と`missing`に理由と足すものを残す。プロンプトは**「資料不足」と「不整合の疑い」を別に報告**し、資料不足には足す設定を添えるよう指示する

取得は適合の証拠ではなく、稼働SHAの確認でもない。設定は連携先が増えるたびに足す（新しい連携先を足す変更と同じPRで行う）。`JUDGE_VERSION`を4へ上げたため、保存済みの未確認は指紋の不一致で再評価される。実行ホストの更新（「更新して再起動」）後に効く。

## 適用範囲（2026-10-24時点）

共通ランナー（`run-release-review.sh`）とcallerの参照タグは同一で、共通修正だけで全管理対象に適用される。callerは`reusable-release-develop-to-main.yml@workflows/v54`を参照する15リポジトリ（aide・asset-manager・car-care・clip-hive・db-console・kurashio・meisai-lab・morrow・pi0w・signaly・solitaire・status-hub・stockly・work-relay・yoteiflow）で、独立のrelease-review実装は見つかっていない。このため子Issueは起案していない（個別修正が必要と分かったrepoだけ起案する）。タグの参照が同じでも、実行ホスト（サブPC）のrunnerは「更新して再起動」で更新するまで旧版のまま。

## 共有トークンの非機密情報（#4975）

`GET /api/dispatch/release-review-context`（pollerの共有シークレットで認可。既存のレビューcontextの経路）が、`sharedTokens`として名前・更新日時・最終利用日時・利用元だけを返す（`src/lib/release-review-shared-token-meta.ts`）。値・暗号文・説明・`op://`参照は含めず、復号もしない。ランナーは、その一覧のうち候補の差分・連携先のコードに名前が出るものだけをAI入力へ渡し、同じ集合の要約を証跡指紋へ加える（登録・利用状況が変わると影響する未確認が再評価される）。取得できなかったときは「未確認」と書き、「未登録」とは書かない。リポジトリのSecrets/環境変数で管理される値はこの一覧では分からない。

## 適用区分（2026-10-24、GitHub上の非アーカイブ27リポジトリを実取得（画面の管理対象22件とは別の母集団。対象外repoにIssueは作らない））

| 区分 | 対象 | 扱い |
| --- | --- | --- |
| 共通修正で適用 | aide・asset-manager・car-care・clip-hive・db-console・kurashio・meisai-lab・morrow・pi0w・signaly・solitaire・status-hub・stockly・work-relay・yoteiflow（`reusable-release-develop-to-main.yml@workflows/v54`） | ランナーはIssueDeck側の1つ。実行ホストの更新のみ必要 |
| 自身 | issue-deck（ローカルreusable参照） | develop反映で効く |
| 対象外（リリースPR無し） | docs・subpc・vps・question・ideas・claude-config・gucchii-os・uptime-kuma・sensor_260531・sensor_260218・wifi-speed | release-develop-to-main caller無し |
| 固有対応 | 無し（個別修正が要るrepoは確認できていない） | 子Issueは起案しない |

実走確認: RC-5以外の例として、別repoの`guchi-apps/issue-deck#4969`（PR #4971）を参照する擬似候補で取得を実走し、状態・マージSHA・develop取り込み・デプロイ未検出・変更ファイル4件が取得できた。

未対応: 実行ホストへの配布と、AIDE→kurashioの実走（ホスト更新はaide#683側でユーザーが選択済みのため、二重操作しない）。

# 連携先が未実装のときは、未確認ではなく注記として扱う（#5253）

「資料に無いから確認できない」と「相手側にまだ存在しないから確認する対象が無い」は、どちらも未確認になり、後者は人が連携先のリポジトリを調べるまで区別できなかった（aide RC-25のauth_boundary。morrow#683が計画段階）。`scripts/release-review-integrations.py`が連携先の`develop`と`main`の実物を確かめ、`counterpart.status`を付ける。

- `not_implemented`: どちらのブランチにも無い。確認項目を`unconfirmed`にせず`not_applicable`にし、結果の`counterpartNotes`へ注記する（画面の「相手側未実装の注記」。未確認範囲には入らずゲートを止めない）。`registeredIssues`に、相手側へ要件が登録済みのIssue（番号・題名・状態）を添える
- `develop_only`（developにだけある）・`on_main`（mainにもある）: 従来どおり実コードを読んで判定し、読めなければ未確認
- `unknown`: ブランチ不在・先端の取得失敗・ファイル一覧の打ち切り・読むファイルの上限超過・通信失敗。断定せず従来の資料未取得
- 根拠: `apiContracts`は受信パス（末尾の語まで緩めた一致）がツリー全体の本文・ファイル名に無いこと、`linkedRepos`は設定のpatternsに一致するコードが両ブランチに無いこと。偽陽性（実装済みを未実装と誤る）がゲートを通す方向に働くため、疑わしいものは`not_implemented`にしない。連携先の対応状況はIssueのopen/closedではなくブランチの実物で確かめる
- `release-review-links.json`の各連携先に任意の`identifiers`（API パス・環境変数名）を書くと、`registeredIssues`の検索に使われる

# 登録済みSecretsは名前で機械照合し、未確認で止めない（#5342）

新しいシークレット・環境変数を足すリリースで、「本番のSecrets／VPS .envへ同期済みか確認できない」が未確認として残り、指摘ゼロでも`needs_check`で止まっていた（aide RC-34）。`scripts/release-review-integrations.py`が、差分で`.github/secrets-manifest.tsv`に加わったキーを、GitHubのSecrets／Variablesの**名前だけ**で照合し、`manifest.json`の`secretRegistrations`へ`registered`・`missing`・`unknown`を残す。

- `registered`: 確認項目を`confirmed`にし、未確認範囲に含めない
- `missing`: 止める指摘にする
- `unknown`（権限不足・通信失敗で一覧が取れない）: 断定せず従来どおり未確認
- 値が空でないこと・相手側のトークンと一致することは名前では確かめられない。未確認で止めず、公開後の疎通確認へ回す提案として残す
- `scope=inherit`は組織の一覧、それ以外はリポジトリの一覧と照合する。値は取得しない。VPSの`.env`は照合対象外
- 登録状況は指紋に含まれるため、登録後の再実行で自動的に再評価される

# 他リポジトリの利用側が原因の未確認を扱う（#5378）

あるアプリのAPI・DBを別アプリが読む関係（AIDEのMCP `asset_manager_subscriptions`がAsset Managerの`GET /api/subscriptions`を読む、など）では、候補が項目を消す・変えると、全体レビューが利用側のコードを持たず「指摘0件・要確認（未確認）」で止まる（asset-manager RC-57、guchi-apps/asset-manager#1371）。直すコードが無いので自動修正の対象にならず、画面は「自動修正では解消できません」と出すだけで、人が利用側を読んで判断メモを書くしか進む道が無かった。

- **利用関係の登録**: `scripts/release-review-links.json`の各エントリは、`provider`（対象が呼ぶ側。#5223）に加えて`consumer`（対象のAPI・DBを読む利用側）を書ける。`triggers`に一致する変更があると、利用側の本番main先端のコード（`patterns`）と型（`types`）を`linkedRepos`へ`role: "consumer"`付きで渡し、プロンプトは「候補が変えた項目を利用側が読んで壊れるか」を実コードで判定させる。利用側の型は呼び先の型定義（`apiContracts`）へは混ぜない。呼び先のエントリは指紋を変えないよう従来の形のまま（`role`を付けない）
- **未確認の構造化**: 全体レビューは、別リポジトリのコードが無いことだけが理由の未確認を`crossRepoUnverified`（`repository`・`checkId`・`usage`・`reason`）として返す（schemaの必須項目）。サーバーは確認済み・非該当の項目を理由にしたものと`owner/repo`の形でないものを落として`findings.crossRepoUnverified`に保存する（`src/lib/release-review-cross-repo.ts`）。**判定・ゲートは変えない**——未確認範囲は従来どおり`unverifiedScope`が持つ
- **段階の内訳**: `describeReviewEvidenceStage`は`cross_repo`（他リポジトリの確認が必要な項目）を出し、その確認項目を汎用の`check_unconfirmed`に数えない
- **原因別の案内**: 指摘0件で止まったときの「次の操作」（`describeUnresolvableCause`）は、他リポジトリ・未読範囲・運用作業・統合検証・その他を出し分ける。他リポジトリだけが残るときは相手ごとに確認Issueの下書き（題名・本文を埋めたGitHubの新規Issue画面と、既存Issueの検索画面）を出す。**起票はissue-deckからは行わない**（相手リポジトリに同じ件があるかを人が確かめ、GitHubの画面で内容を見てから作る）
- 利用側の未確認文に「連携先」「資料」の語が入ると、証跡待ち（`review_unconfirmed`）にも数えられる。未確認の確認項目がすべて他リポジトリが理由なら、案内は他リポジトリとして扱う

各アプリのdocsへ「API項目を消すときは利用側を確認する」と書くのは応急処置で、恒久対策はこの登録と構造化で持つ。
