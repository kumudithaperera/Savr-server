/**
 * Validation utilities for recipe extraction responses.
 *
 * Used at two points in the extraction pipeline:
 * 1. After LLM parsing — validate that a `ParsedRecipe` is structurally sound
 *    before it enters normalization.
 * 2. Before caching/returning — validate that an `ExtractedRecipe` is complete
 *    enough to cache and serve to all clients.
 *
 * Unlike `normalize.ts` (which coerces bad values into defaults), validation
 * rejects malformed data outright with structured error reports, so the caller
 * can decide how to handle it (retry, fall back to a different LLM level, or
 * surface the reason to the user).
 */

import {
  CATEGORIES,
  type ExtractedRecipe,
  type Macros,
  type ParsedRecipe,
} from './types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** Dot-delimited path to the invalid field (e.g. `macros.calories`). */
  path: string;
  /** Human-readable description of what's wrong. */
  message: string;
  /** The actual value at `path`, if available. */
  value?: unknown;
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  );
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

const MACRO_FIELDS = ['calories', 'carbs', 'protein', 'fat'] as const;

export function validateMacros(value: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object', value });
    return errors;
  }

  for (const field of MACRO_FIELDS) {
    const fieldPath = `${path}.${field}`;
    const v = value[field];
    if (!isFiniteNumber(v)) {
      errors.push({ path: fieldPath, message: 'must be a finite number', value: v });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// ParsedRecipe (LLM output)
// ---------------------------------------------------------------------------

/**
 * Validates an unknown value as a `ParsedRecipe`.
 *
 * Checks structural requirements (types, required fields, enum membership)
 * without applying defaults. Use this immediately after parsing the LLM's
 * JSON response so a malformed reply is caught before any downstream work.
 */
export function validateParsedRecipe(value: unknown): ValidationResult<ParsedRecipe> {
  const errors: ValidationError[] = [];

  if (!isRecord(value)) {
    return { success: false, errors: [{ path: '', message: 'must be an object', value }] };
  }

  // isRecipe (optional, but must be boolean when present)
  if ('isRecipe' in value && typeof value.isRecipe !== 'boolean') {
    errors.push({ path: 'isRecipe', message: 'must be a boolean', value: value.isRecipe });
  }

  // title (required; may be empty when the parser verdicts `isRecipe: false`,
  // since both LLM prompts tell the model to leave title empty in that case)
  if (typeof value.title !== 'string') {
    errors.push({ path: 'title', message: 'must be a string', value: value.title });
  } else if (value.isRecipe !== false && value.title.trim().length === 0) {
    errors.push({ path: 'title', message: 'must be a non-empty string', value: value.title });
  }

  // servings (optional, must be a positive integer when present)
  if ('servings' in value && value.servings !== undefined && value.servings !== null) {
    const s = value.servings;
    if (!isFiniteNumber(s) || s < 1 || !Number.isInteger(s)) {
      errors.push({ path: 'servings', message: 'must be a positive integer', value: s });
    }
  }

  // ingredients (required, must be array of strings)
  if (!isStringArray(value.ingredients)) {
    errors.push({ path: 'ingredients', message: 'must be an array of strings', value: value.ingredients });
  }

  // steps (required, must be array of strings)
  if (!isStringArray(value.steps)) {
    errors.push({ path: 'steps', message: 'must be an array of strings', value: value.steps });
  }

  // macros (required)
  if (!('macros' in value)) {
    errors.push({ path: 'macros', message: 'is required' });
  } else {
    errors.push(...validateMacros(value.macros, 'macros'));
  }

  // macrosStatedInCaption (required)
  if (typeof value.macrosStatedInCaption !== 'boolean') {
    errors.push({ path: 'macrosStatedInCaption', message: 'must be a boolean', value: value.macrosStatedInCaption });
  }

  // suggestedCategory (required, must be valid enum)
  if (!CATEGORIES.includes(value.suggestedCategory as never)) {
    errors.push({
      path: 'suggestedCategory',
      message: `must be one of ${CATEGORIES.join(', ')}`,
      value: value.suggestedCategory,
    });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data: value as unknown as ParsedRecipe };
}

// ---------------------------------------------------------------------------
// ExtractedRecipe (cached / wire output)
// ---------------------------------------------------------------------------

const SOURCE_PLATFORMS = ['instagram', 'tiktok', 'web'] as const;
const MACRO_SOURCES = ['caption', 'estimated'] as const;

/**
 * Validates an unknown value as an `ExtractedRecipe`.
 *
 * This is stricter than `validateParsedRecipe` because every field is either
 * required or has been resolved by normalization. Use this before caching
 * the output or returning it to the client.
 */
export function validateExtractedRecipe(value: unknown): ValidationResult<ExtractedRecipe> {
  const errors: ValidationError[] = [];

  if (!isRecord(value)) {
    return { success: false, errors: [{ path: '', message: 'must be an object', value }] };
  }

  // sourceUrl (required)
  if (!isNonEmptyString(value.sourceUrl)) {
    errors.push({ path: 'sourceUrl', message: 'must be a non-empty string', value: value.sourceUrl });
  }

  // sourcePlatform (required, must be valid enum)
  if (!SOURCE_PLATFORMS.includes(value.sourcePlatform as never)) {
    errors.push({
      path: 'sourcePlatform',
      message: `must be one of ${SOURCE_PLATFORMS.join(', ')}`,
      value: value.sourcePlatform,
    });
  }

  // title (required)
  if (!isNonEmptyString(value.title)) {
    errors.push({ path: 'title', message: 'must be a non-empty string', value: value.title });
  }

  // imageRemoteUrl (optional, must be string when present)
  if ('imageRemoteUrl' in value && value.imageRemoteUrl !== undefined && value.imageRemoteUrl !== null) {
    if (typeof value.imageRemoteUrl !== 'string') {
      errors.push({ path: 'imageRemoteUrl', message: 'must be a string', value: value.imageRemoteUrl });
    }
  }

  // category (required, must be valid enum)
  if (!CATEGORIES.includes(value.category as never)) {
    errors.push({
      path: 'category',
      message: `must be one of ${CATEGORIES.join(', ')}`,
      value: value.category,
    });
  }

  // servings (optional, must be positive integer when present)
  if ('servings' in value && value.servings !== undefined && value.servings !== null) {
    const s = value.servings;
    if (!isFiniteNumber(s) || s < 1 || !Number.isInteger(s)) {
      errors.push({ path: 'servings', message: 'must be a positive integer', value: s });
    }
  }

  // ingredients (required, must be array of strings)
  if (!Array.isArray(value.ingredients)) {
    errors.push({ path: 'ingredients', message: 'must be an array', value: value.ingredients });
  } else {
    for (let i = 0; i < value.ingredients.length; i++) {
      if (typeof value.ingredients[i] !== 'string') {
        errors.push({ path: `ingredients[${i}]`, message: 'must be a string', value: value.ingredients[i] });
      }
    }
  }

  // steps (required, must be array of strings)
  if (!Array.isArray(value.steps)) {
    errors.push({ path: 'steps', message: 'must be an array', value: value.steps });
  } else {
    for (let i = 0; i < value.steps.length; i++) {
      if (typeof value.steps[i] !== 'string') {
        errors.push({ path: `steps[${i}]`, message: 'must be a string', value: value.steps[i] });
      }
    }
  }

  // macros (required)
  if (!('macros' in value)) {
    errors.push({ path: 'macros', message: 'is required' });
  } else {
    errors.push(...validateMacros(value.macros, 'macros'));
  }

  // macrosSource (required, must be valid enum)
  if (!MACRO_SOURCES.includes(value.macrosSource as never)) {
    errors.push({
      path: 'macrosSource',
      message: `must be one of ${MACRO_SOURCES.join(', ')}`,
      value: value.macrosSource,
    });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data: value as unknown as ExtractedRecipe };
}