---
name: priors
description: Priors（AI長期記憶のMCPサーバー）を毎ターン使うか判断し、必要なときだけ安全に残す・思い出す・テーマを決める手順。毎回 use-read / write-candidate / skip のいずれかを選び、使わない場合もローカル監査ログへ記録する。
---

# Priors｜記憶を残す・思い出す・テーマを決める

## 0. 毎ターンの判定（省略しない）

各ユーザー入力について、応答や作業に入る前に次のいずれかを選ぶ。

- **use-read**: 既存の決定・経緯・制約が関係する。`context_open` → `recall` / `get` 等。
- **write-candidate**: 利用者が記憶を求めた、または将来も再利用する確定事項がある。`context_open` → `recall` → `guard` → `remember` / `amend`。`guard` が clear でない限り書込まない。
- **skip**: Priors の参照・書込が不要。推測で呼ばず、判断だけを監査ログへ残す。

Claude の UserPromptSubmit フックはこの判定を毎回リマインドし、入力本文は保存せずハッシュ値と `pending` のみを保留記録する。明示的な結果は、プラグイン内の `hooks/record-decision.js --decision use-read|write-candidate|skip --client claude --phase turn-start|conversation-end --prompt-sha256 <hash>` でローカルの `~/.priors/decision-audit.jsonl` に追記する。ログは Priors 本文と別物で、トークン・本文・接続情報を含めない。Stop の呼出確認は本文を保存しない匿名カウンタへ記録する。

会話を終了する前にも必ず同じ判定を行う。Claude の終了イベントが判定をリマインドし、Codex はこの節を毎ターンの完了条件として扱う。`use-read` / `write-candidate` / `skip` のいずれかを監査ログへ記録し、未判定のまま終了しない。終了イベントは書込を実行せず、`write-candidate` の次の応答でだけ通常の `context_open` → `recall` → `guard` → `remember` / `amend` 手順へ進む。

Priors は MCP サーバーが正本。このスキルは**規約の置き場**であり、テーマ一覧（prefix の実例を含む）・enum の値の一覧・tool の引数一覧は書かない（版がずれるため）。値が要るときは次を見る。

- **サーバー instructions**: 会話の冒頭に MCP サーバーの instructions として既に載っている JSON（`themes`・`triggers`・`id_syntax`）。tool ではないので「呼ぶ」ものではない。
- **tool 定義**: 各 tool の引数名・必須・enum。

## 1. 最初に触れる時点で `context_open` を呼ぶ

会話の先頭に Priors の下見（SessionStart フックが積んだデータ）があっても、それは**書込の代わりにならない**。主テーマの束縛もテーマ切替の確認もそこでは行われない。

- **その会話で Priors に最初に触れる時点で**（書込でも、`guard` でも、読取だけでも）自分で `context_open(theme)` を呼ぶ。以後は同じ応答の `resolved_session_id` を `session_id` として使い回す。
- テーマはサーバー instructions の `themes` から **prefix** で選ぶ（表示名で呼ばない）。似た prefix を手で作らない（似た prefix は `prefix_lookalike` で弾かれる）。目的のテーマが無ければ、その場で作らず管理者にテーマ作成を依頼する（テーマ作成は tool ではなく管理スクリプト）。
- 例: `context_open({ theme: "<prefix>" })`（`<prefix>` は `themes[].prefix` のいずれか）

## 2. 調べる

調べるのは `recall`（問い）／`get`（ID）／`timeline`（経緯）／`as_of`（当時の信念集合）。ID と候補 ID の書式はサーバー instructions の `id_syntax` を見る。

MCP接続後にテーマが追加された可能性があるときは、読み取り専用の `theme_list` を呼び、最新の可視テーマ一覧を取得する。一覧に無いことだけで不存在と判断しない。

## 3. 提案・実行の直前：`guard`

新しい提案や実行に踏み出す直前に `guard` を呼び、`plan_text` を付けて過去に否定した案と照合する。`guard` も `session_id` が**必須**（1 節の `context_open` が先）。`verdict` が `blocked` / `warn` なら、まず `matched` の根拠を確認してから進める。

## 4. 残す判断：`remember`

**残す**: 高くついた知見、再発しうる落とし穴、撤回した判断、決めたことと理由。
**残さない**: 単なる作業ログ、一時的な状態（それは `checkpoint` へ）。

- **kind の要点は「確かめた事実か、まだ推測か」を分けること**。確かめた事実／決めたこと／守る規則／未解決の問い／未確証の仮説／取り消し、のどれかを見極めてから、tool 定義の enum から対応する値を選ぶ（推測を事実の値に格上げしない）。
- **memory_type の要点は「手順か、事実・関係か、出来事か、作業中の状態か」**。同じく tool 定義の enum から選ぶ。
- `session_id` は自分が呼んだ `context_open` の応答（`resolved_session_id`）から。`remember` では省略しても `no_session_theme_check` の warning が付くだけで拒否されないが、テーマ照合の恩恵を捨てるので基本は渡す。**`checkpoint` と `guard` では必須で、省略できない。**
- 書込先が主テーマと違うと `theme_switch_required` で一度止まる。**書込先テーマ（prefix と表示名）を利用者に提示して同意を得てから** `confirm_theme_switch: true` を付けて再送する。モデルの自己判断で「確認済み」としない（ゲートが捕まえたいのはモデル自身の prefix 取り違え）。
- **再送では `idempotency_key` を変えない**（`confirm_theme_switch` の付け直し、`rate_limited` 後の再試行、通信失敗の再送）。内容を変えるときだけ新しい鍵にする。
- 試験・練習の書込は本番テーマに混ぜない。評価専用テーマ **ZZPROBE**（サーバー instructions の `themes` には出ないが `namespace` に指定できる）へ書く。主テーマと違うので `theme_switch_required` が出る。上の手順で利用者に提示してから再送する。

## 5. 直す：`amend`

内容の訂正・撤回・pin は `remember` の作り直しではなく `amend` で行う（`mode` と `reason` は tool 定義を見る）。

- 訂正は revise、変化時点が説明できる置き換えは supersede、間違いだったので取り消すのは retract（**削除ではなく retraction として残す** — 「なぜ覆したか」が価値）、反証を立てるのは dispute。「消して」と言われたら retract を提案する。実データの削除が要るときは管理者へ（tool では消せない）。
- **pin**: 常に出したい記憶は pin。**Tier A**（本文つきで常時出る）と **Tier B**（`work_kinds` / `tags` の条件に一致したときだけ見出しが出る）を使い分ける。汎用の心得は A、特定の作業種別でだけ効かせたい注意は B。

## 6. 終える：`checkpoint`

作業の区切り・中断のたびに `checkpoint` を残す（`session_id` 必須）。次回の `context_open` で handoff 枠に出る。`phase` は tool 定義の enum から状況に合うものを選ぶ。

## 7. してはいけないこと

- token・DB 接続文字列を会話・文書・記憶本文に出さない。環境変数や `.env*` の値を読んで確認する行動もしない。
- Priors の tool 名を接頭辞つき（`mcp__…` 形式）で記憶や文書に書かない。書くときは素の名前（`context_open` / `remember` など）にする。
- SessionStart フックの下見に `resolved_session_id` 相当のものが**あるように見えても、書込には使わない**（フックはそれを渡さない設計。書込用の `session_id` は必ず自分の `context_open` の応答から取る）。
- MCP 登録や利用者の Claude 設定を自分で書き換えない。

## 8. 困ったとき

| 応答 | 一行対処 |
|---|---|
| `unauthorized` | token が無効・失効・期限切れ（テーマとは無関係）。**値は読まない・出さない**。管理者に再発行を依頼する |
| `forbidden` | この credential ではこの tool を呼べない（読取専用、または権限外）。設定は自分で変えず、利用者・管理者に伝える |
| `theme_switch_required` | 4 節の手順（利用者に書込先を提示 → 同意 → 同じ `idempotency_key` で `confirm_theme_switch: true`） |
| `invalid_input` | 未知の enum 値、allowlist 外の `work_kinds` / `tags`、必須引数の欠落（`checkpoint` / `guard` の `session_id` など）。tool 定義を見て選び直す |
| `not_found` | ID かテーマの prefix を間違えている可能性。サーバー instructions の `themes` と `id_syntax` で確認 |
| `rate_limited` | 短時間に呼び過ぎ。`retry_after_seconds` を待ち、同じ `idempotency_key` で 1 回だけ再試行。連打しない |
