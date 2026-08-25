import { describe, expect, it, vi, type Mock } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import type { RecipeImprover } from '../services/improve.js';
import { createStore } from '../lib/store.js';
import type { RecipeInput } from '../lib/types.js';

const recipe: RecipeInput = {
  title: 'Garlic Butter Pasta',
  servings: 2,
  ingredients: ['2 tbsp butter', '200g spaghetti'],
  steps: ['Boil pasta', 'Toss in butter'],
  macros: { calories: 500, carbs: 60, protein: 12, fat: 20 },
};

type MockedImprover = {
  suggestSubstitutes: Mock<RecipeImprover['suggestSubstitutes']>;
  makeHealthier: Mock<RecipeImprover['makeHealthier']>;
  adjust: Mock<RecipeImprover['adjust']>;
  reconcileSteps: Mock<RecipeImprover['reconcileSteps']>;
  reconcileStepsBatch: Mock<RecipeImprover['reconcileStepsBatch']>;
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { improver: MockedImprover } {
  const improver: MockedImprover = {
    suggestSubstitutes: vi.fn<RecipeImprover['suggestSubstitutes']>(),
    makeHealthier: vi.fn<RecipeImprover['makeHealthier']>(),
    adjust: vi.fn<RecipeImprover['adjust']>(),
    reconcileSteps: vi.fn<RecipeImprover['reconcileSteps']>(),
    reconcileStepsBatch: vi.fn<RecipeImprover['reconcileStepsBatch']>(),
  };
  return {
    instagramScraper: { scrape: vi.fn(async () => ({ caption: '' })) },
    tiktokScraper: { scrape: vi.fn(async () => ({ caption: '' })) },
    webScraper: { scrape: vi.fn(async () => ({ caption: '' })) },
    parser: { parse: vi.fn() },
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    ...overrides,
    improver,
  };
}

function batchImprove(app: ReturnType<typeof buildApp>, swaps: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/improve',
    payload: {
      mode: 'reconcile-steps-batch',
      recipe,
      swaps,
    },
  });
}

function adjust(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/improve',
    payload: { mode: 'adjust', recipe, ...body },
  });
}

describe('POST /improve — adjust', () => {
  it('dispatches to adjust with a validated target/direction/amount', async () => {
    const deps = makeDeps();
    deps.improver.adjust.mockResolvedValue({
      ingredients: ['1 tsp salt', '200g spaghetti'],
      steps: ['Boil pasta'],
      macros: { calories: 450, carbs: 60, protein: 12, fat: 18 },
      summary: 'Reduced salt',
    });

    const app = buildApp(deps);
    const res = await adjust(app, { target: 'salt', direction: 'less', amount: 'a lot' });

    expect(res.statusCode).toBe(200);
    expect(deps.improver.adjust).toHaveBeenCalledOnce();
    expect(deps.improver.adjust).toHaveBeenCalledWith(recipe, {
      target: 'salt',
      direction: 'less',
      amount: 'a lot',
    });
    await app.close();
  });

  it('defaults amount to "moderately" when omitted', async () => {
    const deps = makeDeps();
    deps.improver.adjust.mockResolvedValue({
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      macros: { calories: 500, carbs: 60, protein: 12, fat: 20 },
      summary: '',
    });

    const app = buildApp(deps);
    const res = await adjust(app, { target: 'spice', direction: 'more' });

    expect(res.statusCode).toBe(200);
    expect(deps.improver.adjust).toHaveBeenCalledWith(recipe, {
      target: 'spice',
      direction: 'more',
      amount: 'moderately',
    });
    await app.close();
  });

  it('returns 422 for a missing target', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await adjust(app, { direction: 'less', amount: 'a little' });

    expect(res.statusCode).toBe(422);
    expect(deps.improver.adjust).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 422 for an invalid direction', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await adjust(app, { target: 'salt', direction: 'sideways' });

    expect(res.statusCode).toBe(422);
    expect(deps.improver.adjust).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /improve — reconcile-steps-batch', () => {
  it('dispatches to reconcileStepsBatch with validated swaps', async () => {
    const deps = makeDeps();
    const expectedSteps = ['Boil pasta', 'Heat the olive oil'];
    deps.improver.reconcileStepsBatch.mockResolvedValue({ steps: expectedSteps });

    const app = buildApp(deps);
    const swaps = [
      { from: '2 tbsp butter', to: '2 tbsp olive oil' },
      { from: 'milk', to: 'oat milk' },
    ];
    const res = await batchImprove(app, swaps);

    expect(res.statusCode).toBe(200);
    expect(deps.improver.reconcileStepsBatch).toHaveBeenCalledOnce();
    expect(deps.improver.reconcileStepsBatch).toHaveBeenCalledWith(recipe, [
      { from: '2 tbsp butter', to: '2 tbsp olive oil' },
      { from: 'milk', to: 'oat milk' },
    ]);
    await app.close();
  });

  it('returns 422 for empty swaps array', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await batchImprove(app, []);

    expect(res.statusCode).toBe(422);
    expect(deps.improver.reconcileStepsBatch).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 422 for malformed swaps', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await batchImprove(app, [{ from: 'a' }]);

    expect(res.statusCode).toBe(422);
    expect(deps.improver.reconcileStepsBatch).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 422 for swaps exceeding cap', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const swaps = Array.from({ length: 11 }, (_, i) => ({
      from: `item-${i}`,
      to: `sub-${i}`,
    }));
    const res = await batchImprove(app, swaps);

    expect(res.statusCode).toBe(422);
    expect(deps.improver.reconcileStepsBatch).not.toHaveBeenCalled();
    await app.close();
  });

  it('charges ceiling once per request', async () => {
    const store = createStore({ upstashUrl: '', upstashToken: '' });
    const incrSpy = vi.spyOn(store, 'incrWithTtl');
    const deps = makeDeps({ store });
    deps.improver.reconcileStepsBatch.mockResolvedValue({ steps: recipe.steps });

    const app = buildApp(deps);
    const swaps = [{ from: '2 tbsp butter', to: '2 tbsp olive oil' }];
    await batchImprove(app, swaps);

    // The onRequest guard's per-IP rate limit also increments the shared store,
    // so filter down to the daily improve ceiling: it must be charged exactly
    // once per request, never once per swap.
    const ceilingCalls = incrSpy.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('g:day:improve:'),
    );
    expect(ceilingCalls).toHaveLength(1);
    await app.close();
  });
});
