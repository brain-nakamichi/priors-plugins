# Priors Codex プラグイン

## 候補版 0.1.62

根拠が足りない、昔の経緯や撤回前の判断を確かめたい、正確な数値が必要など、追加の過去情報が役立つとAIが判断した場合は、現在の`recall` / `consult`契約が対応していれば`include_summaries: true`を選べます。数秒余分にかかることがあるため毎回は使わず、通常検索と深い検索の固定順序も設けません。通常検索ではfieldを省略するか`false`にします。`summary_expand`は独立した明示操作です。

Priorsは毎ターン検索するものではなく、固定手順もありません。ただし継続指示・重要決定/制約/却下案・未完了の約束・重大な運用結果・重要な訂正は、明示的な保存依頼を待たず保持します。過去情報が今回の回答や重要操作を左右し、最新文脈に不足する場合は依存前に対象を絞ってRecallします。利用機能は課題に合わせてAIが組み合わせます。フックの案内だけでは保存・取得の証拠になりません。

SessionStart で公式の Codex 用 `plugin.json` を読み取り専用で確認し、インストール版より新しい場合だけ更新を案内します。同じ版の通知は24時間に1回に抑制し、通信失敗時は通知しません。自動更新、token、MCP設定の変更は行いません。

UserPromptSubmit は毎ターン開始時に、保持基準に合う重要情報のRememberと、必要な場合のRecallをモデルへ短く案内します。追加の応答や固定手順は要求せず、保存やRecallの実行をフックが代行することもありません。

確認先は `PRIORS_PLUGIN_UPDATE_URL`、通知状態の保存先は `PRIORS_PLUGIN_UPDATE_STATE_FILE` で上書きできます。確認先は HTTPS かつ許可ホストのみ利用します。

手動の文書監査は [`docs/document-audit.md`](../../docs/document-audit.md) を参照してください。Claude と Codex の同じ `document-sync.js` に読み取り専用の `resolve` と `audit` サブコマンドが含まれます（プラグイン候補版 0.1.62）。`resolve` は通常の `document` read が返す完全な `local_source` tupleだけを使い、明示したrepo内のMarkdownファイルだけを確認します。本文を取得・出力・送信せず、編集や同期もしません。

```sh
node scripts/document-sync.js resolve --theme GEN --id <document-uuid> --repo <repository-root> --repo-id <audit-label> [--version N] [--metadata <search-or-read-json>]
```

IDかdocument keyをひとつ指定します。`source_match`、`older`、`newer`、`different`、`missing`、`no_source`のいずれかと、Priors本文SHA・version・audit noteを返します。`comparison_profile`はtupleの宣言値、`verified_comparison_profile`は一致を実際に確認した方式で、比較を確認できない`different`ではnullです。未証明の履歴は`different`となり、別のファイルは探索しません。`matches_priors_bytes`がtrueでなければローカルファイルとPriors本文は同一と扱いません。
直近のsearch/read JSONを`--metadata`で渡す場合は、その応答の文書IDまたはkeyに一致する行だけを使い、追加のMCP呼出しをしません。結果の`metadata_origin`は`captured_metadata`となり、保存済み応答の利用は現在のPriors再確認・権限再認証を意味しません。省略時は通常のread由来として`live_read`を返します。

### Asset 転送の再開

`asset-transfer.js fetch <asset_id> <destination>` は明示した保存先だけに取得します。既存ファイルやシンボリックリンクは置き換えず、保存先のベース名とAsset metadataのファイル名がWindows予約名なら停止します。
`asset-transfer.js resume <operation_id> <theme_id>` は、元と同じ接続先・Asset token・テーマ・ファイル名・内容でだけ再開します。
成功済みreceiptを再表示する場合も元ファイルを読み直して照合するため、再開・確認まで元ファイルを保持してください。
接続先は `?`・`#`・URL内の認証情報を含まないベースURLを指定してください。
旧形式の台帳に接続先の記録が無い場合は `asset_transfer_legacy_binding_missing` で停止します。
元のreceiptを確かめ、必要な転送は新しいoperation keyで `publish` してください。旧receiptを別テーマの共有成功として扱わないでください。

## 記憶サブagent pilot

Claudeの定義は `Priors/plugin/agents/priors-memory.md` にあり、`priors:priors-memory` として検出されます。Codex用 `agents/priors-memory.toml` は同梱していますが、pluginからの自動検出は確認していません。親は明示theme・session・task facts・許可済みcandidate IDs・関連する親ターンの事実だけを渡し、既定12回のPriors呼出し予算を使います。receiptは親が検証し、agentの報告だけで保存成功としません。

pilotのsynthetic Claude receipt testはhookの検証動作を確認するもので、実クライアントが同じsubagent eventを出す証明ではありません。Codexには現在candidateをacknowledgeするPostToolUse経路が無いため、候補はreviewまでpendingです。pilotの4 review観点と制約は [memory-agent pilot](../../docs/priors-memory-agent-pilot-20261024.md) を参照してください。
