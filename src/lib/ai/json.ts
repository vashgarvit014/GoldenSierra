import { logger } from '../logger';

/**
 * Tolerant JSON extraction for model responses.
 *
 * `response_format: { type: 'json_object' }` is a request, not a guarantee.
 * Observed in practice (mercury-3, but true of most providers to some degree):
 *
 *   - prose before or after the object  — "Here is the analysis: { … }"
 *   - markdown fences                   — ```json { … } ```
 *   - a required field simply omitted
 *   - trailing commas
 *
 * Treating any of these as total failure throws away a usable response and
 * silently drops the system to its fallback path, which is worse than the
 * malformed output — it looks like the model is working when it is not.
 *
 * So: extract what is there, validate leniently, and let the caller merge
 * partial results over a deterministic baseline.
 */

/** Pulls the first balanced JSON object out of arbitrary model output. */
export function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;

  const text = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  // Fast path: the whole response is already valid JSON.
  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  // Otherwise scan for the first balanced object, respecting string literals
  // so a brace inside a quoted value does not end the scan early.
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        const parsed = tryParse(candidate) ?? tryParse(stripTrailingCommas(candidate));
        return parsed === undefined ? null : parsed;
      }
    }
  }

  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extracts and validates a model response, logging rather than throwing.
 * Returns null when nothing usable came back, so callers fall back explicitly.
 */
export function parseModelJson<T>(
  raw: string | null | undefined,
  validate: (value: unknown) => { success: true; data: T } | { success: false; issues: string[] },
  label: string,
): T | null {
  if (!raw) {
    logger.warn(`${label}: model returned no content`);
    return null;
  }

  const extracted = extractJsonObject(raw);
  if (extracted === null) {
    logger.warn(`${label}: no JSON object found in response`, { preview: raw.slice(0, 160) });
    return null;
  }

  const result = validate(extracted);
  if (!result.success) {
    logger.warn(`${label}: response failed validation`, { issues: result.issues.slice(0, 3) });
    return null;
  }

  return result.data;
}
