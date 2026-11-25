// Multiplies the amounts in one free-text ingredient line ("2 cups flour", "כף וחצי סוכר")
// for the recipe page's "×2"-style buttons. Plain code, not a model: instant, free, works
// for guests, and the same line always gives the same answer. It is a best effort; what it
// gets wrong is listed in docs/internals/08_web-ui.md → Known gaps.

const FRACTION_GLYPHS = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8,
  '⅝': 5 / 8, '⅞': 7 / 8, '⅙': 1 / 6, '⅚': 5 / 6,
};
const GLYPHS = Object.keys(FRACTION_GLYPHS).join('');

// Units, singular → plural. A line that starts with one ("כפית מלח", "pinch of salt") means
// one of it. A unit whose plural is itself (g, גרם) still counts.
const UNITS = {
  cup: 'cups', tablespoon: 'tablespoons', teaspoon: 'teaspoons', tbsp: 'tbsp', tsp: 'tsp',
  gram: 'grams', g: 'g', kg: 'kg', ml: 'ml', liter: 'liters', litre: 'litres', oz: 'oz',
  ounce: 'ounces', lb: 'lbs', pound: 'pounds', pinch: 'pinches', handful: 'handfuls',
  can: 'cans', clove: 'cloves', package: 'packages', packet: 'packets', stick: 'sticks',
  slice: 'slices', bunch: 'bunches', sprig: 'sprigs', container: 'containers', cube: 'cubes',
  jar: 'jars', bag: 'bags', piece: 'pieces', dash: 'dashes', drop: 'drops', sleeve: 'sleeves',
  splash: 'splashes', head: 'heads', basket: 'baskets', tub: 'tubs',
  'כוס': 'כוסות', 'כף': 'כפות', 'כפית': 'כפיות', 'גרם': 'גרם', 'גר\'': 'גר\'', 'גר׳': 'גר׳',
  'ק"ג': 'ק"ג', 'ק״ג': 'ק״ג', 'קילו': 'קילו', 'קילוגרם': 'קילוגרם', 'מ"ל': 'מ"ל', 'מ״ל': 'מ״ל',
  'ליטר': 'ליטר', 'חבילה': 'חבילות', 'חבילת': 'חבילות', 'קופסה': 'קופסאות',
  'קופסא': 'קופסאות', 'קופסת': 'קופסאות', 'גביע': 'גביעים', 'מיכל': 'מיכלים', 'שן': 'שיני',
  'חופן': 'חופנים', 'קורט': 'קורטים', 'קמצוץ': 'קמצוצים', 'יחידה': 'יחידות', 'פחית': 'פחיות',
  'צרור': 'צרורות', 'ענף': 'ענפי', 'סלסילה': 'סלסילות', 'סלסילת': 'סלסילות',
  'מארז': 'מארזים', 'אריזה': 'אריזות', 'שקית': 'שקיות', 'שרוול': 'שרוולים', 'ראש': 'ראשי',
  'קובייה': 'קוביות', 'קוביית': 'קוביות',
  // Not units, but eggs are counted in most recipes, so "ביצה להברשה" means one egg.
  egg: 'eggs', yolk: 'yolks', 'ביצה': 'ביצים', 'חלמון': 'חלמונים', 'חלבון': 'חלבונים',
};
// Common things counted by the piece. Unlike units, they only change form after a number:
// "2 lemons", but "בצל סגול" with no number is left alone.
const NOUNS = {
  lemon: 'lemons', lime: 'limes', orange: 'oranges', onion: 'onions', carrot: 'carrots',
  banana: 'bananas', pomegranate: 'pomegranates', tomato: 'tomatoes', potato: 'potatoes',
  cucumber: 'cucumbers', avocado: 'avocados', apple: 'apples', peach: 'peaches',
  nectarine: 'nectarines', leek: 'leeks', fillet: 'fillets', pepper: 'peppers', date: 'dates',
  cauliflower: 'cauliflowers', bean: 'beans',
  'לימון': 'לימונים', 'בצל': 'בצלים', 'גזר': 'גזרים', 'תפוז': 'תפוזים', 'עגבנייה': 'עגבניות',
  'בננה': 'בננות', 'פלפל': 'פלפלים', 'פלפלון': 'פלפלונים', 'מלפפון': 'מלפפונים', 'תפוח': 'תפוחים',
};
const PLURALS = { ...UNITS, ...NOUNS };
// plural → singular, for when the new amount is 1 or less ("2 cups" × ½).
const SINGULARS = { 'שיני': 'שן', 'כפות': 'כף', 'כפיות': 'כפית', 'כוסות': 'כוס', 'קוביות': 'קובייה' };
for (const [singular, plural] of Object.entries(PLURALS)) SINGULARS[plural] ??= singular;

// A word that may stand between an amount and its unit ("3 heaped tbsp", "2 egg yolks").
const ADJECTIVES = [
  'level', 'heaped', 'heaping', 'rounded', 'scant', 'large', 'small', 'big', 'medium', 'tiny',
  'generous', 'whole', 'fresh', 'ripe', 'red', 'green', 'yellow', 'purple', 'sweet', 'egg',
];
// Hebrew puts the adjective after the unit, and it agrees with it ("2 כפיות שטוחות").
const HEBREW_ADJECTIVES = {
  'שטוחה': 'שטוחות', 'גדושה': 'גדושות', 'מלאה': 'מלאות', 'טרופה': 'טרופות', 'גדולה': 'גדולות',
  'קטנה': 'קטנות', 'בינונית': 'בינוניות', 'גדול': 'גדולים', 'קטן': 'קטנים', 'בינוני': 'בינוניים',
  'כפולה': 'כפולות', 'נדיב': 'נדיבים',
};
const HEBREW_ADJECTIVES_SINGULAR = Object.fromEntries(Object.entries(HEBREW_ADJECTIVES).map(([s, p]) => [p, s]));

// Amounts written as words; only read where an amount starts (see amountStarts), where they
// can't be part of a note.
const WORD_AMOUNTS = {
  a: 1, an: 1, one: 1, half: 1 / 2, quarter: 1 / 4, two: 2, three: 3, four: 4,
  'אחד': 1, 'אחת': 1, 'חצי': 1 / 2, 'רבע': 1 / 4, 'שליש': 1 / 3, 'שתי': 2, 'שני': 2,
  'שתיים': 2, 'שניים': 2, 'שלוש': 3, 'שלושה': 3, 'ארבע': 4, 'ארבעה': 4,
  'שלושת רבעי': 3 / 4,
};
// "1 וחצי כוסות", "כף וחצי": a fraction joined to the amount before it.
const AND_FRACTIONS = { 'וחצי': 1 / 2, 'ורבע': 1 / 4, 'ושליש': 1 / 3 };

// What follows a number that is not an amount: a percentage, a temperature or a time, also
// as the end of a range ("16-32%", "6-8 hours").
const NOT_AMOUNT = /^\s*(?:(?:[-–]|to|עד)\s*[\d./]+\s*)?(?:%|°|(?:minutes?|mins?|hours?|seconds?|days?|דקות|דקה|שעות|שעה|שניות|ימים)(?!\p{L}))/iu;
// Sizes, not amounts: "25 cm tortillas" stays 25 cm. Only skipped after the line's first
// amount, so "1.5 ס"מ ג'ינג'ר" still scales.
const SIZE_UNIT = /^(?:\s+ו(?:חצי|רבע|שליש))?[\s-]*(?:cm|inch|inches|in\.|ס"מ|ס״מ|אינץ')/i;
// Where an amount may start inside a line besides its start and a bracket: "+ חלמון",
// "או כפית יבשים", "פחות כף", "plus 1 tbsp", and each item of a list ("half teaspoon
// cinnamon, quarter teaspoon ginger, pinch of cloves").
const CONNECTOR = /(?:\+|,|\s\/|\s(?:או|or|ועוד|plus|פחות|minus))\s*/gu;
// An amount in words that the code can't rewrite in place ("מיץ מלימון אחד", "juice of half
// a lemon"). A line with only such an amount gets "(×2)" added instead.
const AMOUNT_IN_WORDS = /(?<!\p{L})[מלכבו]?(?:אחד|אחת|שלם|שלמה|חצי|רבע|שליש|שני|שתי|שתיים|שניים)(?!\p{L})|\b(?:one|two|three|half an?|a whole|a half)\b/iu;

const NUMBER = new RegExp(
  `(?<![\\p{L}\\d.])(?:\\d+\\s*(?:and|ו-?|\\+)\\s*(?:\\d+\\/\\d+|[${GLYPHS}])|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?[${GLYPHS}]?|[${GLYPHS}])`,
  'giu',
);
const WORD = /[\p{L}"'׳״]+/u;

function parseNumber(text) {
  // "1 and 1/2", "1 ו-1/3", "1+1/3" are one amount.
  const number = text.replace(/\s*(?:and|ו-?|\+)\s*/i, ' ').trim();
  let match = number.match(new RegExp(`^(\\d+(?:\\.\\d+)?)?\\s*([${GLYPHS}])$`, 'u'));
  if (match) return (match[1] ? Number(match[1]) : 0) + FRACTION_GLYPHS[match[2]];
  match = number.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  if (match) return Number(match[3]) ? Number(match[1] ?? 0) + Number(match[2]) / Number(match[3]) : NaN;
  return Number(number);
}

// 1.5 → "1½", 0.333 → "⅓", 562.5 → "563", 2.4 → "2.4".
export function formatAmount(value) {
  if (value >= 20) return String(Math.round(value));
  const whole = Math.floor(value);
  const rest = value - whole;
  if (rest < 0.01) return String(whole);
  if (rest > 0.99) return String(whole + 1);
  for (const [glyph, fraction] of Object.entries(FRACTION_GLYPHS)) {
    if (Math.abs(rest - fraction) < 0.01) return whole ? `${whole}${glyph}` : glyph;
  }
  return String(Math.round(value * 10) / 10);
}

const isUnit = (word) => word.toLowerCase() in UNITS || word.toLowerCase() in SINGULARS && SINGULARS[word.toLowerCase()] in UNITS;
const isNoun = (word) => word.toLowerCase() in NOUNS || SINGULARS[word.toLowerCase()] in NOUNS;

// The unit (or, with `nouns`, counted thing) right after position `index`, maybe after one
// adjective: { start, end, word } or null.
function unitAfter(line, index, nouns) {
  const match = line.slice(index).match(new RegExp(`^(\\s*)(${WORD.source})(?:(\\s+)(${WORD.source}))?`, 'u'));
  if (!match) return null;
  const [, space, first, gap, second] = match;
  const known = (word) => isUnit(word) || (nouns && isNoun(word));
  const start = index + space.length;
  if (second && ADJECTIVES.includes(first.toLowerCase()) && known(second)) {
    const secondStart = start + first.length + gap.length;
    return { start: secondStart, end: secondStart + second.length, word: second };
  }
  // "egg whites" are not eggs; leave the line's words as they are.
  if (first.toLowerCase() === 'egg' && /^white/i.test(second ?? '')) return null;
  if (known(first)) return { start, end: start + first.length, word: first };
  return null;
}

// The word's form for the new amount, keeping a capital it had.
function formFor(word, value) {
  const key = word.toLowerCase();
  const singular = key in PLURALS ? key : SINGULARS[key];
  const form = value > 1 ? PLURALS[singular] : singular;
  return word[0] === key[0] ? form : form[0].toUpperCase() + form.slice(1);
}

// Where an amount may start: after a bullet and a label ("* ", "For the sauce: ", "לגאנש: "),
// right after each opening bracket ("200 גרם (כוס) סוכר"), and after a connector.
function amountStarts(line) {
  const bullet = line.match(/^[\s*•·-]*/)[0].length;
  const label = line.slice(bullet).match(/^[^:\d]{1,40}:\s*/);
  const starts = [{ start: bullet + (label ? label[0].length : 0) }];
  for (const match of line.matchAll(/\(\s*/g)) starts.push({ start: match.index + match[0].length, bracket: true });
  for (const match of line.matchAll(CONNECTOR)) starts.push({ start: match.index + match[0].length });
  return starts;
}

// An amount written as words, or an implied 1 ("cup of flour", "כף וחצי"), at `start`:
// { start, end, value, implied } or null. In a bracket an implied 1 is only a unit alone,
// "(כוס)" or "(כפית וחצי)", so "(can be frozen)" stays as it is.
function wordAmountAt(line, start, bracket) {
  const rest = line.slice(start);
  const phrase = Object.keys(WORD_AMOUNTS).find((words) =>
    rest.slice(0, words.length).toLowerCase() === words && !/\p{L}/u.test(rest[words.length] ?? ''));
  if (phrase) {
    let end = start + phrase.length;
    // "half a cup" is ½ cup.
    if (phrase === 'half' || phrase === 'quarter') end += line.slice(end).match(/^\s+an?(?=\s)/i)?.[0].length ?? 0;
    // "a" or "an" is only an amount before a unit ("a pinch of salt", not "a little oil").
    if ((phrase === 'a' || phrase === 'an') && !unitAfter(line, end)) return null;
    return { start, end, value: WORD_AMOUNTS[phrase] };
  }
  // Only a singular unit means one: "ביצים רכות" is some eggs, not one.
  const unit = unitAfter(line, start);
  if (!unit || !(unit.word.toLowerCase() in UNITS)) return null;
  // "can" is also a verb: only "can of tomatoes" is one can, not "can be frozen".
  if (unit.word.toLowerCase() === 'can' && !/^\s+of\b/i.test(line.slice(unit.end))) return null;
  if (bracket && !/^\s*(?:ו(?:חצי|רבע|שליש)\s*)?\)/.test(line.slice(unit.end))) return null;
  // "קופסה אחת" says the 1 in words after the unit; it goes, since a number now says it.
  const one = line.slice(unit.end).match(/^\s+(?:אחד|אחת)(?!\p{L})/u);
  return { start, end: start, value: 1, implied: true, dropAfterUnit: one?.[0].length ?? 0 };
}

function findAmounts(line) {
  const amounts = [];
  for (const { start, bracket } of amountStarts(line)) {
    const amount = wordAmountAt(line, start, bracket);
    if (amount && !amounts.some((a) => a.start === amount.start)) amounts.push(amount);
  }
  const insideWordAmount = (index) => amounts.some((a) => index >= a.start && index < a.end);
  for (const match of line.matchAll(NUMBER)) {
    if (insideWordAmount(match.index)) continue;
    const end = match.index + match[0].length;
    const after = line.slice(end);
    if (NOT_AMOUNT.test(after)) continue;
    if (amounts.some((a) => a.start < match.index) && SIZE_UNIT.test(after)) continue;
    const value = parseNumber(match[0]);
    if (Number.isFinite(value)) amounts.push({ start: match.index, end, value });
  }
  return amounts.sort((a, b) => a.start - b.start);
}

// Words after a counted thing that make it part of a longer name ("2 lemon slices").
const NOUN_FOLLOWERS = ['zest', 'juice', 'slices', 'stalks', 'wedges', 'peel', 'halves', 'rings'];

// A counted thing changes form only when it agreed with its old amount: "2 green onion
// stalks" is a name, so it stays. In Hebrew the adjective after it would have to agree too,
// so only a noun with nothing or a known adjective after it changes ("2 בצלים", not "2 בצלים סגול").
function nounMayChange(line, noun, oldValue) {
  const wasPlural = noun.word.toLowerCase() in SINGULARS && !(noun.word.toLowerCase() in PLURALS);
  if (wasPlural !== oldValue > 1) return false;
  const next = line.slice(noun.end).match(/^\s+([\p{L}'׳]+)/u)?.[1];
  if (/[֐-׿]/.test(noun.word)) {
    return !next || next in HEBREW_ADJECTIVES || next in HEBREW_ADJECTIVES_SINGULAR;
  }
  return !NOUN_FOLLOWERS.includes(next?.toLowerCase());
}

export function scaleIngredient(line, factor) {
  if (factor === 1) return line;
  const amounts = findAmounts(line);
  if (!amounts.length) {
    return AMOUNT_IN_WORDS.test(line) ? `${line} (×${formatAmount(factor)})` : line;
  }
  let result = '';
  let position = 0;
  for (const amount of amounts) {
    if (amount.start < position) continue;
    let { end, value } = amount;
    let unit = unitAfter(line, end, true);
    // "1 וחצי כוסות", "כף וחצי": the joined fraction is part of the amount.
    const joinedAt = unit ? unit.end : end;
    const joined = line.slice(joinedAt).match(/^\s+(\p{L}+)/u);
    let skipTo = null;
    if (joined && AND_FRACTIONS[joined[1]]) {
      value += AND_FRACTIONS[joined[1]];
      if (unit) {
        skipTo = joinedAt + joined[0].length;
      } else {
        end = joinedAt + joined[0].length;
        unit = unitAfter(line, end, true);
      }
    }
    const scaled = value * factor;
    result += line.slice(position, amount.start) + formatAmount(scaled);
    if (unit && !isUnit(unit.word) && !nounMayChange(line, unit, value)) unit = null;
    if (!unit) {
      position = end;
      continue;
    }
    // A number now stands before a unit that began the line: "Pinch of salt" → "2 pinches of salt".
    let between = line.slice(end, unit.start);
    let word = formFor(unit.word, scaled);
    if (amount.implied) {
      between = ' ' + between.charAt(0).toLowerCase() + between.slice(1);
      if (!between.trim()) word = word.toLowerCase();
    }
    result += between + word;
    position = skipTo ?? unit.end + (amount.dropAfterUnit ?? 0);
    const adjective = skipTo === null && line.slice(position).match(/^(\s+)(\p{L}+)/u);
    const adjectiveForm = adjective && (scaled > 1 ? HEBREW_ADJECTIVES : HEBREW_ADJECTIVES_SINGULAR)[adjective[2]];
    if (adjectiveForm) {
      result += adjective[1] + adjectiveForm;
      position += adjective[0].length;
    }
  }
  return result + line.slice(position);
}
