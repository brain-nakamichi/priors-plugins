# Priors plugins

Priors の公式配布用プラグインです。Claude Code と Codex の配布物だけを含み、サーバー本体・データベース設定・資格情報は含みません。

## Claude Code

```bash
claude plugin marketplace add https://github.com/bb-brain/priors-plugins.git#main/claude
claude plugin install priors@priors
```

詳細は [`claude/README.md`](./claude/README.md) を参照してください。MCP の利用者 token と hook token は別途設定が必要です。token の値はリポジトリへ書き込まないでください。

## Codex

Codex のプラグイン管理画面またはローカル登録で [`codex/`](./codex/) を指定してください。MCP 接続には `PRIORS_TOKEN_CODEX_V1` 環境変数を使います。

## 配布物に含めないもの

本リポジトリには token、秘密鍵、`.env` ファイル、データベース接続文字列を含めません。Priors サーバーへの接続先は `https://priors-brain9.vercel.app/mcp` です。
