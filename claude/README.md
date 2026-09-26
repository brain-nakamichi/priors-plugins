# Priors プラグイン（Claude Code）

契約の正本は `docs/claude-plugin-design.md`（v2）。このプラグインは SessionStart の下見と、毎回の UserPromptSubmit 判定リマインドを配る。

## 何をするか

- セッション開始（`startup` / `resume`）のたびに、設定したテーマの記憶の **下見（プライミング）** を `additionalContext` へ載せる。
- 下見に載るのは `pinned`（tier A は本文つき、tier B は見出しのみ）・`handoff`・`recent` の 3 枠。逐語・順序維持で、要約や言い換えはしない。
- **書込は一切しない。** `remember` / `amend` / `checkpoint` / `guard` / `recall` はこのフックからは呼ばない。書込前に `context_open(theme)` を自分で呼ぶことは、下見の固定行が毎回明記する（主テーマの束縛とテーマ切替の確認はそこで行われる）。
- **毎ターン判定**: UserPromptSubmit が use-read / write-candidate / skip の選択を促す。入力本文は保存せず、保留行と SHA-256 だけを `~/.priors/decision-audit.jsonl` に記録し、明示結果は `hooks/record-decision.js --phase turn-start` で追記する。終了時は `--phase conversation-end` を使う。Stop の呼出確認は本文を保存しない `~/.priors/stop-hook.jsonl` に匿名イベントとして記録する。
- **サーバー側の最後の防波堤**: 書込要求には `session_id` を必須とし、server が同一トランザクション内で `guard` を実行してから `remember` / `amend` / `checkpoint` を実行する。client の `guard` を置き換えるものではない。
- **会話終了時判定**: 終了イベントでも use-read / write-candidate / skip の判定を促し、未判定のまま終了しない。終了イベント自身は書込せず、write-candidate の次の応答で通常の guard 済み手順へ進む。監査ログには本文を保存しない。
- 失敗しても会話は止めない。**常に exit 0。**
- 出力は `{ systemMessage, hookSpecificOutput: { hookEventName, additionalContext } }` の形。`systemMessage` は **top-level**（人向けの短い 1 行、採用した設定ファイルの絶対パスと `pinned`/`handoff`/`recent` の件数を含む）、`additionalContext` が AI 向けの下見データ本体。

## インストール

MCP サーバ（`priors`）の登録は既存のまま変更しない（`~/.claude.json` の利用者スコープ登録を使い続ける）。

```bash
claude plugin marketplace add <このディレクトリ（Priors/plugin）への絶対パス>
claude plugin install priors@priors
```

## token の置き方

フック専用の credential token（`pv1a...`。発行時に一度だけ受け取った値）を置く方法は 2 通りある。優先順は **`--token-file` 引数 → `PRIORS_HOOK_TOKEN_FILE` 環境変数 → `PRIORS_HOOK_TOKEN_V1` 環境変数**。

### 既定: シェル環境変数

```bash
export PRIORS_HOOK_TOKEN_V1='pv1a...'
```

**`settings.json` の `env` には書かない。** `settings.json` は AI が日常的に読む設定ファイルであり、平文の秘密を載せる場所ではない。露出時の被害範囲は、この token の権限（`automated_hook` credential・`context_open` と `guard` のみ呼べる）で絞ってある。

### 代替: token ファイル

環境変数にしたくない場合は、token 1 行だけを書いたファイルを用意し、パーミッションを `600` にして **dotfiles（`.claude/` 配下等、Claude Code が日常的に読み書きする場所）の外**に置く。

```bash
umask 077
echo 'pv1a...' > ~/.secrets/priors-hook-token
chmod 600 ~/.secrets/priors-hook-token
```

`hooks.json` は現状（環境変数方式が既定）のまま変更していない。ファイル方式を使う場合は、利用者が `hooks.json` の `command` に `--token-file <path>` を追加するか、`PRIORS_HOOK_TOKEN_FILE` 環境変数でパスを指定する。ファイルが読めない・空の場合は「token が無い」として扱われる（fallback して環境変数を見ることはしない）。

接続先を既定（`https://priors-brain9.vercel.app/mcp`）以外にする場合は `PRIORS_MCP_URL` を設定する。**`https://` 必須（loopback = `127.0.0.1` / `localhost` / `[::1]` のみ `http://` 可）で、ホストは allowlist（既定ホスト＋loopback）に含まれる必要がある。** allowlist に無いホストへは送信せず注記して終える。allowlist を広げたい場合（試験用のプロキシ等）は `PRIORS_MCP_ALLOWED_HOSTS`（カンマ区切りのホスト名）で明示する。

## `.claude/priors.local.json` の書き方

プロジェクトの既定テーマを決める。**`cwd` から git ルート（無ければ 3 階層上。ファイルシステムの root 自体は候補にしない）まで**上方探索し、各階層で `.claude/priors.local.json` → `.claude/priors.json` の順に最初に見つかったものを使う。

```json
{
  "theme": "GEN",
  "work_kinds": ["deploy"]
}
```

- `theme`: `initialize` が返す可視テーマの prefix（例: `GEN`）。テーマ scope のみ（owner/workspace は指定できない）。
- `work_kinds`: 省略可。pinned 枠 tier B の絞り込み条件（作業種別）。**server 側の allowlist（`priors.work_kind`）による照合を受ける。** ここで書いた値が server 側に存在しない場合、`context_open` は `invalid_input` として拒否され、フックは「呼出しが拒否された」旨を注記する。

**存在しないときだけ次の候補（`priors.json`）を見る。存在するのに壊れている（JSON として読めない・`theme` が大文字始まりの英数字でない 等）場合は fallback せず、そのファイルの絶対パスと理由を注記して終える。** 無言で握りつぶさない。

`priors.local.json` は個人環境固有の設定なので `.gitignore` に加える。`priors.json` は自分が所有する repo に限り commit してよい（優先順位は `priors.local.json` が上）。

```gitignore
.claude/priors.local.json
```

## 推奨の権限設定

記憶本文は「下見（データ）」として additionalContext に載るだけで、指示として扱わない設計になっている（囲い＋ガター方式で sink 対策済み）。ただし、記憶本文に紛れ込んだ指示文が AI 自身を誘導し、フック実体（`Priors/plugin/**` や、インストール後のキャッシュ `~/.claude/plugins/**`）を書き換えさせる、という別経路の攻撃は原理的にあり得る。この経路への防御として、利用者の `settings.json` の `permissions` に次の deny を加えることを推奨する（設定変更自体は利用者が行う。このプラグインは自分の設定を書き換えない）。

```json
{
  "permissions": {
    "deny": [
      "Write(~/.claude/plugins/**)",
      "Edit(~/.claude/plugins/**)",
      "Write(<Priors/plugin への絶対パス>/**)",
      "Edit(<Priors/plugin への絶対パス>/**)"
    ]
  }
}
```

## 生存確認（`--selftest`）

```bash
node hooks/session-start.js --selftest [--token-file <path>]
```

ネットワークへは一切出ない。表示するのは:

- `cwd` と設定探索の結果（見つかった設定ファイルの絶対パス・`theme`・`work_kinds`。壊れている場合は `config: invalid (...)  reason=...`）
- token の**有無**と出所（`env` / `file`）・簡単な形式チェックの結果（値そのものは出さない）
- token ファイルを指定した場合はその**パス**と存在有無（中身は出さない）
- `PRIORS_MCP_URL` の**ホスト名だけ**（既定か否かの注記付き。パス・クエリ・スキームは出さない）

新しいセッションを開始したときに、先頭に下見が出るか（出なければ注記が出るか）でも動作確認できる。

## 失敗時の挙動

常に exit 0 で、`systemMessage`（top-level）と `additionalContext` に種類別の 1 行が入る。

| 状況 | 注記 |
|---|---|
| 設定ファイルが存在するのに壊れている（`config_invalid`） | 採用しなかったファイルの絶対パスと理由の種別（値は出さない） |
| `PRIORS_MCP_URL` が https でない（loopback 以外）・allowlist 外ホスト（`url_rejected`） | 検証に失敗したため送信しなかった旨（URL は出さない） |
| Node ランタイムが `fetch` に未対応（`runtime_unsupported`） | 下見を省いた旨 |
| token が無い（env・ファイルいずれも） | token が無いため下見を省いた旨 |
| 設定のテーマが `initialize` の可視テーマに無い | テーマ名を名指しして `.claude/priors.local.json` の確認を促す |
| HTTP 401 / 403（`auth`） | token が無効か失効している可能性がある旨（値は出さない） |
| JSON-RPC error、または `context_open` が `isError:true`（`tool_error`） | 呼出しが拒否された旨＋**エラーコードだけ**（本文は転記しない） |
| その他の到達不能（ネットワークエラー・401/403 以外の HTTP エラー） | 到達に失敗した旨 |
| deadline（既定 7 秒。`PRIORS_HOOK_DEADLINE_MS` で 100〜14000ms にクランプして上書き可）超過 | タイムアウトした旨 |
| 応答の形が不正（本文が 1 MB 超の場合を含む） | 応答の形が不正だった旨 |

理由の詳細・URL・token・生の JSON 応答・エラー本文は一切出力しない（stdout・stderr のいずれにも）。`initialize` の `instructions` が解釈できない場合は、下見全体は捨てずテーマ照合だけを省いて `context_open` へ進み、その旨を注記する。

## 戻し方

```bash
claude plugin uninstall priors@priors
```

MCP 登録には触れていないため、それ以外に戻す作業は無い。

## version bump

`.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の `version` を上げてから、`claude plugin install priors@priors` を再実行するとキャッシュへ反映される（`Priors/plugin` がこのプラグインの正本で、インストールはキャッシュへのコピーにすぎない）。

## 限界

- **runtime（Claude Code 本体）にこのフックプロセスが kill されたときは、注記すら出ない。** これは設計上の既知の限界であり、`hooks.json` の `timeout`（15 秒）よりスクリプト内部の deadline を短くしてあるのはこのため。
- `.claude/priors.local.json` の上方探索は、他人の repo の上位ディレクトリに自分の設定があると誤って拾う可能性がある（設計 7 節に明記された未解決の懸念）。git ルートで探索を止め、ファイルシステムの root 自体を候補から除くことである程度緩和しているが、根本解決ではない。
- `automated_hook` credential による `context_open` はセッションの主テーマを束縛しない。書込の前に AI 自身が `context_open(theme)` を呼ばない限り、テーマ切替ゲートは働かない。
- **無害化による改変点（逐語性の限界）**: additionalContext に載せる記憶本文は、次の変換を経る。
  - 制御文字（`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`）は除去する。
  - タブは削除せず半角スペース 2 個に置換する。
  - `<` `>` は全角（`＜` `＞`）へ、`://` は `:／／` へ置換する（sink 対策。囲いマーカーの偽造や擬似タグの混入を防ぐ）。
  - 各行の先頭には `│ ` を付ける（「囲い＋ガター」方式で記憶データを視覚的・構造的に区切る）。
  - **NFKC 正規化は掛けない**（逐語性のため。全角/半角・合字等の畳み込みはしない）。
  - additionalContext 全体が 16 KB を超える場合は切り詰め、その旨を 1 行添える。
  上記はすべて「記憶本文をそのまま指示として実行させない」ための変換であり、内容の意味を変えるものではないが、**文字単位では完全な逐語ではない**ことに注意する。
