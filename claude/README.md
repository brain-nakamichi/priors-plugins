# Priors プラグイン（Claude Code）

契約の正本は `docs/claude-plugin-design.md`（v2）。このプラグインは SessionStart の下見と、毎回の UserPromptSubmit 判定リマインドを配る。

## 何をするか

- セッション開始（`startup` / `resume`）のたびに、設定したテーマの記憶の **下見（プライミング）** を `additionalContext` へ載せる。
- 下見に載るのは `pinned`（tier A は本文つき、tier B は見出しのみ）・`handoff`・`recent` の 3 枠。逐語・順序維持で、要約や言い換えはしない。
- **書込は一切しない。** `remember` / `amend` / `checkpoint` / `guard` / `recall` はこのフックからは呼ばない。書込前に `context_open(theme)` を自分で呼ぶことは、下見の固定行が毎回明記する（主テーマの束縛とテーマ切替の確認はそこで行われる）。
- **毎ターン判定**: 既定の自律RememberモードではClaude/Codexが use-read / 自動remember / skip を判断する。`PRIORS_AUTO_REMEMBER=0` の旧候補モードだけ UserPromptSubmit が use-read / write-candidate / skip の選択を促す。入力本文は保存せず、保留行と SHA-256 だけを `~/.priors/decision-audit.jsonl` に記録し、明示結果は `hooks/record-decision.js --phase turn-start` で追記する。終了時は `--phase conversation-end` を使う。Stop の呼出確認は本文を保存しない `~/.priors/stop-hook.jsonl` に匿名イベントとして記録する。
- **自発候補の促し**: UserPromptSubmit は本文を外部送信・保存せず、再開・既存仕様・決定・実装・未解決・作業台帳候補などのローカル兆候を `recall-likely` / `remember-candidate` / `unresolved-candidate` / `work-item-candidate` に分類する。分類はtool呼出や自動保存を決めず、AIが必要性と出所を確認するためのヒントだけを返す。
- **opt-in自動Recall**: `PRIORS_AUTO_RECALL=1`を明示設定した場合、高確度の再開・既存仕様兆候に限り、フックが設定済みPriors MCPへ `initialize → context_open → recall` を実行し、結果を追加文脈として渡す。これは明示opt-in時だけ会話入力をPriorsへ送る。Rememberや候補確定、曖昧なwork選択は自動実行しない。`PRIORS_AUTO_RECALL_LIVE=0` は回帰テスト用のネットワーク無効化である。
- **自律Remember**: 通常は確定事項を自動保存し、曖昧・低確度も`hypothesis`／`working`等の型と低確度・未検証・出所を明記して通常の `context_open → recall → guard → remember/amend` で自動保存する。受信箱は通常経路にしない。Tier Aのプログラム修正記憶は必須で、commit・テスト・配備状態を含める。`PRIORS_AUTO_REMEMBER=0`のときだけ旧候補箱モードへ戻す。
- 継続指示の扱い: 「次進めてください」「続きを実装してください」のような継続指示も `work-item-candidate` として扱い、既存 work の `brief` または work ID の確認を促す。単独の「次」は未解決候補にはしない。
- **旧候補キュー**: `PRIORS_AUTO_REMEMBER=0` のときだけ、`recall-likely` / `remember-candidate` / `unresolved-candidate` の兆候を本文なしの SHA-256・カテゴリ・信頼度メタデータとして `~/.priors/proactive-candidates.jsonl`（`PRIORS_PROACTIVE_CANDIDATE_FILE`で上書き可）へ追記する。Stop時はカテゴリ別件数を表示し、高確度候補がある場合は先に確認するよう促す。既定の自律Rememberモードではこの候補箱を通常経路にしない。
- conversation-end の明示判定後は候補へ `reviewed_at` と判定種別だけを付け、同じ候補を再通知しない。候補本文や入力tokenは追加保存しない。
- Stop時に保留中の `remember-candidate` を本文なしの `priors.remember-candidate.v1` へ一件に集約する。候補ID、元候補ID、入力ハッシュ、信頼度、`confirmation_state=pending`、次の確認手順だけを保存し、自動確定やPriorsへの自動書込は行わない。
- 利用者が候補IDとレビュー済みの完全なRemember payloadを明示した場合だけ `hooks/confirm-remember.js` で確認し、本文をローカル候補へ保存せず、通常の `remember` 呼出し用payloadを返す。候補から本文・namespace・種別を推測せず、未保留候補や不正payloadは拒否する。
  `--candidate-id <候補ID> --payload-file <レビュー済みJSON>` または同じ内容のJSON標準入力を使える。
- `hooks/list-proactive-candidates.js` は保留中のRecall／Remember／作業候補を候補ID・カテゴリ・信頼度・次手だけで一覧化する。入力本文、ハッシュ、Remember payload、tokenは出力しない。
- `hooks/acknowledge-proactive-candidates.js --decision use-read|write-candidate|skip` は明示した判定だけを候補キューへ記録する。`use-read` はRecall候補だけを確認済みにし、Remember・未解決・作業候補を残す。無効な判定は拒否する。
- Stop時の未解決候補は本文なしのcheckpoint候補へ集約される。`hooks/confirm-checkpoint.js --candidate-id <候補ID> --payload-file <レビュー済みJSON>` またはJSON標準入力で、明示したcheckpoint payloadだけを確認済みにできる。
- Stop時に保留中の `work-item-candidate` も本文なしの `priors.work-item-candidate.v1` へ一件に集約する。work IDは推測せず、`brief`（work IDなし）→利用者の明示選択→`work_event`／`verification_recorded`へ進む。
- 利用者が候補IDと実在するwork IDを明示した場合だけ `hooks/confirm-work-item.js --candidate-id <候補ID> --work-id <work ID>` で候補を `confirmed` にできる。これは確認記録だけで、workの自動作成・resolve・DB書込みは行わない。
  同じ `{ "candidate_id": "…", "work_id": "…" }` のJSON標準入力も使える。
- `hooks/select-work-item.js` は `brief` の `work_candidates` と会話目的を受け取り、目的・完了条件・対象環境の語の一致が最も高いworkを決定的に選ぶ。候補が一致しない場合は `create_required=true` を返し、work_createの入力整理へ進める。workのresolveやDB書込みは行わない。
- `hooks/prepare-work-create.js` は一致workが無い場合に、theme・目的・対象環境・完了条件・次の一手・session_id・冪等キーを検査した`work_create` payloadへ整形する。CLIはMCPを直接呼ばず、serverの認可・guard・idempotency検査へ渡す前段だけを担う。
- `hooks/route-work-item.js` はbrief候補と目的を受け、既存workなら`work_event`、一致しなければ検査済み`work_create` payloadへ決定的に分岐する。実行自体はserver MCPへ渡し、CLIはDBを書き込まない。
- 確認済み候補は `hooks/prepare-work-event.js` で event type・expected version・basis・検証環境を検査したpayloadへ変換できる。これはDB呼出しを行わず、serverの`append_work_event`へ同じwork ID・版で渡す前段だけを担う。
- `use-read` は Recall 候補だけを確認済みにし、Remember/未解決候補は残す。`write-candidate` と `skip` はその時点の候補全体を確認済みにする。
- **サーバー側の最後の防波堤**: 書込要求には `session_id` を必須とし、server が同一トランザクション内で `guard` を実行してから `remember` / `amend` / `checkpoint` を実行する。client の `guard` を置き換えるものではない。
- **会話終了時判定**: 既定の自律Rememberモードでは終了前に通常の `context_open → recall → guard → remember/amend` を完了させる。`PRIORS_AUTO_REMEMBER=0` の旧候補モードだけ終了イベントで use-read / write-candidate / skip の判定を促し、未判定のまま終了しない。監査ログには本文を保存しない。
- **日常利用**: 曖昧な再開は `brief` の候補を提示してworkを明示選択する。保持が確かな会話だけdeltaを使い、圧縮後はfullへ戻す。`capture`（保存方針は廃止・すべて確定で登録）と版固定の`maintain`は、通常の`context_open`・`guard`を通す。Tier B は所有者の Claude / Codex が自律管理し、Tier A は人間の明示指示を AI が実行する場合だけ変更する。承認待ち候補は作らず、別主体の記憶への意見は`dispute`か`amends`・`refutes`・`supports`のリンク付きの新しい記憶で追記する。
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
- `work_kinds`: 互換入力。通常の利用では指定しない。Tier B は作業種別を選択しなくても関連度で想起され、必要な場合だけ任意の検索ヒントとして使う。

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
