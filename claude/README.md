# Priors プラグイン（Claude Code）

Priorsの利用は任意です。AIが現在の問いに役立つかを判断し、必要な場合だけ機能を選んで組み合わせます。使わない判断も有効です。話題移行の検知、固定された呼出し順、毎promptの自動Recallや自動保存は行いません。

## Hook の動作

- SessionStartは、機能の存在と任意利用を短く案内します。
- Hookは設定、token、MCP、記憶、プロンプト本文を読み取りません。
- UserPromptSubmit、PostToolUse、Stop hookは登録していません。
- 起動時プレビューと `PRIORS_AUTO_RECALL` による自動取得はありません。

## インストール

Claude Codeの利用者スコープでPriors MCPサーバーを登録した後、プラグインをインストールします。

```bash
claude plugin marketplace add <marketplace path>
claude plugin install priors@priors
```

記憶を読む場合は、タスクに応じて `context_open`、`recall`、`consult`、`get`、`expand` などから必要な機能を選べます。これらを全部呼ぶ必要はなく、短い検索だけで足りるならそこで止めます。書込み前には選択した機能の契約と `guard` の結果に従います。

## スキルと設定

`skills/priors/SKILL.md` はツールの使い方と制約を案内しますが、Priorsの利用や保存を強制しません。接続先や認証情報はMCPクライアント側の設定を使います。プラグインは利用者設定・tokenを読み書きしません。

テストは `npm test` で実行します。
