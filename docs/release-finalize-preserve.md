# 正式バンプは候補の内容を保持する

公開準備は固定された候補をcheckoutし、その内容に対して版だけを更新する。`package.json`等の版ファイルやlockfileをmainから丸ごと復元してはいけない。候補で変更したscripts・依存を失い、バンプ前と後で検証対象が変わってしまうため（#4706）。
標準npm経路は `--allow-same-version` を使い、同版の再試行もライフサイクルを実行する。カスタムbump-commandは従来どおりNEW_VERSIONを受け取り、候補内容を保持して更新する。
タグ予約・候補SHA照合・最終検証・公開承認は維持する。共有workflowの修正はmainへ公開した後、新しいworkflows/vNタグを配布先callerへ反映して初めて効く。
