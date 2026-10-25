import { describe, expect, it } from 'vitest';

import { normaliseWords, ruleCheck } from './rule-moderation.js';

const post = (text: string) => ruleCheck(text, 'post');
const comment = (text: string) => ruleCheck(text, 'comment');

describe('normaliseWords', () => {
  it('undoes the usual dodges', () => {
    expect(normaliseWords('F.U.C.K')).toEqual(['fuck']);
    expect(normaliseWords('f u c k you')).toEqual(['fuck', 'you']);
    expect(normaliseWords('1d10t')).toEqual(['idiot']);
    expect(normaliseWords("You're IDIÖT")).toEqual(['youre', 'idiot']);
  });

  it('treats edge punctuation as punctuation, not leetspeak', () => {
    expect(normaliseWords('Great idea!')).toEqual(['great', 'idea']);
    expect(normaliseWords('(really?)')).toEqual(['really']);
  });
});

describe('ruleCheck', () => {
  it.each([
    'Add a dark mode',
    'Group the grocery list by aisle',
    'The import is broken and useless, please fix it',
    'This feature is stupid, it keeps losing my recipes',
    'Damn, the timer is so slow',
    'Chicken breast and meatballs should get their own category',
    'Rapeseed oil should count as a pantry staple',
    'Support recipes from Scunthorpe bakeries',
    'Add a property filter for cooking time',
    'I would kill for a meal planner',
    'You might hurt yourself with the knife, add a safety tip',
    'Can the app find you a recipe from what is in the fridge?',
    'Share to WhatsApp and Telegram',
    'Añadir modo oscuro, por favor',
    'Soooo good, love it',
    '料理の写真を大きくしてください',
    'HTML export for recipes',
  ])('allows %j', (text) => {
    expect(post(text)).toEqual({ action: 'allow' });
  });

  it.each([
    ['You are a total idiot', 'harassment'],
    ['the dev is such a moron', 'harassment'],
    ['idiot dev, fix your app', 'harassment'],
    ['Fuck you', 'harassment'],
    ['f u c k o f f', 'harassment'],
    ['eres un idiota', 'harassment'],
    ['vete a la mierda', 'harassment'],
    ['I will kill you', 'violence'],
    ['kys', 'self_harm'],
    ['go kill yourself', 'self_harm'],
    ['free porn here', 'sexual'],
    ['Cheap viagra delivered', 'spam'],
    ['Use my promo code SAVE20', 'spam'],
    ['Make money fast from home', 'spam'],
    ['asdfgh jklqwer', 'gibberish'],
    ['xkcdqz bvnmrt', 'gibberish'],
    ['!!!!!!!!!!!!', 'gibberish'],
    ['test test test test test', 'gibberish'],
  ])('rejects %j as %s', (text, category) => {
    expect(post(text)).toEqual({ action: 'reject', category });
  });

  it('rejects slurs, whatever the spelling', () => {
    expect(post('f4gg0t').action).toBe('reject');
    expect(post('such a r e t a r d e d idea')).toEqual({ action: 'reject', category: 'hate' });
  });

  it.each([
    ['Follow me for more recipes', 'spam'],
    ['Pay with crypto', 'spam'],
    ['What a bitch of a bug', 'harassment'],
    ['Sometimes I want to die when the timer resets', 'self_harm'],
    ['rape', 'violence'],
    // Spanish for monkfish: flagged for a person to look at, never refused.
    ['Agregar recetas de pescado como rape a la marinera', 'violence'],
  ])('flags %j for review as %s', (text, category) => {
    expect(post(text)).toEqual({ action: 'review', category });
  });

  it('flags a test post, but not a short reply', () => {
    expect(post('testing')).toEqual({ action: 'review', category: 'low_effort' });
    expect(post('hello world')).toEqual({ action: 'review', category: 'low_effort' });
    expect(comment('ok')).toEqual({ action: 'allow' });
    expect(comment('lol')).toEqual({ action: 'allow' });
    expect(comment('jajaja')).toEqual({ action: 'allow' });
    expect(comment('hahahaha yes please')).toEqual({ action: 'allow' });
  });
});
