# Priors plugins

公開配布用の Priors プラグインです。Claude Code と Codex から Priors の MCP を利用できます。サーバー本体・データベース設定・資格情報は含みません。

## Claude Code

```powershell
claude plugin marketplace add https://github.com/brain-nakamichi/priors-plugins.git
claude plugin install priors@priors
```

token は設定ファイルへ貼り付けず、案内された安全な環境変数へ設定してください。導入後の接続確認は [Claude 専用ガイド](https://priors-brain9.vercel.app/#/guide-claude) を参照してください。

## Codex

`codex/` を Codex のプラグイン管理画面またはローカルプラグイン登録から指定します。Windows CLI では `codex.cmd` を使えます。

```powershell
codex.cmd plugin marketplace add <このリポジトリをcloneした場所>\codex
codex.cmd plugin add priors@priors
codex.cmd plugin list
```

標準経路は同梱スキルと MCP 手順です。利用者用 Codex token は `PRIORS_TOKEN_CODEX_V1` などの安全な環境変数へ設定してください。導入後の接続確認は [Codex 専用ガイド](https://priors-brain9.vercel.app/#/guide-codex) を参照してください。

## 配布版

- Claude plugin: 0.1.31
- Codex plugin: 0.1.35

Priors サーバーへの接続先は `https://priors-brain9.vercel.app/mcp` です。

## 配布物に含めないもの

本リポジトリには token、秘密鍵、`.env` ファイル、データベース接続文字列を含めません。
