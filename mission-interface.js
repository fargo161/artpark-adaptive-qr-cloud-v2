import { sanitizeAnswerDefinition } from './answer-matching.js';

export const FINAL_PHRASE = 'DECISIONS ARE PORTALS. PORTALS ARE DECISIONS.';

function cleanCopy(value, fallback, maxLength = 240) {
  return String(value ?? fallback ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

export function sanitizeStationChoiceDefinition(value, fallback = {}) {
  const prompt = cleanCopy(value?.prompt, fallback.prompt);
  const supplied = Array.isArray(value?.choices) ? value.choices : fallback.choices;
  const choices = (Array.isArray(supplied) ? supplied : [])
    .slice(0, 4)
    .map((choice, index) => cleanCopy(choice, fallback.choices?.[index], 120));
  if (choices.length !== 4 || choices.some(choice => !choice)) {
    return {
      prompt,
      choices: (fallback.choices || []).slice(0, 4).map(choice => cleanCopy(choice, '', 120))
    };
  }
  return { prompt, choices };
}

export function sanitizeFinalReflection(value, fallback = {}) {
  const answerDefinition = sanitizeAnswerDefinition(value, fallback);
  return {
    ...answerDefinition,
    retryMessage: cleanCopy(value?.retryMessage, fallback.retryMessage),
    acceptedMessage: cleanCopy(value?.acceptedMessage, fallback.acceptedMessage)
  };
}

export function choiceAtIndex(definition, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) return null;
  const choice = definition?.choices?.[value];
  return typeof choice === 'string' && choice ? choice : null;
}
