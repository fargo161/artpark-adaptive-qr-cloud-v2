import { sanitizeAnswerDefinition } from './answer-matching.js';

export const FINAL_PHRASE = 'DECISIONS ARE PORTALS. PORTALS ARE DECISIONS.';

function cleanCopy(value, fallback, maxLength = 240) {
  return String(value ?? fallback ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanVideoUrl(value, fallback = '') {
  return String(value ?? fallback ?? '').trim().slice(0, 2000);
}

export function sanitizeStationChoiceDefinition(value, fallback = {}) {
  const prompt = cleanCopy(value?.prompt, fallback.prompt);
  const supplied = Array.isArray(value?.choices) ? value.choices : fallback.choices;
  const fallbackChoices = (fallback.choices || []).slice(0, 4).map(choice => cleanCopy(choice, '', 120));
  const choices = (Array.isArray(supplied) ? supplied : [])
    .slice(0, 4)
    .map((choice, index) => cleanCopy(choice, fallbackChoices[index], 120));
  const finalChoices = choices.length === 4 && choices.every(Boolean) ? choices : fallbackChoices;
  const suppliedCorrect = Number(value?.correctChoiceIndex);
  const fallbackCorrect = Number(fallback.correctChoiceIndex);
  const correctChoiceIndex = Number.isInteger(suppliedCorrect) && suppliedCorrect >= 0 && suppliedCorrect <= 3
    ? suppliedCorrect
    : Number.isInteger(fallbackCorrect) && fallbackCorrect >= 0 && fallbackCorrect <= 3
      ? fallbackCorrect
      : 0;
  return { prompt, choices: finalChoices, correctChoiceIndex };
}

export function sanitizeFinalReflection(value, fallback = {}) {
  const answerDefinition = sanitizeAnswerDefinition(value, fallback);
  return {
    ...answerDefinition,
    retryMessage: cleanCopy(value?.retryMessage, fallback.retryMessage),
    acceptedMessage: cleanCopy(value?.acceptedMessage, fallback.acceptedMessage),
    videos: {
      loopVideoUrl: cleanVideoUrl(value?.videos?.loopVideoUrl, fallback.videos?.loopVideoUrl),
      wrongVideoUrl: cleanVideoUrl(value?.videos?.wrongVideoUrl, fallback.videos?.wrongVideoUrl),
      correctVideoUrl: cleanVideoUrl(value?.videos?.correctVideoUrl, fallback.videos?.correctVideoUrl)
    }
  };
}

export function migrateVideoConfiguration(value = {}, defaults = {}) {
  const videos = {};
  const deprecatedStageVideos = {};
  let needsMigration = false;
  for (const station of ['escape', 'attention', 'access', 'sensory']) {
    const current = value.videos?.[station] || {};
    const numericSlots = Object.fromEntries(
      Object.entries(current).filter(([key]) => ['1', '2', '3', '4'].includes(key))
    );
    const legacy = { ...numericSlots, ...(value.deprecatedStageVideos?.[station] || {}) };
    if (Object.keys(legacy).length) deprecatedStageVideos[station] = legacy;
    const hasLoop = Object.prototype.hasOwnProperty.call(current, 'loopVideoUrl');
    const hasWrong = Object.prototype.hasOwnProperty.call(current, 'wrongVideoUrl');
    const hasCompletion = Object.prototype.hasOwnProperty.call(current, 'completionVideoUrl');
    videos[station] = {
      loopVideoUrl: cleanVideoUrl(
        hasLoop ? current.loopVideoUrl : legacy['1'],
        defaults.videos?.[station]?.loopVideoUrl
      ),
      wrongVideoUrl: cleanVideoUrl(
        hasWrong ? current.wrongVideoUrl : undefined,
        defaults.videos?.[station]?.wrongVideoUrl
      ),
      completionVideoUrl: cleanVideoUrl(
        hasCompletion ? current.completionVideoUrl : undefined,
        defaults.videos?.[station]?.completionVideoUrl
      )
    };
    if (!hasLoop || !hasWrong || !hasCompletion || Object.keys(numericSlots).length) needsMigration = true;
  }
  return { videos, deprecatedStageVideos, needsMigration };
}

export function choiceAtIndex(definition, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) return null;
  const choice = definition?.choices?.[value];
  return typeof choice === 'string' && choice ? choice : null;
}
