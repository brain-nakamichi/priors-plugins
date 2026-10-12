#!/usr/bin/env node
/** Claude end-of-turn helper. It records no conversation text and never
 * writes to Priors; any candidate guidance is optional.
 */
'use strict';

const { recordStopInvocation, auditHealth, inputSafetySummary, inputSafetyGuidance } = require('./decision-audit.js');
const {
  summarizeProactiveCandidates,
  materializeRememberCandidate,
  pendingRememberCandidates,
  materializeWorkItemCandidate,
  pendingWorkItemCandidates,
  materializeCheckpointCandidate,
  pendingCheckpointCandidates,
} = require('./proactive-candidates.js');

function candidateGuidance(summary) {
  const steps = [];
  if (summary.categories['recall-likely'] > 0) steps.push('Recall候補は手掛かりとして扱い、過去情報が今回を左右し最新文脈に不足する場合は、必要な読取機能を選んで取得する（固定順序なし）');
  if (summary.categories['remember-candidate'] > 0) steps.push('Remember候補は手掛かりとして扱い、保持基準に合う重要情報は出所を確認して保存する（書込時はguardと認可を満たす）');
  if (summary.categories['unresolved-candidate'] > 0) steps.push('未解決候補は、引継ぎが役立つ場合だけ checkpoint 等で残せる');
  if (summary.categories['work-item-candidate'] > 0) steps.push('作業台帳候補は、継続管理が役立つ場合だけ brief で確認でき、曖昧な候補は自動選択しない');
  return steps.length > 0 ? `候補の兆候: ${steps.join('。')}。候補検出は網羅性の証明ではない。` : '';
}

try {
  const input = (() => {
    try { return JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
  })();
  // Keep only a sanitized invocation counter. Never persist transcript, prompt,
  // token, or the complete hook input.
  try { recordStopInvocation({ stopHookActive: input.stop_hook_active === true }); } catch { /* diagnostics are best effort */ }
  // Claude may invoke Stop again while continuing after a hook. Do not emit
  // another reminder in that re-entrant path.
  const safetyGuidance = inputSafetyGuidance(inputSafetySummary());
  if (input.stop_hook_active === true) process.exit(0);
  const autonomousRemember = process.env.PRIORS_AUTO_REMEMBER !== '0';
  // Generate one session-scoped Remember candidate from the pending local
  // signals.  This stores hashes/provenance only and never auto-confirms it.
  if (!autonomousRemember) {
    try { materializeRememberCandidate(); } catch { /* candidate generation is best effort */ }
    try { materializeWorkItemCandidate(); } catch { /* candidate generation is best effort */ }
    try { materializeCheckpointCandidate(); } catch { /* candidate generation is best effort */ }
  }
  const candidateSummary = summarizeProactiveCandidates();
  const health = auditHealth();
  const rememberReady = pendingRememberCandidates().length;
  const workReady = pendingWorkItemCandidates().length;
  const checkpointReady = pendingCheckpointCandidates().length;
  process.stdout.write(JSON.stringify({
    systemMessage: 'Priors: 保持基準に合う重要情報は明示依頼を待たず認可されたRememberで保存し、Recall条件に合う関連情報は判断前に取得してください。',
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: [
        '会話終了時に、保持基準に合う未保存情報がないか確認する。継続指示・重要決定/制約/却下案・未完了の約束・重大な運用/安全結果・重要な訂正は、明示依頼なしで通常の認可された Remember で保存する。',
        'Recall trigger（再開、過去の決定や制約への依存、誤り再発リスク、履歴質問、引継ぎ/文脈欠落）があり、過去情報が今回を左右して最新文脈に不足する場合は、回答や重要操作の前に必要なものだけ取得する。全ターン検索や固定手順は使わない。',
        '通常の事実・一時的な話題・秘密・保存不許可情報は対象外。未決定や仮説は型・出所・不確実性を保ち、保存成功応答の ID・版を確認する。案内や候補・監査ログは保存/取得の証拠ではない。',
        '記憶は 1 主題 1 件で書く（GEN-711）: 配備報告・レビュー・残件対応のように複数の主題を 1 件にまとめると、どの主題の質問でも本文の要点が薄まり検索で見つからない（例: GEN-629 / GEN-661 型）。主題ごとに記憶を分け、配備や作業の記録は短い 1 件にして relates_to で束ねる。既にある記憶へ主題を足すときも同じ。',
        '検索カード（GEN-727）: remember / capture の各項目 / amend の訂正・置換・異議 / maintain の改訂と outputs には、priors_contract.features に search_card_fields があれば search_summary（問い・主張・条件・結論。例外・否定・重要な数値と名前・実測か推測かの区別を残し、本文にある主張だけ、600 字以内）と keywords（固有名詞・数値・版番号・略称・別名、24 件以内）を添える（カード付きは 1 要求 10 件まで）。応答の search_card.state が pending なら、その記憶は search_card ツールでカードを書くまで本文と題名だけで検索される。claim_not_in_body の任意 error.token（直接の search_card 拒否では details.token）は本文と照合してカードの主張を訂正する手がかり。旧サーバや他理由では token が無くてもよい。検査のため本文へ架空の主張を足さず、token をログ・共有メモへ転記しない。error 付きの pending は記憶は保存済みなので書込を再送せず、search_card（id・expected_version・必須の idempotency_key）で直したカードを書く。invalid_input（field が search_summary / keywords）のときは記憶も保存されていないので、カードを直すか外して同じ鍵で再送してよい。',
        '作業メモの引継ぎ（GEN-768。軽い手がかりで関門ではない）: priors_contract.features に working_notes_v2 があるときだけ、長い・複数ファイルの作業で別セッションや相手クライアント（Codex）に役立つ場合に限り、working_cache_write の sharing（publish）を足してよい（既定は private。共有欄の全項目が安全なときだけ。非公開本文・ローカルパス・URL・diff・秘密は書かない。サーバの危険文字列判定は best-effort の拒否で保証ではないので、秘密を書かないのは自分の規律）。節目の変化だけ update し、毎ターンは書かない。status は自己申告で完了・検証の証明ではない。再開時は features に working_notes_context があれば context_open の working_notes を読み、author_client・更新の新しさ・status_source を確認して、曖昧なら作業を決めつけず利用者に確かめる。メモは実行の許可ではなく、実行前にソース・Git・DB・本番を自分で読み直す。保存や読取の失敗は作業を止めず、引継ぎに響くときだけ報告する。',
        '継続要望（GEN-670）: 本人の今後にも適用する要望を保存する価値があると判断した場合は、remember の refs.continuing_request を使える。既に同じ要望がある・引用や今回限りの依頼なら保存しない。',
        candidateSummary.total > 0
          ? `本文を保存しない自動候補キューが ${candidateSummary.total} 件あります（高確度 ${candidateSummary.high_confidence} 件、Recall候補 ${candidateSummary.categories['recall-likely']} 件、Remember候補 ${candidateSummary.categories['remember-candidate']} 件、未解決候補 ${candidateSummary.categories['unresolved-candidate']} 件、作業台帳候補 ${candidateSummary.categories['work-item-candidate']} 件）。${rememberReady > 0 ? `会話終了Remember候補を ${rememberReady} 件生成しました。` : ''}${workReady > 0 ? `作業台帳候補を ${workReady} 件生成しました。` : ''}${checkpointReady > 0 ? `checkpoint候補を ${checkpointReady} 件生成しました。` : ''}候補は網羅性の証明ではない。保持基準に合う重要情報は候補の有無によらず、出所と不確実性を保って通常手順で保存する。`
          : '自動候補キューは空です。これは記憶が無いことや保存が不要なことの証明ではありません。必要なら通常の機能で確認できます。',
        candidateGuidance(candidateSummary),
        (health.pending_turn_starts > 0 || health.invalid_lines > 0)
          ? `監査ログ診断: 未確定turn-start ${health.pending_turn_starts}件、壊れた行 ${health.invalid_lines}件。警告のみで会話やPriors書込は停止しない。`
          : '',
        '会話本文・token・接続情報は監査ログやPriors本文へ写さない。',
        safetyGuidance,
        '延期・手元作業や認証情報対応は、継続管理が役立つと判断した場合だけ、安全な要旨で既存workを確認し保存できる。否定・引用・完了は区別する。秘密疑いターンはhash無し監査と候補キュー不使用が正常。',
      ].join('\n'),
    },
  }));
} catch {
  // A reminder must never prevent the conversation from closing.
  process.stdout.write(JSON.stringify({
      systemMessage: '保持基準に合う重要情報を明示依頼なしで保存し、Recall条件に合う関連情報は判断前に取得してください。',
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: '会話終了時に保持基準に合う未保存情報がないか確認し、成功応答のIDと版を確かめてください。Recall条件があり過去情報が今回を左右する場合は、必要な範囲を取得してください。',
    },
  }));
}
