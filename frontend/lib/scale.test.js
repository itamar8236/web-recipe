import { describe, expect, it } from 'vitest';
import { formatAmount, scaleIngredient } from './scale';

describe('scaleIngredient', () => {
  it('leaves the line as it is at 1×', () => {
    expect(scaleIngredient('2 cups flour', 1)).toBe('2 cups flour');
  });

  it('multiplies whole numbers, decimals, fractions and glyphs', () => {
    expect(scaleIngredient('2 cups flour', 2)).toBe('4 cups flour');
    expect(scaleIngredient('0.5 tsp baking soda', 3)).toBe('1½ tsp baking soda');
    expect(scaleIngredient('1/2 teaspoon pepper', 2)).toBe('1 teaspoon pepper');
    expect(scaleIngredient('1 1/2 cups milk', 2)).toBe('3 cups milk');
    expect(scaleIngredient('½ tsp salt', 3)).toBe('1½ tsp salt');
    expect(scaleIngredient('1½ cups water', 2)).toBe('3 cups water');
  });

  it('multiplies every amount in the line, including ranges and brackets', () => {
    expect(scaleIngredient('3-4 eggs', 2)).toBe('6-8 eggs');
    expect(scaleIngredient('1 cup (140g) flour', 1.5)).toBe('1½ cups (210g) flour');
    expect(scaleIngredient('Juice of 1 orange', 3)).toBe('Juice of 3 oranges');
    expect(scaleIngredient('2 liters broth (2 celery stalks, 1 carrot, 8 thyme sprigs)', 2))
      .toBe('4 liters broth (4 celery stalks, 2 carrots, 16 thyme sprigs)');
  });

  it('reads "1 and 1/2" as one amount', () => {
    expect(scaleIngredient('1 and 1/2 packages tomato paste', 2)).toBe('3 packages tomato paste');
    expect(scaleIngredient('1 ו-1/3 כוסות מים', 2)).toBe('2⅔ כוסות מים');
    expect(scaleIngredient('1+1/3 כוסות שיבולת שועל', 2)).toBe('2⅔ כוסות שיבולת שועל');
    expect(scaleIngredient('4 eggs + 1 yolk', 2)).toBe('8 eggs + 2 yolks');
  });

  it('reads a unit alone after "or", "+" or "minus" as one of it', () => {
    expect(scaleIngredient('כף גדושה שמרים טריים או כפית יבשים', 2)).toBe('2 כפות גדושות שמרים טריים או 2 כפיות יבשים');
    expect(scaleIngredient('4 ביצים + חלמון', 2)).toBe('8 ביצים + 2 חלמונים');
    expect(scaleIngredient('3 כפות קקאו+חצי כפית סודה', 2)).toBe('6 כפות קקאו+1 כפית סודה');
    expect(scaleIngredient('50 מ"ל (רבע כוס פחות כף) מים', 2)).toBe('100 מ"ל (½ כוס פחות 2 כפות) מים');
    expect(scaleIngredient('6 גרם (כפית וחצי) שמרים', 2)).toBe('12 גרם (3 כפיות) שמרים');
    expect(scaleIngredient('375 גרם ביסקוויטים (שרוול וחצי)', 2)).toBe('750 גרם ביסקוויטים (3 שרוולים)');
    expect(scaleIngredient('Salt or pepper', 2)).toBe('Salt or pepper');
    expect(scaleIngredient('Spices: half teaspoon cinnamon, quarter teaspoon ginger, pinch of cloves', 2))
      .toBe('Spices: 1 teaspoon cinnamon, ½ teaspoon ginger, 2 pinches of cloves');
    expect(scaleIngredient('תבלינים: מלח, פלפל שחור, כפית אורגנו', 2)).toBe('תבלינים: מלח, פלפל שחור, 2 כפיות אורגנו');
    expect(scaleIngredient('כוס וחצי / קופסה אחת קטנה (400 גרם)', 2)).toBe('3 כוסות / 2 קופסאות קטנות (800 גרם)');
    expect(scaleIngredient('Salt, pepper, cut into cubes', 2)).toBe('Salt, pepper, cut into cubes');
    expect(scaleIngredient('3 cups beans (soft, can be frozen)', 2)).toBe('6 cups beans (soft, can be frozen)');
    expect(scaleIngredient('Can of tomatoes', 2)).toBe('2 cans of tomatoes');
    expect(scaleIngredient('2 ליטר ציר (1 גזר, ענף רוזמרין)', 2)).toBe('4 ליטר ציר (2 גזרים, 2 ענפי רוזמרין)');
  });

  it('marks a line whose only amount is in words it can\'t rewrite', () => {
    expect(scaleIngredient('מיץ מלימון אחד', 2)).toBe('מיץ מלימון אחד (×2)');
    expect(scaleIngredient('גרידה מחצי ליים', 3)).toBe('גרידה מחצי ליים (×3)');
    expect(scaleIngredient('Juice of half a lemon', 1.5)).toBe('Juice of half a lemon (×1½)');
    expect(scaleIngredient('Juice of a whole lemon', 2)).toBe('Juice of a whole lemon (×2)');
    expect(scaleIngredient('Whole wheat flour', 2)).toBe('Whole wheat flour');
  });

  it('makes a unit plural or singular for the new amount', () => {
    expect(scaleIngredient('1 cup sugar', 2)).toBe('2 cups sugar');
    expect(scaleIngredient('2 cups sugar', 0.5)).toBe('1 cup sugar');
    expect(scaleIngredient('1 level tablespoon cumin', 3)).toBe('3 level tablespoons cumin');
    expect(scaleIngredient('1 כוס סוכר', 2)).toBe('2 כוסות סוכר');
    expect(scaleIngredient('2 כפות דבש', 0.5)).toBe('1 כף דבש');
    expect(scaleIngredient('2 שיני שום', 0.5)).toBe('1 שן שום');
    expect(scaleIngredient('1 large egg', 2)).toBe('2 large eggs');
    expect(scaleIngredient('1 egg yolk', 2)).toBe('2 egg yolks');
    expect(scaleIngredient('1 egg white', 2)).toBe('2 egg white');
    expect(scaleIngredient('1 ביצה L', 3)).toBe('3 ביצים L');
    expect(scaleIngredient('1 whole lemon', 2)).toBe('2 whole lemons');
    expect(scaleIngredient('2 lemons', 0.5)).toBe('1 lemon');
    expect(scaleIngredient('2 green onion stalks', 2)).toBe('4 green onion stalks');
    expect(scaleIngredient('1 lemon zest', 2)).toBe('2 lemon zest');
    expect(scaleIngredient('1 בצל בינוני', 2)).toBe('2 בצלים בינוניים');
    expect(scaleIngredient('קליפה מגוררת מ-1 תפוז', 2)).toBe('קליפה מגוררת מ-2 תפוזים');
    expect(scaleIngredient('1 בצל סגול', 2)).toBe('2 בצל סגול');
    expect(scaleIngredient('25 פלפל צ\'ילי חריף', 2)).toBe('50 פלפל צ\'ילי חריף');
    expect(scaleIngredient('1 מיכל (250 מ״ל) שמנת', 2)).toBe('2 מיכלים (500 מ״ל) שמנת');
    expect(scaleIngredient('קמצוץ קטן של צ\'ילי', 2)).toBe('2 קמצוצים קטנים של צ\'ילי');
    expect(scaleIngredient('* Tiny pinch chili flakes', 2)).toBe('* 2 tiny pinches chili flakes');
  });

  it('reads a line that starts with a unit as one of it', () => {
    expect(scaleIngredient('cup of flour', 2)).toBe('2 cups of flour');
    expect(scaleIngredient('Pinch of salt', 3)).toBe('3 pinches of salt');
    expect(scaleIngredient('Generous handful of dill', 2)).toBe('2 generous handfuls of dill');
    expect(scaleIngredient('קילו עגבניות שרי', 1.5)).toBe('1½ קילו עגבניות שרי');
    expect(scaleIngredient('200 גרם (כוס) סוכר', 2)).toBe('400 גרם (2 כוסות) סוכר');
    expect(scaleIngredient('1 can tomatoes (can be frozen)', 2)).toBe('2 cans tomatoes (can be frozen)');
    expect(scaleIngredient('כפית קורנפלור', 2)).toBe('2 כפיות קורנפלור');
    expect(scaleIngredient('* cup of flour', 2)).toBe('* 2 cups of flour');
    expect(scaleIngredient('לקרם: גביע שמנת חמוצה', 2)).toBe('לקרם: 2 גביעים שמנת חמוצה');
  });

  it('reads amounts written as words at the start', () => {
    expect(scaleIngredient('A pinch of salt', 2)).toBe('2 pinches of salt');
    expect(scaleIngredient('half a cup of oil', 3)).toBe('1½ cups of oil');
    expect(scaleIngredient('חצי כפית סודה לשתייה', 2)).toBe('1 כפית סודה לשתייה');
    expect(scaleIngredient('שליש כוס שמן זית', 3)).toBe('1 כוס שמן זית');
    expect(scaleIngredient('כף וחצי צלפים', 2)).toBe('3 כפות צלפים');
    expect(scaleIngredient('1 ורבע כוסות שמנת', 2)).toBe('2½ כוסות שמנת');
    expect(scaleIngredient('שלושת רבעי כוס קמח', 2)).toBe('1½ כוסות קמח');
    expect(scaleIngredient('כפית שטוחה מלח', 2)).toBe('2 כפיות שטוחות מלח');
    expect(scaleIngredient('2 כפיות שטוחות מלח', 0.5)).toBe('1 כפית שטוחה מלח');
  });

  it('leaves lines with no amount, percentages, degrees and sizes alone', () => {
    expect(scaleIngredient('Salt to taste', 2)).toBe('Salt to taste');
    expect(scaleIngredient('ביצים רכות', 2)).toBe('ביצים רכות');
    expect(scaleIngredient('בצל סגול', 2)).toBe('בצל סגול');
    expect(scaleIngredient('Red onion, sliced', 2)).toBe('Red onion, sliced');
    expect(scaleIngredient('4 וחצי כוסות קמח (2 עוגות בקוטר 24 ס״מ)', 2)).toBe('9 כוסות קמח (4 עוגות בקוטר 24 ס״מ)');
    expect(scaleIngredient('8 פרוסות בשר בעובי 1 וחצי ס"מ', 2)).toBe('16 פרוסות בשר בעובי 1 וחצי ס"מ');
    expect(scaleIngredient('ביצה טרופה להברשה', 2)).toBe('2 ביצים טרופות להברשה');
    expect(scaleIngredient('A little olive oil', 2)).toBe('A little olive oil');
    expect(scaleIngredient('100 g chocolate (60% cocoa)', 2)).toBe('200 g chocolate (60% cocoa)');
    expect(scaleIngredient('4 tortillas (25 cm)', 2)).toBe('8 tortillas (25 cm)');
    expect(scaleIngredient('1.5 ס"מ ג\'ינג\'ר', 2)).toBe('3 ס"מ ג\'ינג\'ר');
    expect(scaleIngredient('Vitamin B12 drops', 2)).toBe('Vitamin B12 drops');
    expect(scaleIngredient('500 g cheese (16-32% fat)', 2)).toBe('1000 g cheese (16-32% fat)');
    expect(scaleIngredient('250 g lentils, soaked for 6-8 hours', 2)).toBe('500 g lentils, soaked for 6-8 hours');
    expect(scaleIngredient('3 lbs chicken, cut into 1-inch pieces', 2)).toBe('6 lbs chicken, cut into 1-inch pieces');
  });
});

describe('formatAmount', () => {
  it('rounds to a readable amount', () => {
    expect(formatAmount(2)).toBe('2');
    expect(formatAmount(1 / 3)).toBe('⅓');
    expect(formatAmount(2.75)).toBe('2¾');
    expect(formatAmount(3 / 8)).toBe('⅜');
    expect(formatAmount(1 / 6)).toBe('⅙');
    expect(formatAmount(2.4)).toBe('2.4');
    expect(formatAmount(562.5)).toBe('563');
  });
});
