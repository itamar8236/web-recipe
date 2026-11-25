import { describe, expect, it } from 'vitest';
import { stepIngredients } from './stepIngredients';

describe('stepIngredients', () => {
  it('finds the lines a step names, ignoring amounts, units and how they are cut', () => {
    const ingredients = ['2 cups all-purpose flour, sifted', '3 large eggs', '1 onion, diced', '½ tsp salt'];
    const steps = ['Dice the onion.', 'Whisk the egg with the flour and the salt.', 'Bake for 20 minutes.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[2], [0, 1, 3], []]);
  });

  it('matches whole words only', () => {
    expect(stepIngredients(['2 tbsp oil', '1 tsp salt'], ['Boil the water and add salted butter.'])).toEqual([[]]);
  });

  it('prefers the longest name, so brown sugar is not also sugar', () => {
    const ingredients = ['100 g sugar', '50 g brown sugar'];
    // "sugar" alone could be either line, so it shows neither.
    expect(stepIngredients(ingredients, ['Add the brown sugar.', 'Add the sugar.'])).toEqual([[1], []]);
  });

  it('ends an English name at a preposition', () => {
    const ingredients = ['Stock for cooking the chicken', '6 chicken drumsticks', 'Mint leaves from a whole bunch'];
    const steps = ['Fry the chicken.', 'Add the stock.', 'Peel the onions from the outside.', 'Add the mint.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [0], [], [2]]);
  });

  it('does not use a name another line also has anywhere in it', () => {
    const ingredients = ['Pinch of black pepper', 'Broccoli florets, sliced onions, and bell peppers', 'Green onions, sliced'];
    const steps = ['Roast the broccoli, onions, and bell peppers.', 'Season with black pepper.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[1], [0]]);
    const hebrew = ['חצי כפית פלפל שחור', 'חצי פלפל ירוק חריף'];
    expect(stepIngredients(hebrew, ['מוסיפים פלפל.', 'מוסיפים פלפל שחור.'])).toEqual([[], [0]]);
  });

  it('does not take a different ingredient next to a name for it', () => {
    const ingredients = ['500 g pasta', '1 cup boiling water', '1 tsp black pepper', '2 tbsp lemon juice'];
    const steps = ['Cook the pasta.', 'Add a little pasta water.', 'Sprinkle lemon pepper.', 'Add the pepper.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[0], [], [], [2]]);
    expect(stepIngredients(['פסטה 500 גרם'], ['מוסיפים מעט ממי הפסטה.'])).toEqual([[]]);
  });

  it('keeps words joined by a slash as one name', () => {
    const ingredients = ['3.5 cups pizza/focaccia flour', '3.5 כוסות קמח פיצה / פוקאצ׳ה'];
    expect(stepIngredients(ingredients, ['Set the pizza oven.', 'נותנים לפוקאצ׳ה לתפוח.'])).toEqual([[], []]);
  });

  it('uses a name alone only when it points to one line', () => {
    const ingredients = ['2 tbsp olive oil', '1 tsp sesame oil', '1 cup chicken stock'];
    const steps = ['Heat the oil.', 'Pour in the stock.', 'Drizzle with sesame oil.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [2], [1]]);
  });

  it('never matches a name two lines share', () => {
    const ingredients = ['2 eggs', '1 egg, beaten, for brushing'];
    expect(stepIngredients(ingredients, ['Add the eggs.'])).toEqual([[]]);
  });

  it('does not use vague words such as sauce on their own', () => {
    expect(stepIngredients(['1 cup tomato sauce'], ['Make the sauce.', 'Add the tomato sauce.'])).toEqual([[], [0]]);
  });

  it('splits "salt and pepper" and "or" into separate names', () => {
    const ingredients = ['Salt and pepper', 'butter or margarine'];
    expect(stepIngredients(ingredients, ['Season with pepper.', 'Melt the margarine.'])).toEqual([[0], [1]]);
  });

  it('skips headings and keeps accents from blocking a match', () => {
    const ingredients = ['For the topping:', '200 ml crème fraîche'];
    expect(stepIngredients(ingredients, ['Spread the creme fraiche on top.'])).toEqual([[1]]);
  });

  it('reads Hebrew with joined prefixes and plurals', () => {
    const ingredients = ['2 כוסות קמח', '3 ביצים גדולות', 'בצל אחד קצוץ', '2 שיני שום', '1 כוס סוכר'];
    const steps = ['מערבבים את הקמח עם הביצה.', 'מטגנים את הבצל והשום.', 'מוסיפים סוכר.', 'שמים בתבנית.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[0, 1], [2, 3], [4], []]);
  });

  it('uses the first Hebrew word alone only when it points to one line', () => {
    const ingredients = ['2 כפות שמן זית', 'כף שמן קנולה', '1 כוס חלב'];
    const steps = ['מחממים את השמן.', 'מוסיפים שמן הזית.', 'מוסיפים את החלב.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [0], [2]]);
  });

  it('treats a Hebrew amount with a joined "and" as an amount', () => {
    expect(stepIngredients(['חבילה וחצי רסק עגבניות'], ['מבשלים שעתיים וחצי.', 'מוסיפים רסק עגבניות.'])).toEqual([[], [0]]);
  });

  it('does not read a short Hebrew word inside a longer one', () => {
    expect(stepIngredients(['עלי נענע מצרור שלם'], ['שופכים את הרוטב מעל הבצלים.', 'מוסיפים נענע.'])).toEqual([[], [0]]);
  });

  it('uses water only with the word that says which water', () => {
    const ingredients = ['1 cup boiling water', '1 cup rice'];
    const steps = ['Rinse the rice with water.', 'Add the boiling water.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[1], [0]]);
    expect(stepIngredients(['1/2 cup water'], ['Add the water.'])).toEqual([[]]);
  });

  it('does not use a generic first word such as powder alone', () => {
    const ingredients = ['1 כפית אבקת אפייה', '1 tsp baking powder'];
    expect(stepIngredients(ingredients, ['מפזרים אבקת סוכר.', 'Dust with powder.'])).toEqual([[], []]);
  });

  it('reads the name after a "for the dough:" label', () => {
    const ingredients = ['For the dough: 330 g flour', 'לבצק: 50 גרם סוכר'];
    expect(stepIngredients(ingredients, ['Add the flour.', 'מוסיפים את הסוכר.'])).toEqual([[0], [1]]);
  });

  it('does not read Hebrew verbs or adjectives as ingredients', () => {
    const ingredients = ['¾ כוס שמן קנולה', '1/2 כוס קרם קוקוס'];
    expect(stepIngredients(ingredients, ['משמנים תבנית.', 'מבשלים למרקם קרמי.', 'מוסיפים שמן קנולה.'])).toEqual([[], [], [0]]);
  });

  it('treats a Hebrew joined form as the word, so two cheeses share "גבינה"', () => {
    const ingredients = ['500 גרם גבינה לבנה', '350 גרם מסקרפונה או גבינת שמנת'];
    expect(stepIngredients(ingredients, ['מערבבים את הגבינה.'])).toEqual([[]]);
  });

  it('reads a Hebrew word joined with "and" as the next ingredient, not part of the name', () => {
    const ingredients = ['חלמון ביצה אחד', '1/4 כפית מלח', '397 גרם חלב מרוכז ממותק', '60 מ"ל סירופ גולדן', '200 גרם סוכר חום בהיר'];
    const steps = ['מוסיפים את החלמון והמלח.', 'שמים חלב מרוכז וסירופ גולדן.', 'מוסיפים סוכר חום.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('shows nothing for a name two lines share, such as butter for the base and for the caramel', () => {
    const ingredients = ['225 גרם חמאה (לבסיס)', '100 גרם סוכר דק', '115 גרם חמאה (לקרמל)', '200 גרם סוכר חום'];
    expect(stepIngredients(ingredients, ['טורפים חמאה וסוכר.'])).toEqual([[]]);
  });

  it('does not read a verb as the ingredient of the same name', () => {
    const ingredients = ['80 ml cream', '1/2 cup Lotus spread', 'Coarse salt to sprinkle and freeze'];
    const steps = ['Cream together the butter and sugar.', 'Then spread the cream.', 'Freeze until set.', 'Warm the Lotus spread.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [0], [], [1]]);    expect(stepIngredients(['1 cup flour', '1 tsp baking powder'], ['Mix the flour and baking powder together.'])).toEqual([[0, 1]]);
  });

  it('does not take a dish for the ingredient it is named after', () => {
    const ingredients = ['50 g white chocolate, melted', '100 גרם עוגיות פתי בר', '50 גר׳ שוקולד לבן'];
    const steps = ['Bake the chocolate cake.', 'מוציאים את העוגה מהתנור.', 'אופים עוגת שוקולד.', 'Add the white chocolate.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [], [], [0]]);
  });

  it('does not use a vague first word such as paper, pieces or ice water alone', () => {
    const ingredients = ['נייר כסף', '2-3 כפות מי קרח', '75 גר׳ שברי עוגיות לוטוס', '3 egg whites'];
    const steps = ['מניחים נייר אפייה.', 'מוסיפים מים.', 'מוסיפים שברי שוקולד.', 'Whip until stiff, white, and airy.', 'עוטפים בנייר כסף.'];
    expect(stepIngredients(ingredients, steps)).toEqual([[], [], [], [], [0]]);
  });

  it('does not take "more" as an ingredient', () => {
    expect(stepIngredients(['עוד כמה לימונים שלמים קלופים'], ['מקלפים עוד כמה תפוזים.'])).toEqual([[]]);
  });

  it('reads a Hebrew word with a typographic apostrophe (צ’ילי) as one word', () => {
    const ingredients = ['חצי כפית פתיתי צ’ילי', '1 כף שמן'];
    expect(stepIngredients(ingredients, ['מוסיפים פתיתי צ’ילי.', 'מוסיפים פתיתי שקדים.'])).toEqual([[0], []]);
  });

  it('does not count what a line is for as an ingredient of that line', () => {
    const ingredients = ['60 גרם שיבולת שועל (לפקאנים בקינמון)', '150 גרם פקאנים קצוצים', '1 פיינט אוכמניות'];
    expect(stepIngredients(ingredients, ['מוסיפים פקאנים.', 'שוטפים את האוכמניות.'])).toEqual([[1], [2]]);
  });

  it('gives no matches when the recipe has letters other than English or Hebrew', () => {
    expect(stepIngredients(['2 eggs', '1 كوب سكر'], ['Add the eggs.'])).toEqual([[]]);
    expect(stepIngredients(['2 eggs'], ['Add the eggs 鸡蛋.'])).toEqual([[]]);
  });

  it('handles an empty recipe', () => {
    expect(stepIngredients([], [])).toEqual([]);
    expect(stepIngredients([], ['Mix.'])).toEqual([[]]);
  });
});
