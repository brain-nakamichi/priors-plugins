'use strict';

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_CANDIDATE_CHARS = 2048;
const CODE_ORDER = ['connection_password', 'credential_prefix', 'authorization_value', 'jwt_shape', 'credential_assignment'];

function uninspectable() {
  return { state: 'uninspectable', codes: [], suppress_auto_recall: true };
}

function placeholder(value) {
  return /^(?:<(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)>|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|([*xX•])\1{2,}|\[REDACTED\]|REDACTED|YOUR_(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_TOKEN))$/i.test(value);
}

// Value scanning has a hard bound. Never return a value from the public API.
function valueAt(text, offset) {
  while (offset < text.length && /[ \t]/.test(text[offset])) offset++;
  const quote = text[offset] === '"' || text[offset] === "'" ? text[offset++] : null;
  const start = offset;
  while (offset < text.length && offset - start <= MAX_CANDIDATE_CHARS) {
    const char = text[offset];
    if (quote ? char === quote || char === '\n' : /[\s,;"']/.test(char)) break;
    offset++;
  }
  return { value: text.slice(start, offset), oversized: offset - start > MAX_CANDIDATE_CHARS };
}

function scan(text, found) {
  for (const match of text.matchAll(/\b(?:(?:pv1[hias]|sbp_|sk-ant-|sk-proj-|sk-svcacct-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,2049}|sk-[A-Za-z0-9_-]{20,2049})/g)) {
    if (!placeholder(match[0])) found.add('credential_prefix');
  }
  for (const match of text.matchAll(/\b(?:authorization\b["']?[ \t]*[:=][ \t]*(?:["']?Bearer[ \t]+)?|Bearer[ \t]+)/gi)) {
    const candidate = valueAt(text, match.index + match[0].length);
    if (candidate.oversized || candidate.value && !placeholder(candidate.value)) found.add('authorization_value');
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_-]{16,2049}\.[A-Za-z0-9_-]{8,2049}\.[A-Za-z0-9_-]{8,2049}/g)) {
    if (match[0]) found.add('jwt_shape');
  }
  for (const match of text.matchAll(/\b(?:(?:[A-Z0-9]{1,64}_){0,8}(?:token|password|secret|api_key|access_token)(?:_[A-Z0-9]{1,64}){0,8}|PGPASSWORD)["']?[ \t]*[:=]/gi)) {
    const candidate = valueAt(text, match.index + match[0].length);
    if (candidate.oversized || candidate.value && !placeholder(candidate.value)) found.add('credential_assignment');
  }
  for (const match of text.matchAll(/\b(?:postgres(?:ql)?|mysql):\/\//gi)) {
    const start = match.index + match[0].length;
    let end = start;
    while (end < text.length && end - start <= MAX_CANDIDATE_CHARS && !/[\s/"']/.test(text[end])) end++;
    const info = text.slice(start, end);
    const at = info.indexOf('@');
    const colon = info.indexOf(':');
    if (end - start > MAX_CANDIDATE_CHARS || at > colon && colon >= 0 && at > colon + 1 && !placeholder(info.slice(colon + 1, at))) {
      found.add('connection_password');
    }
  }
}

function hasDisclosureReport(prompt) {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return false;
  // A report must describe the speaker's own completed event. Quoted examples,
  // third-party reports, and hypothetical scenarios are not incident reports.
  const unquoted = prompt
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/(?:「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|'[^'\n]*')/gu, ' ')
    .replace(/^\s*>[^\n]*$/gmu, ' ');
  const self = '(?:私|わたし|わたくし|自分|僕|ぼく|俺|おれ|I)';
  const credential = '(?:トークン|キー|パスワード|認証情報|秘密情報|API[ _-]?(?:key|キー)|token|password|credential|secret)';
  const exposure = '(?:貼ってしま(?:い)?ました|貼ってしまった|貼りました|貼った|送ってしま(?:い)?ました|送ってしまった|送信してしま(?:い)?ました|送信してしまった|共有してしま(?:い)?ました|共有してしまった|公開してしま(?:い)?ました|公開してしまった|漏えい(?:し)?ました|漏えいした|漏洩(?:し)?ました|漏洩した|漏れました|漏れた|流出しました|流出した|誤って入力しました|入力してしま(?:い)?ました|入力してしまった|コミットしてしま(?:い)?ました|コミットしてしまった|commit(?:ted)?|pasted|posted|shared|sent|leaked|exposed|committed|entered)';
  const uncertain = /(?:可能性|かもしれ|かも|おそらく|たぶん|疑い|かは不明|かどうか不明|不明|と思う|と思います|\b(?:I think|I believe|maybe|possibly|might|may|could)\b)/iu;
  const negatedExposure = /(?:わけではない|ことはない|していない|していません|してなかった|ません(?:でした)?|なかった|\b(?:not|never|no|didn't|did not|haven't|have not|hasn't|has not)\b)/iu;
  const hypothetical = /(?:もし|もしも|仮に|仮定|たら|れば|場合|としたら|\bif\b|\bwould\b|\bcould\b|\bmight\b)/iu;
  const thirdPartyAttribution = /(?:\b[A-Z][A-Za-z0-9_-]*\s+(?:said|reported|wrote|claimed|mentioned|told\s+me)\b|\b[A-Z][A-Za-z0-9_-]*によると|(?:別の利用者|他の利用者|第三者|Claude|Codex|[A-Z][A-Za-z0-9_-]*)(?:さん)?\s*(?:が|は)[^。！？!?]{0,160}(?:と報告|と述べ|と言った|と書いた))/iu;
  const credentialPattern = new RegExp(credential, 'iu');
  const exposurePattern = new RegExp(exposure, 'iu');
  const jpEvent = `(?:${credential}[^。！？!?、，,;；]{0,16}${exposure}|${exposure}[^。！？!?、，,;；]{0,16}${credential})`;
  const jpActor = new RegExp(`${self}(?:自身)?\\s*(?:が|は)\\s*(?:(?:昨日|先ほど|さきほど|さっき|今朝|先日|誤って|間違えて|うっかり)\\s*){0,2}${jpEvent}`, 'iu');
  const jpPossessive = new RegExp(`${self}(?:自身)?\\s*の\\s*${credential}\\s*(?:を|が)[^。！？!?、，,;；]{0,16}${exposure}`, 'iu');
  const englishActor = new RegExp(`\\bI\\s+(?:(?:accidentally|mistakenly)\\s+)?${exposure}\\b[^。！？!?]{0,80}${credential}`, 'iu');
  const englishAuxiliaryActor = new RegExp(`\\bI\\s+(?:(?:have|has)\\s+)?(?:(?:just|accidentally|mistakenly)\\s+)*${exposure}\\b[^。！？!?]{0,80}${credential}`, 'iu');
  const englishPossessive = new RegExp(`\\bmy\\s+${credential}[^。！？!?]{0,80}${exposure}\\b`, 'iu');
  const utterances = unquoted.split(/[\n。！？!?]+/u);
  return utterances.some((utterance) => {
    if (uncertain.test(utterance) || thirdPartyAttribution.test(utterance)) return false;
    const clauses = utterance.split(/(?:\b(?:and|but|so)\b|ので|から)/iu);
    return clauses.some((clause) => {
      if (hypothetical.test(clause) || negatedExposure.test(clause) && exposurePattern.test(clause)) return false;
      if (!credentialPattern.test(clause) || !exposurePattern.test(clause)) return false;
      // Japanese first-person subject/possessive must be grammatically attached
      // to the event or credential. English requires an explicit "I" subject.
      return jpActor.test(clause) || jpPossessive.test(clause) || englishActor.test(clause) || englishAuxiliaryActor.test(clause) || englishPossessive.test(clause);
    });
  });
}

function inspectSensitiveInput(prompt) {
  try {
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return uninspectable();
    const normalized = prompt.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\r\n?/g, '\n');
    const found = new Set();
    scan(normalized, found);
    // Only one ASCII unicode/slash unescape pass. No recursive or base64 decoding.
    const escaped = normalized.replace(/\\u00([0-9a-f]{2})|\\\//gi, (whole, hex) => hex ? String.fromCharCode(parseInt(hex, 16)) : '/');
    if (escaped !== normalized) scan(escaped, found);
    const codes = CODE_ORDER.filter((code) => found.has(code)).slice(0, 4);
    return { state: codes.length ? 'suspected' : 'clear', codes, suppress_auto_recall: codes.length > 0 };
  } catch { return uninspectable(); }
}

function sensitiveGuidance(state) {
  if (state === 'reported') return 'Priors: 認証情報の露出申告がありました。値の検出がない申告だけでは自動検索を抑止しません。本人の事象か引用かを確認し、値を含まない要旨で既存workを再利用するかguard後に保存してください。不要理由を確認した対象はその根拠を残し、検出や申告だけで侵害・失効・完了を断定しないでください。';
  return state === 'suspected'
    ? 'Priors: 認証情報らしい値、または露出の申告を検出しました。入力本文の自動検索送信を止め、本文由来のhashと候補は保存しません。有効性と対応対象を確認し、値を含まない要旨で既存workを確認してください。同じ事象は再利用し、未保存ならguard後に作業を残してください。引用・ダミーかは別途判断し、検出だけで漏えい・失効・完了を断定しないでください。'
    : 'Priors: 入力を安全に検査できないため、入力本文の自動検索送信を止め、本文由来のhashと候補は保存しません。会話は続けられます。必要なら値を含まない要旨で既存workを確認してください。';
}

module.exports = { inspectSensitiveInput, hasDisclosureReport, sensitiveGuidance, MAX_PROMPT_BYTES, MAX_CANDIDATE_CHARS };
