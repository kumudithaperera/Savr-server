import { describe, expect, it } from 'vitest';

import { brandTokens } from './brand.js';

describe('brandTokens', () => {
  it('stays empty for generic single-word ingredients', () => {
    expect(brandTokens('flour')).toEqual([]);
    expect(brandTokens('salt')).toEqual([]);
    expect(brandTokens('eggs')).toEqual([]);
  });

  it('stays empty for common capitalized food nouns', () => {
    expect(brandTokens('Chicken Breast')).toEqual([]);
    expect(brandTokens('Chicken breast')).toEqual([]);
    expect(brandTokens('Italian Sausages')).toEqual([]);
    expect(brandTokens('Roma Tomatoes')).toEqual([]);
  });

  it('detects a capitalized brand token before the food', () => {
    expect(brandTokens('Barilla spaghetti')).toEqual(['barilla']);
    expect(brandTokens('Heinz baked beans')).toEqual(['heinz']);
    expect(brandTokens('Kraft Macaroni and Cheese')).toEqual(['kraft']);
  });

  it('detects possessive-style brand names regardless of case', () => {
    expect(brandTokens("Kellogg's cornflakes")).toEqual(['kellogg']);
    expect(brandTokens("HEINZ's ketchup")).toEqual(['heinz']);
  });

  it('never treats a generic food as a brand, even in ALL CAPS', () => {
    expect(brandTokens('KETCHUP')).toEqual([]);
    expect(brandTokens('Chicken, 3 cups')).toEqual([]);
  });

  it('does not treat a brandless capitalized preposition as a brand', () => {
    expect(brandTokens('5 Spice')).toEqual([]);
  });

  it('collapses slashes and whitespace before scanning', () => {
    expect(brandTokens('Barilla/other spaghetti   mix')).toEqual(['barilla']);
  });
});