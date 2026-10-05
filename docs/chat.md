# IssueDeck Chat（会話型の操作入口）

#3975。左メニュー・スマホホームの「チャット」（`?pane=chat`／`?mscreen=chat`）から、自然言語でIssue・PRの状態確認、PR自動修正、Issue起案を行う。**チャットは新しい実行基盤ではなく、既存のService/APIを呼ぶ会話型の入口**で、一覧・Issue/PR詳細は変わらず併存する（回答のカードから「PR詳細を開く」「GitHubで開く」で移れる）。

## 構成

| 層 | ファイル | 役割 |
|---|---|---|
| 意図解釈 | `src/lib/chat/intent.ts` | 決まった言い回しだけを拾う（LLMには任せない）。`resolveIntent`が会話コンテキストを当てはめ、対象が決まらなければ`ask`（聞き返し） |
| カード | `src/lib/chat/status-card.ts` | 既存の判定値（CI・レビュー判定・mergeable・修復run）を言葉と色に写すだけ。判定ロジックは持たない |
| 処理 | `src/lib/chat/handlers.ts` | 状態取得は既存関数、修復・Issue作成は下の共通サービスを呼ぶ |
| 共通サービス | `src/lib/github/pull-request-repair-service.ts`・`issue-create-service.ts` | 画面のボタン（`POST /api/pull-requests/repair`・`POST /api/issues`）とChatが**同じ関数**を呼ぶ。HTTPへの写し方だけが各ルートに残る |
| API | `src/app/api/chat/` | 会話一覧・作成、発言（`[id]`）、確認カードの実行（`[id]/confirm`） |
| 保存 | `ChatConversation`・`ChatMessage`（Prisma） | 会話コンテキスト（直前の対象・実行した操作）と発言・カード・確認状態 |

## 書き込み操作の確認ルール

- 状態確認（読み取り）は発言からそのまま実行する。
- **PR自動修正とIssue作成は、発言では実行しない。** 確認カード（`confirm_repair`・`confirm_issue`）を返し、`POST /api/chat/[id]/confirm`の`execute`だけが実行する。確認APIは次を守る。
  - カードの内容はクライアントの申告でなく**保存済みの発言**から読む（Issue案のタイトル・本文の編集だけは利用者自身の入力として受ける）
  - `confirmState`を`pending`→`done`へ更新できた1回だけ実行する（二重クリック・再送で2回走らない）。失敗したときは押し直せるよう`pending`へ戻す
  - `PREVIEW_MODE`では実行を403で止める
- 修復は既存と同じく、実行時のHEADから`repairKindsFor`で種類を組み直し、conflict → ci → review の先頭1種類だけを起動する。確認カードには起動順を表示する。

## 会話コンテキストの解釈

`ChatContext.targets`は**直前の発言で見せた対象**（発言のたびに置き換える）。1件なら「それ」「直して」「もう一度確認して」「マージできる？」が指し、複数を並べた直後は聞き返す（候補をボタンで出す）。番号だけの発言は`ChatContext.repo`（会話を作るときに選ぶrepository）を補う。

## 第一段階で扱わないもの

自由形式のコード編集、LLMによる意図解釈（言い回しの拡張が必要になったら別Issue）、Claude/Codexの直接起動（既存の実行系はIssue詳細・実行状況から使う）、セッション詳細の表示（状態カードにはセッション名と状態だけを出す）。
