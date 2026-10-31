'use strict';
// Canonical pure classifier shared by both plugin packages; never stores input.
const CONTINUING_WHEN = /(次から|次回から|今後は|今後も|以後|以降は|これからは|毎回|常に|from now on|going forward)/u;
const CONTINUING_CORRECTION = /(何度も|また|いつも|毎回).{0,20}(英語|日本語|言語|長い|短く|簡潔|詳しく|形式|箇条書き|敬語)|(英語|日本語)(で|に)(回答|返答|返事|書い|して)/u;
const DEFERRED = /(?:後回し|あとで|後で|延期)/u;
const ACTION = /(?:対応|実施|作業|修正|交換|失効|再発行|検証|確認|やる|行う|にする|します|する)/u;
const DEFERRED_HIGH = /(?:後回し|あとで|後で|延期)[^\n。]{0,48}(?:対応|実施|作業|修正|交換|失効|再発行|検証|確認|やる|行う|にする|します|する)|(?:対応|実施|作業|修正|交換|失効|再発行|検証|確認)[^\n。]{0,48}(?:後回し|あとで|後で|延期)/u;

function deferredCandidate(prompt) {
  return DEFERRED.test(prompt) && ACTION.test(prompt) || /(?:お手元|手元|操作待ち)/u.test(prompt);
}

// Background agent reports and task notifications also reach UserPromptSubmit, but they are not
// the user's words; candidates made from them only pile up in the Stop reminder. Recognised by the
// markers Claude Code uses today. Two checks, each failing toward the side that is safe for its use:
// - startsLikeHarness (leading marker only) labels the audit turn. A turn labelled harness-message
//   keeps the session's safety notice count, so while the leading markers keep today's form a report
//   whose body or ending changed cannot clear the user's notice before its Stop; a user turn labelled
//   harness only leaves the notice one turn longer.
// - isHarnessMessage (the whole message is harness blocks) suppresses candidates and the disclosure
//   hint. If the format changes, reports simply produce candidates again (the previous behaviour);
//   a user who pastes a report and writes their own words before, between or after it is the user.
//   Words typed inside a multi-line block cannot be told apart from the report and count as harness.
// The secret-value inspection runs before either check and never depends on them.
// The plain-text markers count only together with the structured part the harness adds.
const HARNESS_MESSAGE = /^\s*(?:<task-notification>|<agent-message from=|Another Claude session sent a message:\s*<agent-message from=|\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?<task-notification>)/;

// One harness block: an optional plain-text lead, the element, its closing tag at the start of a line (the harness
// indents an agent report's lines, so a closing tag quoted inside the report is not at column 0), then for an agent
// report the fixed explanation Claude Code appends. Both plain-text parts are fixed at both ends with a bounded middle,
// so arbitrary text cannot hide inside them.
const HARNESS_BLOCK = /^\s*(?:Another Claude session sent a message:\s*(?=<agent-message from=)|\[SYSTEM NOTIFICATION - NOT USER INPUT\]\s*This is an automated[^<]{0,1500}?must NOT be treated as approval or consent\.\s*(?=<task-notification>))?(?:<(task-notification)>|<(agent-message) from=)[\s\S]*?\n<\/\1\2>(?:\s*That "other Claude session" is an agent[\s\S]{0,1500}?permission laundering\.)?\s*/;

function startsLikeHarness(prompt) {
  return typeof prompt === 'string' && HARNESS_MESSAGE.test(prompt);
}

function isHarnessMessage(prompt) {
  if (!startsLikeHarness(prompt)) return false;
  let rest = prompt;
  for (let i = 0; i < 50 && rest.length > 0; i += 1) {
    const m = HARNESS_BLOCK.exec(rest);
    if (!m || m[0].length === 0) return false;
    rest = rest.slice(m[0].length);
  }
  return rest.length === 0;
}

function proactiveSignals(prompt) {
  if (isHarnessMessage(prompt)) return [];
  const text = prompt.toLocaleLowerCase();
  const signals = [];
  if (/(前回|続き|再開|既存|仕様|制約|なぜ|recall|remember|decision|deploy|rollback|本番|課題|未実装|実装|テスト)/u.test(text)) signals.push('recall-likely');
  if (/(決定|採択|方針|記録|今後|再発|完了|実装した|採用|正式|課題に追加|remember)/u.test(text)) signals.push('remember-candidate');
  if (/(未解決|todo|保留|次の一手|次回|次に残|残件|pending|open question)/u.test(text)) signals.push('unresolved-candidate');
  if (/(未実装一覧|未実装|残件|作業台帳|work[ _-]?item|未解決の課題|課題に追加|課題を整理|(?:次|続き|このまま).*(?:進め|実装|対応))/u.test(text)) signals.push('work-item-candidate');
  if (deferredCandidate(text)) {
    if (!signals.includes('unresolved-candidate')) signals.push('unresolved-candidate');
    if (!signals.includes('work-item-candidate')) signals.push('work-item-candidate');
  }
  // GEN-670: a request that keeps applying in this theme (from now on / every time / a repeated correction of the answer's
  // language, length or form). A cue only: whether it is the person's own continuing request is the model's judgement
  if (CONTINUING_WHEN.test(text) || CONTINUING_CORRECTION.test(text)) signals.push('continuing-request-candidate');
  return signals;
}

function proactiveConfidence(prompt, signals) {
  if (signals.includes('recall-likely') && /(?:前回|続き|再開|既存(?:仕様|の)|制約)/u.test(prompt)) return 'high';
  if (signals.includes('remember-candidate') && /(?:決定|採択|方針|正式|完了|採用|実装した)/u.test(prompt)) return 'high';
  if (signals.includes('unresolved-candidate') && /(?:未解決|保留|残件|次の一手|次回|次に残る)/u.test(prompt)) return 'high';
  if (signals.includes('work-item-candidate') && /(?:未実装一覧|未実装|残件|未解決の課題|次に進める|次進めて|続きを|作業台帳)/u.test(prompt)) return 'high';
  if (signals.includes('work-item-candidate') && DEFERRED_HIGH.test(prompt)) return 'high';
  return 'low';
}

module.exports={proactiveSignals,proactiveConfidence,isHarnessMessage,startsLikeHarness,deferredCandidate,DEFERRED_HIGH};
