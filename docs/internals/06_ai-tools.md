# AI tools

Translate, calories and protein, and ingredient substitutes, all in the "AI tools" box on a
recipe's page, never in the edit form (`src/translate.js`, `src/nutrition.js`,
`src/substitute.js`). Endpoints: [API → AI tools](./01_api.md#ai-tools). Scanning the link
again is an import ([Import](./04_import.md)).

## What they share

- **One plain request, not a Workflow**: the user waits for it, and text-only calls take
  seconds. No video or link is sent.
- **The endpoints store no recipe.** Each answers, and the page saves the result itself with
  a normal recipe `POST`/`PUT` (translate, calories) or only shows it (substitutes). So
  they work on manual recipes too, but need an account.
- **Models**: `LLM_TRANSLATE_MODELS` then the fallback, no model choice and no per-user
  limit; each answer takes one request from the shared daily count. When every model was
  only busy, the whole list is tried again after short waits ([Models → Busy models](./05_models.md#busy-models)).
- **A request row** in `llm_requests` with its `purpose` (`translation`, `nutrition`,
  `substitution`), inserted before the call as `running`, then `done` or `failed` with its
  `error`, `recipe_id` set when sent, and the answering model. The recipe text itself is
  never stored there. These rows never show as import cards and don't count toward the
  import caps.
- **The answer is untrusted** and checked before it's used; a failed check is `bad_result`.

## Translation

The page sends the language shown; the answer is the other language. It must pass the same
checks as a recipe's text, have a name when the original had one, and have **exactly as many
ingredients and steps**, so a dropped or merged line is never saved.

## Calories and protein

The model works step by step: each ingredient with its grams, calories and protein (counting
a main ingredient the steps use but the list leaves out), then the recipe's totals and its
servings (the recipe's own, or a typical one). **The backend divides** the totals by the
servings: a small model tested on real recipes came out much closer this way than when asked
for one number. Servings must be in a sane range and each per-serving number rounded and
within a recipe's limits. The recipe needs at least one ingredient (`no_ingredients`).

## Ingredient substitutes

The user taps one ingredient; the answer is up to 4 substitutes (`name`, `amount`, `note`),
best first, in the app's language. **Nothing is saved**: the page shows them in a popup and
forgets them when it closes. The prompt holds the whole recipe, so the model knows what the
ingredient does in the dish. The small model handles this short reasoning well, and the
stronger models' few daily requests stay for videos and photos. Each field is trimmed and
cut, entries with no name are dropped, and an empty list is a valid answer ("nothing would
work").

## Known gaps and accepted trade-offs

- The servings are the calories estimate's weak spot: when a recipe doesn't say, the model
  guesses, and a wrong guess changes both numbers in proportion.
