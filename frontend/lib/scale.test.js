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
    expect(scaleIngredient('Juice of 1 orange', 3)).toBe('Juice of 3 orange'); // nouns that aren't units stay as written
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
  });

  it('reads a line that starts with a unit as one of it', () => {
    expect(scaleIngredient('cup of flour', 2)).toBe('2 cups of flour');
    expect(scaleIngredient('Pinch of salt', 3)).toBe('3 pinches of salt');
    expect(scaleIngredient('Generous handful of dill', 2)).toBe('2 Generous handfuls of dill');
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
