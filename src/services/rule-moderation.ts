/**
 * Rule-based screening for the community ideas board: no model, no spend, no
 * upstream that can be down.
 *
 * Runs after `localCheck` (contact details, link farms) and answers one of:
 *
 *  - `reject`  - a clear violation; the write is refused.
 *  - `review`  - published, but flagged `needs_review` so it shows up in the
 *                admin queue (`community_moderation_queue`, 003_community.sql).
 *  - `allow`
 *
 * The rules follow the old moderation prompt: slurs, sexual content, threats,
 * self-harm encouragement, insults aimed at a person, spam and keyboard mash
 * are refused; blunt feedback about the app ("this import is broken and
 * useless") and mild swearing that isn't aimed at anyone are allowed. Anything
 * that gets past the rules can still be reported, and three reports hide it.
 *
 * Matching is per word, never per substring, so "Scunthorpe", "rapeseed",
 * "meatballs" and "chicken breast" are safe. Text is normalised first so the
 * usual dodges still match: case, accents, leetspeak (`1d10t`), stretched
 * letters (`fuuuck`) and spaced or dotted letters (`f u c k`, `f.u.c.k`).
 */

export type RuleCategory =
  | 'hate'
  | 'harassment'
  | 'sexual'
  | 'violence'
  | 'self_harm'
  | 'spam'
  | 'gibberish'
  | 'low_effort';

export type RuleVerdict =
  | { action: 'allow' }
  | { action: 'reject'; category: RuleCategory }
  | { action: 'review'; category: RuleCategory };

// --- word lists ---------------------------------------------------------------
// Whole normalised words. A trailing `*` matches the word as a prefix
// ("fuck*" covers fucking, fucker, fucked).

/** Slurs. Refused in any context. */
const HATE_WORDS = [
  'nigger*', 'nigga*', 'niggaz', 'faggot*', 'fag', 'fags', 'dyke', 'dykes', 'tranny', 'trannies',
  'retard', 'retards', 'retarded', 'spic', 'spics', 'chink', 'chinks', 'kike', 'kikes', 'wetback*',
  'gook', 'gooks', 'raghead*', 'towelhead*', 'coon', 'coons', 'paki', 'pakis', 'beaner', 'beaners',
  'sandnigger*', 'shemale*',
  // Spanish
  'maricon', 'maricones', 'sudaca', 'sudacas', 'negrata*',
];

/** Explicit sexual terms. Food words that double as slang (breast, nuts, cream) are deliberately absent. */
const SEXUAL_WORDS = [
  'porn*', 'pornhub', 'xxx', 'xvideos', 'blowjob*', 'handjob*', 'dildo*', 'nudes', 'hentai',
  'cumshot*', 'creampie*', 'gangbang*', 'milf*', 'masturbat*', 'orgasm*', 'jizz*', 'bukkake',
  // Spanish
  'porno', 'mamada', 'pajas', 'follar',
];

/** Strong insults. Aimed at someone they are refused; on their own they are flagged. */
const INSULT_WORDS = [
  'idiot*', 'stupid', 'moron*', 'dumb', 'dumbass*', 'loser*', 'imbecile*', 'asshole*', 'arsehole*',
  'bastard*', 'bitch*', 'cunt*', 'dickhead*', 'prick', 'pricks', 'twat*', 'wanker*', 'scum*', 'clown',
  'pathetic', 'worthless', 'ugly', 'trash', 'garbage', 'jerk', 'douche*', 'motherfucker*', 'shithead*',
  // Spanish
  'idiota*', 'estupido*', 'imbecil*', 'pendejo*', 'gilipollas', 'cabron*', 'pelotudo*', 'boludo*',
  'tonto', 'tonta', 'basura', 'mierda',
];

/** Strong insults that are flagged even when not aimed at anyone. */
const STANDALONE_INSULTS = [
  'cunt*', 'motherfucker*', 'bitch*', 'asshole*', 'arsehole*', 'twat*', 'wanker*', 'dickhead*',
  'shithead*', 'pendejo*', 'gilipollas', 'puta', 'putas',
];

/** Spam that is refused outright. */
const SPAM_WORDS = ['viagra', 'cialis', 'casino*', 'onlyfans', 'forex', 'xanax', 'escort*'];

/** Spam-flavoured words that are flagged, not refused ("pay with crypto" is a fair idea). */
const SPAM_REVIEW_WORDS = ['crypto*', 'bitcoin*', 'nft', 'nfts', 'airdrop*', 'betting'];

/** Whole posts that are a test or a greeting rather than an idea. */
const LOW_EFFORT_TEXTS = new Set([
  'test', 'testing', 'test post', 'testing testing', 'hello', 'hello world', 'hi', 'hey', 'hii', 'lol',
  'lmao', 'ok', 'okay', 'yes', 'no', 'idk', 'nothing', 'none', 'asdf', 'qwerty', 'hola', 'prueba',
]);

// --- phrase rules -------------------------------------------------------------
// Run against the normalised text: lowercase letters and digits, single spaces.

/** Who an insult or threat can be aimed at. */
// "eres"/"sos" are Spanish "you are": the subject is usually dropped.
const TARGET = String.raw`(?:you|u|ya|youre|eres|sos|dev|devs|developer|developers|admin|admins|mod|mods|op|creator|owner)`;

/** Abuse typed as one word ("fuckyou", "f u c k o f f"). */
const HARASSMENT_WORDS = ['fuckyou*', 'fucku', 'fuckoff', 'stfu', 'gfy'];

const HARASSMENT_PHRASES = [
  /\bfuck\s+(?:you|u|ya|off|the\s+dev\w*|this\s+dev\w*)\b/,
  /\b(?:screw|f)\s+you\b/,
  /\bstfu\b/,
  /\bshut\s+(?:the\s+fuck\s+)?up\b/,
  /\bgo\s+to\s+hell\b/,
  /\bvete\s+a\s+la\s+mierda\b/,
  /\bhijo\s+de\s+puta\b/,
  /\bche\s+boludo\b/,
];

const VIOLENCE_PHRASES = [
  // A threat names who it is for: "I'll kill for dark mode" is an idiom, "kill you" is not.
  new RegExp(String.raw`\b(?:kill|murder|shoot|stab|strangle|beat\s+up|hunt\s+down)\s+${TARGET}\b`),
  /\b(?:te\s+voy\s+a\s+matar|te\s+mato)\b/,
];

const SELF_HARM_PHRASES = [
  /\bkill\s+(?:your\s*self|yourselves|urself)\b/,
  /\bkys\b/,
  /\bgo\s+die\b/,
  /\b(?:hope|wish)\s+(?:you|u)\s+die\b/,
  /\bend\s+your\s+life\b/,
  /\bslit\s+your\s+wrists?\b/,
  /\bmatate\b/,
];

/** Distress rather than abuse: flagged so a person sees it, never refused. */
const SELF_HARM_REVIEW_PHRASES = [/\bkill\s+myself\b/, /\bsuicid\w*/, /\bwant\s+to\s+die\b/];

const SPAM_PHRASES = [
  /\b(?:promo|discount|coupon|referral|invite)\s+code\b/,
  /\buse\s+(?:my\s+)?code\b/,
  /\bbuy\s+(?:now|followers|likes|cheap)\b/,
  /\bclick\s+(?:here|the\s+link|my\s+link)\b/,
  /\b(?:make|earn)\s+(?:money|\d+)\s+(?:fast|online|from\s+home|daily|a\s+day|per\s+day|weekly)\b/,
  /\bwork\s+from\s+home\b/,
  /\binvestment\s+opportunity\b/,
  /\b(?:dm|message|text|contact)\s+me\s+(?:on|at|via)\s+(?:whatsapp|telegram|insta\w*|ig|snap\w*)\b/,
];

const SPAM_REVIEW_PHRASES = [
  /\bfollow\s+me\b/,
  /\bcheck\s+out\s+my\b/,
  /\bsubscribe\s+to\s+my\b/,
  /\bmy\s+(?:channel|page|store|shop|website|site)\b/,
  /\bdm\s+me\b/,
];

/** Rows of a QWERTY keyboard; a run of four along one of them is a mash. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Four-key runs that occur in real words (property, liberty, strewn). */
const KEYBOARD_RUNS_IN_WORDS = new Set(['erty', 'trew']);

const KEYBOARD_RUNS = KEYBOARD_ROWS.flatMap((row) => {
  const runs: string[] = [];
  for (const line of [row, [...row].reverse().join('')]) {
    for (let i = 0; i + 4 <= line.length; i++) runs.push(line.slice(i, i + 4));
  }
  return runs.filter((run) => !KEYBOARD_RUNS_IN_WORDS.has(run));
});

// --- normalisation ------------------------------------------------------------

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g',
};

/** Lowercase, accents stripped, leetspeak undone - per word, and only inside words that have letters. */
function normaliseWord(raw: string): string {
  // Punctuation at the edges is punctuation, not leetspeak ("idea!" is not "ideai").
  const base = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[("'¿¡]+|[!?.,;:)"']+$/gu, '');
  if (!/\p{L}/u.test(base)) return base.replace(/[^\p{L}\p{N}]/gu, '');
  // An apostrophe joins the word ("you're" -> "youre"); every other symbol
  // is either leetspeak or noise inside the word ("f.u.c.k" -> "fuck").
  return [...base]
    .map((ch) => LEET[ch] ?? ch)
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Words of the text, normalised. Runs of single letters are joined back into a
 * word, so "f u c k" is seen as "fuck" (and "i" on its own is left alone).
 */
export function normaliseWords(text: string): string[] {
  const words = text
    .split(/\s+/)
    .map(normaliseWord)
    .filter((w) => w.length > 0);
  const joined: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) {
      // "such a r e t a r d e d idea": the leading "a" is probably a word of its own.
      if (run.length >= 4 && (run[0] === 'a' || run[0] === 'i')) joined.push(run[0], run.slice(1).join(''));
      else joined.push(run.join(''));
    } else joined.push(...run);
    run = [];
  };
  for (const word of words) {
    if (word.length === 1 && /\p{L}/u.test(word)) run.push(word);
    else {
      flush();
      joined.push(word);
    }
  }
  flush();
  return joined;
}

/** The spellings a word is tried as: as written, stretched letters cut to two, and to one. */
function variants(word: string): string[] {
  const two = word.replace(/(.)\1{2,}/gu, '$1$1');
  const one = word.replace(/(.)\1+/gu, '$1');
  return [...new Set([word, two, one])];
}

type WordMatcher = (word: string) => boolean;

function matcher(list: string[]): WordMatcher {
  const exact = new Set(list.filter((w) => !w.endsWith('*')));
  const prefixes = list.filter((w) => w.endsWith('*')).map((w) => w.slice(0, -1));
  return (word) => variants(word).some((v) => exact.has(v) || prefixes.some((p) => v.startsWith(p)));
}

const isHate = matcher(HATE_WORDS);
const isSexual = matcher(SEXUAL_WORDS);
const isInsult = matcher(INSULT_WORDS);
const isHarassment = matcher(HARASSMENT_WORDS);
const isStandaloneInsult = matcher(STANDALONE_INSULTS);
const isSpam = matcher(SPAM_WORDS);
const isSpamReview = matcher(SPAM_REVIEW_WORDS);

// --- gibberish ----------------------------------------------------------------

const LATIN_WORD = /^[a-z]+$/;
const VOWELS = /[aeiouy]/;

/**
 * True for a Latin-script word that doesn't look like language: no vowel
 * ("xkcdqz", "hjhjhjhj"), six consonants running, or four keys along a
 * keyboard row ("asdfgh"). Laughter ("hahaha", "jajaja") has vowels and passes.
 */
function looksMashed(word: string): boolean {
  if (!LATIN_WORD.test(word) || word.length < 4) return false;
  if (!VOWELS.test(word)) return true;
  if (/[^aeiouy]{6,}/.test(word)) return true;
  return KEYBOARD_RUNS.some((run) => word.includes(run));
}

/**
 * Keyboard mash, a wall of one character, or the same word over and over.
 * Only Latin-script words are judged; other scripts are left alone.
 */
function isGibberish(text: string, words: string[]): boolean {
  const compact = [...text.replace(/\s+/g, '')];
  if (compact.length >= 8) {
    const letters = compact.filter((ch) => /\p{L}/u.test(ch)).length;
    // Mostly symbols or emoji: "!!!!!!!!!!", "🍕🍕🍕🍕🍕🍕🍕🍕".
    if (letters / compact.length < 0.3) return true;
  }
  // One character held down ("soooo good" is fine, fifteen in a row is not).
  if (/(.)\1{14,}/u.test(compact.join(''))) return true;

  const judged = words.filter((w) => LATIN_WORD.test(w) && w.length >= 3);
  if (judged.length > 0) {
    const mashed = judged.filter(looksMashed).length;
    if (mashed / judged.length >= 0.6) return true;
  }
  if (words.length >= 5 && new Set(words).size / words.length <= 0.3) return true;
  return false;
}

// --- the check ----------------------------------------------------------------

/** Screens ideas-board text. Pure and synchronous. */
export function ruleCheck(text: string, kind: 'post' | 'comment'): RuleVerdict {
  const words = normaliseWords(text);
  const joined = words.join(' ');
  const reject = (category: RuleCategory): RuleVerdict => ({ action: 'reject', category });
  const review = (category: RuleCategory): RuleVerdict => ({ action: 'review', category });

  if (words.some(isHate)) return reject('hate');
  if (SELF_HARM_PHRASES.some((re) => re.test(joined))) return reject('self_harm');
  if (VIOLENCE_PHRASES.some((re) => re.test(joined))) return reject('violence');
  if (words.some(isSexual)) return reject('sexual');
  if (words.some(isHarassment) || HARASSMENT_PHRASES.some((re) => re.test(joined))) return reject('harassment');
  if (aimedInsult(words)) return reject('harassment');
  if (words.some(isSpam) || SPAM_PHRASES.some((re) => re.test(joined))) return reject('spam');
  if (isGibberish(text, words)) return reject('gibberish');

  if (SELF_HARM_REVIEW_PHRASES.some((re) => re.test(joined))) return review('self_harm');
  if (words.some(isStandaloneInsult)) return review('harassment');
  // "rape" is also Spanish for monkfish, so it is never refused on its own.
  if (words.includes('rape')) return review('violence');
  if (words.some(isSpamReview) || SPAM_REVIEW_PHRASES.some((re) => re.test(joined))) return review('spam');
  // "ok" and "lol" are fine replies; as a whole idea they are a test post.
  if (kind === 'post' && LOW_EFFORT_TEXTS.has(joined)) return review('low_effort');

  return { action: 'allow' };
}

const TARGET_RE = new RegExp(`^${TARGET}$`);

/**
 * An insult aimed at a person: "you idiot", "the dev is a total moron",
 * "eres un idiota", or "idiot dev". "This feature is stupid" is feedback about
 * the app, not a person, and passes.
 */
function aimedInsult(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (!isInsult(words[i])) continue;
    // Target, then up to four filler words, then the insult.
    for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
      if (TARGET_RE.test(words[j])) return true;
      if (!isFiller(words[j])) break;
    }
    // Insult straight before the target: "idiot dev", "stupid admin".
    if (i + 1 < words.length && TARGET_RE.test(words[i + 1])) return true;
  }
  return false;
}

/** Words allowed between the target and the insult: "you are such a total idiot". */
const FILLER_WORDS = new Set([
  'are', 'r', 'is', 'an', 'a', 'such', 'so', 'total', 'complete', 'absolute', 'fucking', 'fkn', 'literally',
  'really', 'being', 'just', 'the', 'biggest', 'es', 'un', 'una', 'muy',
]);

function isFiller(word: string): boolean {
  return FILLER_WORDS.has(word);
}
