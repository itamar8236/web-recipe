// Temporary in-memory data layer: nothing is saved, everything resets when the page
// is closed or reloaded. It exposes the same async functions the real backend client
// will have, so replacing the body with fetch() calls later won't touch any component.

const emptyContent = { name: '', ingredients: [], steps: [] };

let nextId = 100;
const newId = () => ++nextId;

function seed() {
  return {
    folders: [
      { id: 1, name: 'Breakfast' },
      { id: 2, name: 'Dinner' },
      { id: 3, name: 'Desserts' },
    ],
    recipes: [
      {
        id: 1,
        folderId: 1,
        link: '',
        favorite: true,
        en: {
          name: 'Shakshuka',
          ingredients: ['4 eggs', '4 ripe tomatoes, chopped', '1 onion, diced', '2 cloves garlic', '1 tsp paprika', 'Olive oil and salt'],
          steps: ['Fry the onion and garlic in olive oil until soft.', 'Add the tomatoes and paprika and simmer for 10 minutes.', 'Make small wells and crack in the eggs.', 'Cover and cook until the whites are set. Serve with bread.'],
        },
        he: {
          name: 'שקשוקה',
          ingredients: ['4 ביצים', '4 עגבניות בשלות קצוצות', 'בצל אחד קצוץ', '2 שיני שום', 'כפית פפריקה', 'שמן זית ומלח'],
          steps: ['מטגנים את הבצל והשום בשמן זית עד שמתרככים.', 'מוסיפים עגבניות ופפריקה ומבשלים 10 דקות.', 'עושים גומות קטנות ושוברים לתוכן את הביצים.', 'מכסים ומבשלים עד שהחלבון מתייצב. מגישים עם לחם.'],
        },
      },
      {
        id: 2,
        folderId: 2,
        // Example of an imported recipe: later this will be the original video link.
        link: 'https://claude.ai',
        favorite: false,
        en: {
          name: 'Lemon Chicken',
          ingredients: ['1 kg chicken thighs', '2 lemons', '4 cloves garlic', '2 tbsp olive oil', 'Thyme, salt and pepper'],
          steps: ['Heat the oven to 200°C.', 'Mix the lemon juice, garlic, oil and spices and coat the chicken.', 'Bake for 40 minutes until golden.'],
        },
        he: {
          name: 'עוף בלימון',
          ingredients: ['קילו שוקי עוף', '2 לימונים', '4 שיני שום', '2 כפות שמן זית', 'טימין, מלח ופלפל'],
          steps: ['מחממים תנור ל-200 מעלות.', 'מערבבים מיץ לימון, שום, שמן ותבלינים ומצפים את העוף.', 'אופים 40 דקות עד שהעוף מזהיב.'],
        },
      },
      {
        id: 3,
        folderId: 3,
        link: '',
        favorite: false,
        en: {
          name: 'Chocolate Mug Cake',
          ingredients: ['4 tbsp flour', '2 tbsp cocoa', '3 tbsp sugar', '3 tbsp milk', '2 tbsp oil'],
          steps: ['Mix everything in a big mug.', 'Microwave for 90 seconds.', 'Let it cool a minute before eating.'],
        },
        he: emptyContent,
      },
    ],
  };
}

let db = seed();

// For tests: start again from a clean state.
export function resetData() {
  db = seed();
}

function cleanLines(lines) {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function cleanContent(content) {
  return {
    name: content.name.trim(),
    ingredients: cleanLines(content.ingredients),
    steps: cleanLines(content.steps),
  };
}

export async function getFolders() {
  return db.folders.map((folder) => ({ ...folder }));
}

export async function createFolder(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name is required');
  const folder = { id: newId(), name: trimmed };
  db.folders.push(folder);
  return { ...folder };
}

export async function renameFolder(id, name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name is required');
  const folder = db.folders.find((f) => f.id === id);
  if (folder) folder.name = trimmed;
}

// Recipes in a deleted folder are kept and become folder-less.
export async function deleteFolder(id) {
  db.folders = db.folders.filter((f) => f.id !== id);
  db.recipes.forEach((recipe) => {
    if (recipe.folderId === id) recipe.folderId = null;
  });
}

export async function getRecipes() {
  return db.recipes.map((recipe) => ({ ...recipe }));
}

export async function getRecipe(id) {
  const recipe = db.recipes.find((r) => r.id === id);
  return recipe ? { ...recipe } : null;
}

// `data` is { folderId, en: {name, ingredients[], steps[]}, he: {...} }.
export async function saveRecipe(id, data) {
  const en = cleanContent(data.en);
  const he = cleanContent(data.he);
  if (!en.name && !he.name) throw new Error('Recipe name is required');
  const fields = { folderId: data.folderId ?? null, en, he };

  const existing = db.recipes.find((r) => r.id === id);
  if (existing) {
    Object.assign(existing, fields);
    return { ...existing };
  }
  const recipe = { id: newId(), link: '', favorite: false, ...fields };
  db.recipes.push(recipe);
  return { ...recipe };
}

export async function toggleFavorite(id) {
  const recipe = db.recipes.find((r) => r.id === id);
  if (recipe) recipe.favorite = !recipe.favorite;
  return recipe ? recipe.favorite : false;
}

export async function deleteRecipe(id) {
  db.recipes = db.recipes.filter((r) => r.id !== id);
}
