// Multiplies the amounts in one free-text ingredient line ("2 cups flour", "כף וחצי סוכר")
// for the recipe page's "×2"-style buttons. Plain code, not a model: instant, free, works
// for guests, and the same line always gives the same answer. It is a best effort; what it
// gets wrong is listed in docs/internals/08_web-ui.md → Known gaps.

const FRACTION_GLYPHS = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8,
  '⅝': 5 / 8, '⅞': 7 / 8, '⅙': 1 / 6, '⅚': 5 / 6,
};
const GLYPH_CLASS = Object.keys(FRACTION_GLYPHS).join('');

// singular → plural. A unit whose plural is itself (g, ml, גרם) still counts as a unit, so a
// line that starts with it ("כפית מלח") means one of it.
const UNITS = {
  cup: 'cups', tablespoon: 'tablespoons', teaspoon: 'teaspoons', tbsp: 'tbsp', tsp: 'tsp',
  gram: 'grams', g: 'g', kg: 'kg', ml: 'ml', liter: 'liters', litre: 'litres', oz: 'oz',
  ounce: 'ounces', lb: 'lbs', pound: 'pounds', pinch: 'pinches', handful: 'handfuls',
  can: 'cans', clove: 'cloves', package: 'packages', packet: 'packets', stick: 'sticks',
  slice: 'slices', bunch: 'bunches', sprig: 'sprigs', container: 'containers', cube: 'cubes',
  jar: 'jars', bag: 'bags', piece: 'pieces', dash: 'dashes', drop: 'drops', sleeve: 'sleeves',
  splash: 'splashes', head: 'heads', basket: 'baskets', tub: 'tubs',
  'כוס': 'כוסות', 'כף': 'כפות', 'כפית': 'כפיות', 'גרם': 'גרם', 'גר\'': 'גר\'', 'גר׳': 'גר׳',
  'ק"ג': 'ק"ג', 'קילו': 'קילו', 'קילוגרם': 'קילוגרם', 'מ"ל': 'מ"ל', 'מ״ל': 'מ״ל',
  'ליטר': 'ליטר', 'חבילה': 'חבילות', 'חבילת': 'חבילות', 'קופסה': 'קופסאות',
  'קופסא': 'קופסאות', 'קופסת': 'קופסאות', 'גביע': 'גביעים', 'שן': 'שיני', 'חופן': 'חופנים',
  'קורט': 'קורטים', 'קמצוץ': 'קמצוצים', 'יחידה': 'יחידות', 'פחית': 'פחיות',
  'צרור': 'צרורות', 'ענף': 'ענפים', 'סלסילה': 'סלסילות', 'סלסילת': 'סלסילות',
  'מארז': 'מארזים', 'שקית': 'שקיות', 'ראש': 'ראשי',
  // Not units, but eggs are in most recipes and "2 egg" reads wrong.
  egg: 'eggs', yolk: 'yolks', 'ביצה': 'ביצים', 'חלמון': 'חלמונים', 'חלבון': 'חלבונים',
};
// plural → singular, for when the new amount is 1 or less ("2 cups" × ½).
const SINGULAR = { 'שיני': 'שן', 'כפות': 'כף', 'כפיות': 'כפית', 'כוסות': 'כוס' };
for (const [singular, plural] of Object.entries(UNITS)) SINGULAR[plural] ??= singular;

// A word that may stand between an amount and its unit ("3 heaped tbsp", "2 egg yolks").
const UNIT_ADJECTIVES = ['level', 'heaped', 'heaping', 'rounded', 'scant', 'large', 'small', 'big', 'generous', 'egg'];
// Hebrew puts the adjective after the unit, and it agrees with it ("2 כפיות שטוחות").
const HEBREW_ADJECTIVES = {
  'שטוחה': 'שטוחות', 'גדושה': 'גדושות', 'מלאה': 'מלאות', 'טרופה': 'טרופות', 'גדולה': 'גדולות',
  'קטנה': 'קטנות', 'בינונית': 'בינוניות',
};
const HEBREW_ADJECTIVES_SINGULAR = Object.fromEntries(Object.entries(HEBREW_ADJECTIVES).map(([s, p]) => [p, s]));

// Amounts written as words; only read where an amount starts (a line, or a bracket), where
// they can't be part of a note.
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
const NOT_AMOUNT = /^\s*(?:(?:[-–]|to|עד)\s*[\d./]+\s*)?(?:%|°|(?:minutes?|mins?|hours?|seconds?|days?|דקות|דקה|שעות|שעה|שניות|ימים)(?![\p{L}]))/iu;
// Sizes, not amounts: "25 cm tortillas" stays 25 cm. Only skipped after the line's first
// amount, so "1.5 ס"מ ג'ינג'ר" still scales.
const SIZE_UNIT = /^[\s-]*(?:cm|inch|inches|in\.|ס"מ|אינץ')/i;

const NUMBER = new RegExp(
  `(?<![\\p{L}\\d.])(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?[${GLYPH_CLASS}]?|[${GLYPH_CLASS}])`,
  'gu',
);
const WORD = /[\p{L}"'׳״]+/u;

function parseNumber(text) {
  const glyph = text.at(-1);
  if (FRACTION_GLYPHS[glyph]) return (text.length > 1 ? Number(text.slice(0, -1)) : 0) + FRACTION_GLYPHS[glyph];
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[2]) ? Number(fraction[1]) / Number(fraction[2]) : NaN;
  return Number(text);
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

function isUnit(word) {
  const key = word.toLowerCase();
  return key in UNITS || key in SINGULAR;
}

// The unit right after position `index` (maybe after an adjective): { start, end, word } or null.
function unitAfter(line, index) {
  const match = line.slice(index).match(new RegExp(`^(\\s*)(${WORD.source})(?:(\\s+)(${WORD.source}))?`, 'u'));
  if (!match) return null;
  const [, space, first, gap, second] = match;
  const start = index + space.length;
  if (second && UNIT_ADJECTIVES.includes(first.toLowerCase()) && isUnit(second)) {
    const secondStart = start + first.length + gap.length;
    return { start: secondStart, end: secondStart + second.length, word: second };
  }
  // "egg whites" are not eggs; leave the line's words as they are.
  if (first.toLowerCase() === 'egg' && /^white/i.test(second ?? '')) return null;
  if (isUnit(first)) return { start, end: start + first.length, word: first };
  return null;
}

// The unit's form for the new amount. `implied` means a number now stands before a unit that
// started the line, so "Pinch of salt" becomes "2 pinches of salt", not "2 Pinches".
function unitFor(word, value, implied) {
  const key = word.toLowerCase();
  const singular = key in UNITS ? key : SINGULAR[key];
  const form = value > 1 ? UNITS[singular] : singular;
  if (implied || word[0] === key[0]) return form;
  return form[0].toUpperCase() + form.slice(1);
}

// Where an amount may start: after a bullet and a label ("* ", "For the sauce: ", "לגאנש: "),
// and right after each opening bracket ("200 גרם (כוס) סוכר").
function amountStarts(line) {
  const bullet = line.match(/^[\s*•·-]*/)[0].length;
  const label = line.slice(bullet).match(/^[^:\d]{1,40}:\s*/);
  const starts = [{ start: bullet + (label ? label[0].length : 0) }];
  for (const match of line.matchAll(/\(\s*/g)) starts.push({ start: match.index + match[0].length, bracket: true });
  return starts;
}

// An amount written as words, or an implied 1 ("cup of flour", "כף וחצי"), at `start`:
// { start, end, value, implied } or null. In a bracket an implied 1 is only a unit alone,
// "(כוס)", so "(can be frozen)" stays as it is.
function wordAmountAt(line, start, bracket) {
  const rest = line.slice(start);
  const phrase = Object.keys(WORD_AMOUNTS).find((words) => {
    const found = rest.slice(0, words.length);
    return found.toLowerCase() === words && !/[\p{L}]/u.test(rest[words.length] ?? '');
  });
  if (phrase) {
    let end = start + phrase.length;
    // "half a cup" is ½ cup.
    if (phrase === 'half' || phrase === 'quarter') end += line.slice(end).match(/^\s+an?(?=\s)/i)?.[0].length ?? 0;
    // "a" or "an" is only an amount before a unit ("a pinch of salt", not "a little oil").
    if ((phrase === 'a' || phrase === 'an') && !unitAfter(line, end)) return null;
    return { start, end, value: WORD_AMOUNTS[phrase] };
  }
  // Only a singular word means one: "ביצים רכות" is some eggs, not one.
  const unit = unitAfter(line, start);
  const singular = unit && unit.word.toLowerCase() in UNITS;
  if (singular && (!bracket || /^\s*\)/.test(line.slice(unit.end)))) return { start, end: start, value: 1, implied: true };
  return null;
}

function findAmounts(line) {
  const amounts = [];
  for (const { start, bracket } of amountStarts(line)) {
    const amount = wordAmountAt(line, start, bracket);
    if (amount) amounts.push(amount);
  }
  const overlapsWordAmount = (index) => amounts.some((a) => index >= a.start && index < a.end);
  for (const match of line.matchAll(NUMBER)) {
    if (overlapsWordAmount(match.index)) continue;
    const end = match.index + match[0].length;
    const after = line.slice(end);
    if (NOT_AMOUNT.test(after)) continue;
    if (amounts.some((a) => a.start < match.index) && SIZE_UNIT.test(after)) continue;
    const value = parseNumber(match[0]);
    if (Number.isFinite(value)) amounts.push({ start: match.index, end, value });
  }
  return amounts.sort((a, b) => a.start - b.start);
}

export function scaleIngredient(line, factor) {
  if (factor === 1) return line;
  let result = '';
  let position = 0;
  for (const amount of findAmounts(line)) {
    if (amount.start < position) continue;
    let { end, value } = amount;
    let unit = unitAfter(line, end);
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
        unit = unitAfter(line, end);
      }
    }
    const scaled = value * factor;
    result += line.slice(position, amount.start) + formatAmount(scaled) + (amount.implied ? ' ' : '');
    if (!unit) {
      position = end;
      continue;
    }
    result += line.slice(end, unit.start) + unitFor(unit.word, scaled, amount.implied);
    position = skipTo ?? unit.end;
    const adjective = skipTo === null && line.slice(position).match(/^(\s+)(\p{L}+)/u);
    const adjectiveForm = adjective && (scaled > 1 ? HEBREW_ADJECTIVES : HEBREW_ADJECTIVES_SINGULAR)[adjective[2]];
    if (adjectiveForm) {
      result += adjective[1] + adjectiveForm;
      position += adjective[0].length;
    }
  }
  return result + line.slice(position);
}
