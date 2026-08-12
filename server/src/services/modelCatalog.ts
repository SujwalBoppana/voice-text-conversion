/**
 * The list of models a given key can actually use.
 *
 * Asking Google rather than shipping a hardcoded list means the picker shows
 * what the user's project really has — no dead options, and new models appear
 * without a release. The static list is kept only as a fallback for when the
 * listing call fails, so the picker is never empty.
 */
import type { Model } from '@google/genai';
import { getClient } from './geminiClient.js';
import { config } from '../config.js';

export type ModelRole = 'analysis' | 'extraction';

export interface ModelChoice {
  id: string;
  label: string;
  description: string;
  /** Which jobs this model is offered for. */
  roles: ModelRole[];
  /** Short plain-language trade-off, shown under the label. */
  note: string;
  inputTokenLimit?: number;
  /** Ranking hint for the UI: lower is a better default. */
  rank: number;
  recommendedFor?: ModelRole;
}

/** Used when the listing call fails, so the picker still works. */
const FALLBACK: ModelChoice[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: '',
    roles: ['analysis'],
    note: 'Most accurate on scans and dense forms. Slower.',
    rank: 0,
    recommendedFor: 'analysis',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: '',
    roles: ['analysis', 'extraction'],
    note: 'Fast and capable. Good for clean PDFs and for conversation.',
    rank: 1,
    recommendedFor: 'extraction',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: '',
    roles: ['extraction'],
    note: 'Lowest latency. Best for short, plain dictation.',
    rank: 2,
  },
];

/**
 * Models we will not offer, whatever the API returns: they cannot do the job
 * (embeddings, images, speech, video) or are legacy generations that would only
 * make the list harder to read.
 */
const EXCLUDE = /embedding|aqa|imagen|veo|image-generation|tts|native-audio|live-|learnlm|gemini-1\.0|gemini-1\.5|-vision-latest/i;

function noteFor(id: string): string {
  if (/flash-lite/.test(id)) return 'Lowest latency. Best for short, plain dictation.';
  if (/pro/.test(id)) return 'Most accurate on scans and dense forms. Slower.';
  if (/flash/.test(id)) return 'Fast and capable. Good for clean PDFs and for conversation.';
  return 'General purpose.';
}

/**
 * Role suitability.
 *
 * Analysis is a vision task that only larger models do well, so `-lite` tiers
 * are not offered for it. Extraction is shallow text mapping in the critical
 * path, so Pro is not offered for it — it would cost latency for no accuracy.
 */
function rolesFor(id: string): ModelRole[] {
  if (/flash-lite/.test(id)) return ['extraction'];
  if (/pro/.test(id)) return ['analysis'];
  return ['analysis', 'extraction'];
}

function rankFor(id: string): number {
  // Prefer stable generations over previews and dated snapshots.
  let rank = 100;
  if (/gemini-3/.test(id)) rank = 5;
  else if (/gemini-2\.5/.test(id)) rank = 10;
  else if (/gemini-2\.0/.test(id)) rank = 30;
  if (/preview|exp/.test(id)) rank += 15;
  if (/\d{2}-\d{2}$/.test(id)) rank += 5; // dated snapshot
  if (/latest/.test(id)) rank += 2;
  if (/flash-lite/.test(id)) rank += 3;
  else if (/flash/.test(id)) rank += 1;
  return rank;
}

function prettify(id: string, displayName?: string): string {
  if (displayName && !/^models\//.test(displayName)) return displayName;
  return id
    .split('-')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

const cache = new Map<string, { at: number; models: ModelChoice[] }>();
const TTL_MS = 10 * 60 * 1000;

export async function listModels(apiKey: string): Promise<{ models: ModelChoice[]; live: boolean }> {
  if (config.mockGemini || !apiKey) return { models: FALLBACK, live: false };

  const cached = cache.get(apiKey);
  if (cached && Date.now() - cached.at < TTL_MS) return { models: cached.models, live: true };

  try {
    const pager = await getClient(apiKey).models.list({ config: { pageSize: 100, queryBase: true } });

    const raw: Model[] = [];
    for await (const model of pager) raw.push(model);

    const models = raw
      .map((m) => ({ ...m, id: (m.name ?? '').replace(/^models\//, '') }))
      .filter((m) => m.id && !EXCLUDE.test(m.id))
      .filter((m) => {
        // Keep only models that can actually answer a generateContent call.
        const actions = m.supportedActions ?? [];
        return actions.length === 0 || actions.some((a) => /generateContent/i.test(a));
      })
      .map<ModelChoice>((m) => ({
        id: m.id,
        label: prettify(m.id, m.displayName),
        description: m.description ?? '',
        roles: rolesFor(m.id),
        note: noteFor(m.id),
        inputTokenLimit: m.inputTokenLimit,
        rank: rankFor(m.id),
      }))
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));

    if (!models.length) return { models: FALLBACK, live: false };

    // Mark one recommendation per role: the best-ranked model offered for it.
    for (const role of ['analysis', 'extraction'] as ModelRole[]) {
      const best = models.find((m) => m.roles.includes(role));
      if (best) best.recommendedFor = best.recommendedFor ?? role;
    }

    cache.set(apiKey, { at: Date.now(), models });
    return { models, live: true };
  } catch {
    // A listing failure must not block the app; the defaults still work.
    return { models: FALLBACK, live: false };
  }
}
