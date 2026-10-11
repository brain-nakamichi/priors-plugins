# Priors Codex プラグイン

Priorsを使うか、何を保存するかはAIが現在の問いと将来の再利用価値を見て判断します。毎ターンの判定や会話終了時の保存は不要です。明確な継続要望はその回答から適用し、将来も役立つと判断した場合にだけ `refs.continuing_request` として保存します。起動時プレビューやpromptごとの自動Recallはありません。

SessionStart で公式の Codex 用 `plugin.json` を読み取り専用で確認し、インストール版より新しい場合だけ更新を案内します。同じ版の通知は24時間に1回に抑制し、通信失敗時は通知しません。自動更新、token、MCP設定の変更は行いません。

確認先は `PRIORS_PLUGIN_UPDATE_URL`、通知状態の保存先は `PRIORS_PLUGIN_UPDATE_STATE_FILE` で上書きできます。確認先は HTTPS かつ許可ホストのみ利用します。
