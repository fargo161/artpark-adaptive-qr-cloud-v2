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
    const hasCompletion = Object.prototype.hasOwnProperty.call(current, 'completionVideoUrl');
    videos[station] = {
      loopVideoUrl: cleanVideoUrl(
        hasLoop ? current.loopVideoUrl : legacy['1'],
        defaults.videos?.[station]?.loopVideoUrl
      ),
      completionVideoUrl: cleanVideoUrl(
        hasCompletion ? current.completionVideoUrl : undefined,
        defaults.videos?.[station]?.completionVideoUrl
      )
    };
    if (!hasLoop || !hasCompletion || Object.keys(numericSlots).length) needsMigration = true;
  }
  return { videos, deprecatedStageVideos, needsMigration };
}

export function choiceAtIndex(definition, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) return null;
  const choice = definition?.choices?.[value];
  return typeof choice === 'string' && choice ? choice : null;
}
