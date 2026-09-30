# Priors Codex プラグイン

SessionStart で公式の Codex 用 `plugin.json` を読み取り専用で確認し、インストール版より新しい場合だけ更新を案内します。同じ版の通知は24時間に1回に抑制し、通信失敗時は通知しません。自動更新、token、MCP設定の変更は行いません。

確認先は `PRIORS_PLUGIN_UPDATE_URL`、通知状態の保存先は `PRIORS_PLUGIN_UPDATE_STATE_FILE` で上書きできます。確認先は HTTPS かつ許可ホストのみ利用します。
