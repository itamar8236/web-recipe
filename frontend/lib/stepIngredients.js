// Finds which ingredient lines each step names, so a step can show their amounts. It is
// plain text matching, tuned to show nothing rather than a wrong ingredient: a name that
// could mean two ingredients is never used, and a recipe with letters other than English
// or Hebrew gets no matches at all.

import { hasForeignScript } from './foreignScript';

// Words that say how much or what state an ingredient is in, not what it is.
const ENGLISH_NOISE = new Set(`
  a an the of about approx approximately plus extra some to taste or and little
  one two three four five six half quarter
  cup cups c tbsp tbs tbl tablespoon tablespoons tsp teaspoon teaspoons
  g gr gram grams kg kilo kilos kilogram kilograms ml milliliter milliliters l liter liters litre litres
  oz ounce ounces lb lbs pound pounds pinch pinches dash dashes handful handfuls
  clove cloves can cans jar jars package packages pack packs packet packets bunch bunches
  sprig sprigs slice slices piece pieces stick sticks head heads stalk stalks quart quarts pint pints
  leaf leaves floret florets
  chopped diced minced sliced grated shredded crushed peeled seeded pitted halved quartered cubed
  fresh freshly large small medium finely roughly thinly thickly coarsely
  melted softened cold warm hot room temperature beaten whole optional divided packed heaping level
  ground dried dry boneless skinless cooked raw unsalted salted kosher virgin
  sifted cut rinsed drained washed trimmed toasted roasted cooled
`.split(/\s+/).filter(Boolean));

// An English name ends before these: "water for cooking the chicken" is water.
const ENGLISH_NAME_ENDS = new Set(['for', 'from', 'with', 'in', 'into', 'on', 'at', 'to']);

const HEBREW_NOISE = new Set(`
  כוס כוסות כף כפות כפית כפיות גרם גרמים גר קילו קילוגרם קג ליטר ליטרים מל
  יחידה יחידות קורט חופן חופנים שן שיני שיניים פרוסה פרוסות חבילה חבילות
  קופסה קופסת קופסאות פחית צרור ענף ענפי גביע גביעים עלי עלה עלים
  חצי רבע שליש שלושת רבעי כמה קצת מעט של בערך לפי הטעם טעם
  קצוץ קצוצה קצוצים קצוצות טרי טרייה טריים טריות
  גדול גדולה גדולים גדולות קטן קטנה קטנים קטנות בינוני בינונית בינוניים בינוניות
  פרוס פרוסים מגורד מגורדת מגורדים מגורר מגוררת מרוסק מרוסקת מרוסקים
  מומס מומסת מרוכך מרוככת קר קרה קרים חם חמה חמים
  טחון טחונה טחונים כתוש כתושה כתושים קלוף קלופה קלופים
  יבש יבשה יבשים מיובש מיובשת מיובשים דק דקה דקים גס גסה
  מבושל מבושלת מבושלים שלם שלמה שלמים להגשה לקישוט לציפוי אופציונלי רצוי
  אחד אחת שטוח שטוחה גדוש גדושה בהיר בהירה ממותק ממותקת
`.split(/\s+/).filter(Boolean));

// The last English word or first Hebrew word ("olive oil", "שמן זית") is what a step often
// calls the ingredient alone. These are too vague to stand alone for any one line; a step's
// "water" is as often for rinsing or boiling as the listed water.
const VAGUE_WORDS = new Set(`
  sauce mixture mix dough batter filling topping glaze base water oil
  powder juice extract paste syrup flakes seeds seed zest peel
  רוטב תערובת בצק בלילה מילוי ציפוי מים שמן אבקת אבקה מיץ רכז תמצית
  גרידת גרידה קליפת קליפה פרוסות קוביות חתיכות גרגירי גרעיני זרעי פרחי נתחי נתח פילה
`.split(/\s+/).filter(Boolean));

// Liquids a step often names next to another ingredient ("pasta water", "מי פסטה"), so
// they block a match even when the list doesn't have them.
const LIQUID_WORDS = ['water', 'oil', 'juice', 'stock', 'broth', 'מימ', 'שמנ', 'מיצ', 'ציר'];

// Hebrew joins "and", "the", "in" and "to" to the next word ("והבצל"). A lone "מ" is left
// out: it also starts verbs (משמנים is greasing, not oil).
const HEBREW_PREFIXES = ['', 'ו', 'ה', 'ב', 'ל', 'וה', 'וב', 'ול', 'מה'];
const HEBREW_FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const MIN_NAME_LETTERS = 3;

const isHebrew = (word) => /[א-ת]/.test(word);
// "וחצי" (and a half) is an amount as much as "חצי".
const isNoise = (word) => (isHebrew(word) ? HEBREW_NOISE.has(word.replace(/^ו/, '')) || HEBREW_NOISE.has(word) : ENGLISH_NOISE.has(word));

// Accents (crème) and Hebrew vowel marks are dropped, so they don't stop a match.
function plainLetters(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// A Hebrew word keeps its geresh or gershayim (צ׳ילי, מ"ל) as one word, without the mark.
function words(text) {
  return (plainLetters(text).match(/[a-z]+|[א-ת]+(?:['"׳״][א-ת]+)*/g) ?? []).map((word) => word.replace(/['"׳״]/g, ''));
}

// Singular and plural ("egg", "eggs"; "ביצה", "ביצים") become the same word.
function stem(word) {
  if (isHebrew(word)) {
    if (word === 'מי') return 'מימ'; // "water of", as in מי פסטה
    let base = word.replace(/(ים|ות|ה)$/, '');
    if (base.length < MIN_NAME_LETTERS) base = word;
    // עגבנייה and עגבניות meet at עגבנ; קרמי (creamy) stays apart from קרם.
    const withoutYod = base.replace(/י+$/, '');
    if (base !== word && withoutYod.length >= MIN_NAME_LETTERS) base = withoutYod;
    return base.replace(/[ךםןףץ]/g, (letter) => HEBREW_FINALS[letter]);
  }
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(oes|ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Every stemmed form a step's word may stand for, with Hebrew's joined prefixes taken off.
function forms(word) {
  if (!isHebrew(word)) return new Set([stem(word)]);
  const found = new Set();
  for (const prefix of HEBREW_PREFIXES) {
    const rest = word.slice(prefix.length);
    if (word.startsWith(prefix) && rest.length >= MIN_NAME_LETTERS - 1) found.add(stem(rest));
  }
  // A joined form (גבינת, of גבינה) counts as the word itself; short ones such as שמנת
  // (cream) are words of their own.
  if (word.length >= 5 && word.endsWith('ת')) found.add(stem(`${word.slice(0, -1)}ה`));
  if (/^[ובלמ]{0,2}מי$/.test(word)) found.add('מימ'); // "ממי הפסטה", from the pasta's water
  return found;
}

function nameWords(part) {
  const name = [];
  for (const word of words(part)) {
    if (ENGLISH_NAME_ENDS.has(word)) break;
    if (!isNoise(word)) name.push(word);
  }
  return name;
}

// "2 cups all-purpose flour, sifted (or bread flour)" -> [["all", "purpose", "flour"], ["bread", "flour"]]
function ingredientNames(line) {
  const trimmed = line.trim();
  if (trimmed.endsWith(':')) return []; // a heading such as "For the sauce:"
  const inBrackets = [...trimmed.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]);
  let main = trimmed.replace(/\([^)]*\)/g, ' ');
  // "For the dough: 330 g flour", "לבצק: קמח" name what the line is for before its colon.
  const colon = main.match(/^\s*(for\s[^:]*|ל[א-ת]*)\s*:(.*)$/i);
  if (colon) main = colon[2];
  main = main.split(/[,:;]| - | – /)[0];
  return [main, ...inBrackets.filter((text) => /^\s*(or|או)\s/i.test(text))]
    .flatMap((part) => part.split(/\s(?:or|and|או)\s|&/i))
    .map(nameWords)
    .filter((name) => name.join('').length >= MIN_NAME_LETTERS);
}

// Each step word's possible forms, for a step or for a whole ingredient line.
const phraseOf = (text) => words(text).map(forms);

function startsAt(phrase, start, nameWords, taken) {
  return nameWords.every((word, offset) => !taken?.[start + offset] && phrase[start + offset]?.has(word));
}

function appearsIn(phrase, nameWords) {
  return phrase.some((_, start) => startsAt(phrase, start, nameWords));
}

// Each name, and its main word alone, as stemmed words that point to their line. One that
// any other line also has ("oil" in "olive oil" and "sesame oil", "onion" in a broth's
// list of vegetables) points to neither.
function namesOf(ingredients) {
  const linePhrases = ingredients.map(phraseOf);
  const names = [];
  ingredients.forEach((line, index) => {
    const keys = new Map();
    for (const name of ingredientNames(line)) {
      if (name.length > 1 || !VAGUE_WORDS.has(name[0])) keys.set(name.map(stem).join(' '), name.map(stem));
      const head = isHebrew(name[0]) ? name[0] : name[name.length - 1];
      if (name.length > 1 && stem(head).length >= MIN_NAME_LETTERS && !VAGUE_WORDS.has(head)) keys.set(stem(head), [stem(head)]);
    }
    for (const nameWords of keys.values()) {
      const shared = linePhrases.some((phrase, other) => other !== index && appearsIn(phrase, nameWords));
      if (!shared) names.push({ words: nameWords, line: index });
    }
  });
  return names.sort((a, b) => b.words.length - a.words.length || b.words.join('').length - a.words.join('').length);
}

// Every word the ingredient list uses for what things are, so a step's "bell peppers" is
// not taken for the list's "black pepper".
function vocabularyOf(ingredients) {
  const listWords = ingredients
    .flatMap(words)
    .filter((word) => word.length >= MIN_NAME_LETTERS && !isNoise(word) && !ENGLISH_NAME_ENDS.has(word))
    .map(stem);
  return new Set([...listWords, ...LIQUID_WORDS]);
}

function linesInPhrase(text, names, vocabulary, lines) {
  const raw = words(text);
  const phrase = raw.map(forms);
  const taken = phrase.map(() => false);
  const matches = [];
  // Longest names first, and each step word counts once, so "brown sugar" is never also "sugar".
  for (const name of names) {
    for (let start = 0; start + name.words.length <= phrase.length; start++) {
      if (!startsAt(phrase, start, name.words, taken)) continue;
      name.words.forEach((_, offset) => { taken[start + offset] = true; });
      matches.push({ name, start });
    }
  }
  // A food word right next to the match ("bell" peppers, "pasta water", פלפל "חריף") means
  // the step speaks of something else.
  // A Hebrew word joined with "and" (חמאה "וסוכר") starts the next ingredient instead; one
  // whose ו is its own letter (וניל) is a word of the list as it stands.
  const startsWithAnd = (index) => raw[index]?.startsWith('ו') && !vocabulary.has(stem(raw[index]));
  const isOther = (index, name) => !startsWithAnd(index) && [...(phrase[index] ?? [])].some((form) => !name.words.includes(form) && (LIQUID_WORDS.includes(form) || (!taken[index] && vocabulary.has(form))));
  for (const { name, start } of matches) {
    const joinedToPrevious = raw[start].startsWith('ו') && !name.words.includes(stem(raw[start]));
    if ((joinedToPrevious || !isOther(start - 1, name)) && !isOther(start + name.words.length, name)) lines.add(name.line);
  }
}

function linesInStep(step, names, vocabulary) {
  const lines = new Set();
  // Punctuation and "and" end a phrase, so a list of ingredients is read one at a time.
  for (const part of step.split(/[,.;:!?()/\n]|\s(?:and|or|או)\s/i)) {
    linesInPhrase(part, names, vocabulary, lines);
  }
  return [...lines].sort((a, b) => a - b);
}

// For each step, the indexes of the ingredient lines it names, in the list's order.
export function stepIngredients(ingredients, steps) {
  if (hasForeignScript({ ingredients, steps })) return steps.map(() => []);
  const names = namesOf(ingredients);
  const vocabulary = vocabularyOf(ingredients);
  return steps.map((step) => linesInStep(step, names, vocabulary));
}
