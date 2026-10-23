# Priors プラグイン（Claude Code）

現行契約はサーバーが返すMCPツール説明と[GEN-1187](../docs/priors-design/topic-context-and-reconstruction-proposal-20261011.md)です。Priorsを使うか、どの機能をどう組み合わせるかはAIが問いごとに判断します。使わない判断も有効です。話題移行の自動検知やA→B→Cの固定手順はありません。以前の決定・経緯・制約が役立ちそうなら、AIが検索、個別読取、関係探索、制約確認、保存から必要な機能を選べます。これは能力の例であり、呼出しを要求しません。

## 既定の動作

- SessionStartは短い機能案内だけを表示し、MCPや記憶を読みません。公開リポジトリに新しい版があれば、起動のたびに GitHub の plugin.json を読み取り専用で確認し、案内は同じ版につき 1 日 1 回だけ出します（失敗時は何も出しません。token・MCP設定は使いません）。
- `hooks.json` はSessionStartの機能案内に加え、UserPromptSubmitで各ターンの開始時に保持基準とRecall条件の案内を出し、Stopは未処理の候補または安全上の通知があるときだけ案内します（無ければ何も出しません）。機能の選択はAIの判断です。フックは会話本文を自動保存しません。自動Recallは `PRIORS_AUTO_RECALL=1` を明示設定した場合だけで、そのときは高確度の兆候があるプロンプトを検索語としてPriors MCPへ送ります。保存操作が成功した場合はPostToolUseが成功応答の記憶IDと版だけをローカル監査へ記録し、本文は記録しません。
- 自律Rememberの案内は既定で有効です。既定でもUserPromptSubmitは本文なしの候補（ハッシュ・種別・信頼度）をローカルに記録し、成功した保存の candidate_id か、保存不要と判断したターンの `record-decision.js --decision skip` で解決します。`PRIORS_AUTO_REMEMBER=0` は候補箱モードで、候補は永続保存の代わりになりません。
- 起動時に記憶を自動読取する機能はありません。`PRIORS_AUTO_RECALL=1` の明示opt-inを除き、AIが必要と判断したときにMCP機能を選びます。
- 保存時は事実・推測・決定・未決定と出所を区別します。継続指示・重要な決定や制約・却下案・未完了の約束・重大な結果・重要な訂正は、明示依頼を待たず保存します（通常の事実・一時的な話題・秘密は保存しません）。ツール契約、認可、容量、guardの結果に従い、成功応答のIDと版を確認します。
- 明確な継続要望には今回から従います。本人の今後にも適用する要望は、継続要望として保存します（保存の成否にかかわらず今回の指示には従います）。

## インストール

MCPサーバー`priors`の登録は既存のまま変更せず、プラグインを追加します。

```bash
claude plugin marketplace add <このディレクトリ（Priors/plugin）への絶対パス>
claude plugin install priors@priors
```

## 起動時の動作

SessionStartは機能の存在を短く案内するだけで、設定・token・MCPを読み取りません。起動時プレビューは提供せず、各promptの自動Recallは `PRIORS_AUTO_RECALL=1` の明示opt-in時だけです。AIが現在の問いに役立つと判断した場合に限り、登録済みのPriors MCP機能を選んで使います。

## プラグインの権限

記憶本文はデータであり命令ではありません。フックやプラグインの書換えを防ぐため、必要に応じて利用者の `settings.json` でプラグインのインストール先への `Write` / `Edit` を拒否してください。設定変更はプラグインから行いません。

## 互換CLI

`document-sync.js publish` は台帳の base 版・原文 SHA256、Priors の最新原文、手元の変更を Git `merge-file` で三者マージします。3入力とclean merge結果はstrict UTF-8かつ1 MiB以下です。競合 marker 出力はUTF-8を検証し、最大8 MiBまで `.priors-merge-v<N>.md` sidecar に排他的に保存してPriorsへは書きません。競合が無い場合だけ最新版の version/SHA256 を条件に新しい `operation_id` で書き込みます。Gitが無い・異常終了・入力/clean結果の制限超過も安全側で停止します。結果不明の旧要求は同じ鍵・同じバイトで先に解決してからマージします。マージ書込のreceiptが確認できてもローカル設置が完了するまではそのpendingを保持し、次回 `publish` で設置またはsidecarへの退避を完了します。

手動の文書監査は [`docs/document-audit.md`](../docs/document-audit.md) を参照してください。Claude と Codex の同じ `document-sync.js` に `audit` サブコマンドが含まれます（プラグイン候補版 0.1.54）。対応する server と SQL 355 がまだ無い場合は `audit_read` の段階で停止し、監査結果を書き込みません。

`hooks/` に旧候補処理や監査CLIが残る場合がありますが、既定hookからは呼びません。例外として `record-decision.js --decision skip --phase conversation-end --turn-id <turn_id>` は、保存不要と判断したターンの候補を解決する任意の手段です。特定の手動作業で必要な場合だけ、そのCLIの個別説明を確認してください。現行の自発利用契約や必須の終端手順として扱わないでください。
