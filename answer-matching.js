const APOSTROPHES = /['\u2018\u2019\u02bc]/g;

export function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

function canonicalTokens(value) {
  const normalized = normalizeAnswer(value);
  return normalized ? normalized.split(' ').map(canonicalToken) : [];
}

export function answerMatches(response, acceptedPhrases) {
  const responseTokens = canonicalTokens(response);
  if (!responseTokens.length || !Array.isArray(acceptedPhrases)) return false;

  return acceptedPhrases.some(phrase => {
    const phraseTokens = canonicalTokens(phrase);
    if (!phraseTokens.length || phraseTokens.length > responseTokens.length) return false;
    for (let offset = 0; offset <= responseTokens.length - phraseTokens.length; offset += 1) {
      if (phraseTokens.every((token, index) => token === responseTokens[offset + index])) return true;
    }
    return false;
  });
}

export function sanitizeAnswerDefinition(value, fallback = {}) {
  const prompt = String(value?.prompt ?? fallback.prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const rawPhrases = Array.isArray(value?.acceptedPhrases) ? value.acceptedPhrases : fallback.acceptedPhrases;
  const acceptedPhrases = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawPhrases) ? rawPhrases : []) {
    const phrase = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const normalized = normalizeAnswer(phrase);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    acceptedPhrases.push(phrase);
    if (acceptedPhrases.length >= 50) break;
  }
  return { prompt, acceptedPhrases };
}
