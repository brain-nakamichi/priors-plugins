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
codex.cmd plugin marketplace add <このリポジトリをcloneした場所>
codex.cmd plugin add priors@priors
codex.cmd plugin list
```

標準経路は同梱スキルと MCP 手順です。利用者用 Codex token は `PRIORS_TOKEN_CODEX_V1` などの安全な環境変数へ設定してください。導入後の接続確認は [Codex 専用ガイド](https://priors-brain9.vercel.app/#/guide-codex) を参照してください。

### Codex のフック（別パッケージ）

0.1.76 から、保存支援の 5 フックは `codex-hooks/`（`priors-hooks@priors`）に分かれました。本体だけを更新したときは、フックの再信頼は要りません。フック専用パッケージを更新したときだけ、CLI の `/hooks` で 5 フックを確認してください。

初めて切り替えるときは、**先に本体を 0.1.76 以上へ更新**して旧フックが無くなったことを確かめてから、フック専用を追加します。古い本体（0.1.75 以下）を残したままフック専用を足さないでください（フックが二重に動きます）。

```powershell
codex.cmd plugin add priors-hooks@priors
```

## 配布版

- Claude plugin: 0.1.78
- Codex plugin（本体）: 0.1.78
- Codex hooks（`priors-hooks`）: 0.1.0

この欄は公開時点の目安です。正本は `.claude-plugin/marketplace.json`（Claude）、`codex/.codex-plugin/plugin.json`（Codex 本体）、`codex-hooks/.codex-plugin/plugin.json`（Codex フック）の `version` です。それぞれ版を別々に上げることがあります。

Priors サーバーへの接続先は `https://priors-brain9.vercel.app/mcp` です。

## 配布物に含めないもの

本リポジトリには token、秘密鍵、`.env` ファイル、データベース接続文字列を含めません。
