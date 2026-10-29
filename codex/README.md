# Priors Codex プラグイン

## 候補版 0.1.69

Codex 0.165.0が実際に読むLegacyの`.mcp.json`を修正しました。Claude形式の`headers.Authorization`は無視されるため、`bearer_token_env_var: "PRIORS_TOKEN_CODEX_V1"`で環境変数を読みます。通常は同梱だけで接続でき、`config.toml`への追記は不要です。既存の`[mcp_servers.priors]`は同梱設定より優先され、同名で二重接続にはなりません。既存設定を自動で変更・削除しません。

CLI 0.165.0で、旧headersは認証なし・ツール0、修正版は認証付き・ツール1、http_headers内の`${VAR}`は未展開、手動設定は同名で優先、未設定の環境変数では接続しないことを、隔離TESTとローカルの偽MCPで検証しました。本物のtoken・本番・providerは使用していません。`hooks.json`は不変ですが同梱ファイルの内容が変わるため、更新後はCLI `/hooks`で4フックを利用者が再レビュー・信頼してください。

公開最新版の確認には端末からHTTPで直接取得したversionを使います。検索・Web閲覧ツールが古い写し（0.1.45）を返す一方、直接GETは0.1.68を返すことを2026-10-29に再現しました。これは全ネット取得が古いことを意味しません。取得方法・時刻を記録し、直接取得できなければ確認不可とします。

## 0.1.68の変更

SessionStart/UserPromptSubmitが動いている場合は、利用者のconfig.tomlを読み取り、4フックの信頼定義・bundle内容・有効状態を確認します。不一致が分かる場合だけ、対象名とCLI `/hooks`での直し方を同じ状態につき24時間に1回案内します。形式が違う・読めない・legacy信頼を確かめられない場合は黙ります。設定・信頼・legacy baselineを作成/変更しません。診断は保存済みの利用者設定について行い、起動時だけの上書き設定を実効状態だと推定しません。

4つとも停止していれば診断自体が動かないため、初回のCLI確認は必要です。`hooks.json`は今回変更しませんが、bundleのスクリプトが変わるので0.1.68更新時も利用者が個別にレビュー・再信頼してください。デスクトップの入力欄では `/hooks` が「コマンドがありません」となることを確認したため、CLIで確認してからアプリを起動し直します。daemonの警告では`Run without daemon this time`を使い、`Restart with these settings`は選びません。

0.165.0のCodexでは、ルート`plugin.json`があるAgent Plugins形式からはフックが検出されません。0.1.67はルートの同ファイルを配布せず、`.codex-plugin/plugin.json`を使う互換形式にします。更新通知の取得先も`codex/.codex-plugin/plugin.json`に変更します。0.1.66からの更新は、通常のmarketplace更新・再インストールで行ってください。古いルートファイルがキャッシュに残ると再発するため、公開側は削除も反映する必要があります。利用者がキャッシュや設定を手で編集する必要はありません。

公開後、利用者が新しいCodexを起動し、`/hooks`でPriorsのSessionStart・UserPromptSubmit・PostToolUse・Stopが検出されたことを確認して、必要なものを1つずつレビュー・信頼します。daemonの設定不一致が出る場合は、その回だけ`Run without daemon this time`を選びます。`Restart with these settings`は選ばず、background serverの設定も変更しません。検出試験はCLI 0.165.0とデスクトップ同梱エンジンで実施済みですが、通常環境での発火確認は公開後の別工程です。

GEN-1023/1640に合わせ、同じテナントで既存の書込認可を通るClaude/Codexが作成者を問わずサブテーマを編集・削除・復元できる案内へ訂正。現在版の再読・競合の再取得・出所の保持は続けます。移動は方式A（現在版を新IDへ、元履歴を保持）。SQL373と対応ツールの提供後だけ使い、既定dry-runで枠を確認してから確定します。公開とインストールはClaudeの別工程です。

SQL371 の quota 表示に対応。`accounting_mode=refundable` かつ `refunds_enabled=true` の owner だけ、削除で証明済みの枠が戻り、restore は再計上します。未有効化時は返却されません。公開・適用は別工程です。

根拠が足りない、昔の経緯や撤回前の判断を確かめたい、正確な数値が必要など、追加の過去情報が役立つとAIが判断した場合は、現在の`recall` / `consult`契約が対応していれば`include_summaries: true`を選べます。数秒余分にかかることがあるため毎回は使わず、通常検索と深い検索の固定順序も設けません。通常検索ではfieldを省略するか`false`にします。`summary_expand`は独立した明示操作です。

Priorsは毎ターン検索するものではなく、固定手順もありません。ただし継続指示・重要決定/制約/却下案・未完了の約束・重大な運用結果・重要な訂正は、明示的な保存依頼を待たず保持します。過去情報が今回の回答や重要操作を左右し、最新文脈に不足する場合は依存前に対象を絞ってRecallします。利用機能は課題に合わせてAIが組み合わせます。フックの案内だけでは保存・取得の証拠になりません。

SessionStart で公式の Codex 用 `plugin.json` を読み取り専用で確認し、インストール版より新しい場合だけ更新を案内します。同じ版の通知は24時間に1回に抑制し、通信失敗時は通知しません。自動更新、token、MCP設定の変更は行いません。

候補版0.1.66では、UserPromptSubmitで候補がある場合だけ短い案内を返し、PostToolUseで成功したID・版を手元に記録します。Stopは未確認の候補を1回だけ通知し、必要なら次の実際の利用者ターンに1回だけ持ち越します。応答を強制的に続けず、保存・検索を自動実行しません。今回のcandidate_idに対応する保存をサーバーのreceiptで確認した場合だけ、その候補を確認済みにします。

手元にはsession/turnの識別子・候補ID・時刻・短い区分・保存成功のIDと版だけを残します。本文・秘密値・prompt hash・transcriptは残しません。保存先は`${PLUGIN_DATA}/retention-state.json`（未提供時は`~/.priors/codex/`）、7日・最大16セッション×8ターン・64KiBです。競合・破損時は案内を省き、記録の成功を装いません。既知のサブエージェント／ハーネス入力を除外しますが、未知の形式の完全識別は保証しません。

手動導入したプラグインのフックは、Codexの`/hooks`で定義ごとの信頼確認が必要です。変更したフックは再確認してください。CLI 0.157.1とデスクトップ同梱エンジン0.165.0-alpha.1.2で、隔離TEST・偽MCPによる3イベントの発火を確認しました。通常のアプリUIへの候補版の導入・実運用確認は別工程です。作業台帳の新しい候補通知とコンパクト前後の点検は設計のみです。

確認先は `PRIORS_PLUGIN_UPDATE_URL`、通知状態の保存先は `PRIORS_PLUGIN_UPDATE_STATE_FILE` で上書きできます。確認先は HTTPS かつ許可ホストのみ利用します。

手動の文書監査は [`docs/document-audit.md`](../../docs/document-audit.md) を参照してください。Claude と Codex の同じ `document-sync.js` に読み取り専用の `resolve` と `audit` サブコマンドが含まれます（プラグイン候補版 0.1.66）。`resolve` は通常の `document` read が返す完全な `local_source` tupleだけを使い、明示したrepo内のMarkdownファイルだけを確認します。本文を取得・出力・送信せず、編集や同期もしません。

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

pilotのsynthetic Claude receipt testはhookの検証動作を確認するもので、実クライアントが同じsubagent eventを出す証明ではありません。候補版0.1.66のCodexでは、同じsession・turnの明示candidate_idと保存応答のcandidate_receiptsが一致した場合だけPostToolUseで確認済みにします。従来の手動record-decisionの記録から、新しい候補の確認済みを推定しません。pilotの4 review観点と制約は [memory-agent pilot](../../docs/priors-memory-agent-pilot-20261024.md) を参照してください。
# 公開候補 0.1.70：コンパクト後の簡易点検

PreCompactを追加し、SessionStart(source=compact)から1回だけ点検を案内します。本文/transcriptは扱わず、自動保存・自動起動もしません。公開後はCLI `/hooks`で **SessionStart・UserPromptSubmit・PostToolUse・Stop・PreCompactの5つ** を利用者が確認・再信頼してください。信頼や設定をプラグインは変更しません。公開はClaudeが利用者の許可を得て、他の変更とまとめます。
