const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/extract', async (req, res) => {
  const { url, text } = req.body;
  if (!url && !text) return res.status(400).json({ error: 'URL oder Text fehlt' });

  const platform = detectPlatform(url || '');

  try {
    // Versuche URL zu fetchen und Schema.org Rezeptdaten zu lesen
    let recipe = null;

    if (url) {
      try {
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeSnap/1.0)' },
          timeout: 8000,
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          recipe = extractSchemaRecipe(html, url, platform);
        }
      } catch (_) {}
    }

    // Falls kein Schema gefunden oder Text übergeben: Text parsen
    if (!recipe && text) {
      recipe = parseRecipeText(text, url, platform);
    }

    // Fallback: Rezept aus URL-Keywords generieren
    if (!recipe) {
      recipe = generateFromUrl(url, platform);
    }

    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schema.org JSON-LD Rezept aus HTML extrahieren
function extractSchemaRecipe(html, url, platform) {
  const matches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (!matches) return null;

  for (const match of matches) {
    try {
      const json = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      const data = JSON.parse(json);
      const items = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];

      for (const item of items) {
        if (item['@type'] === 'Recipe' || (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))) {
          return formatSchemaRecipe(item, url, platform);
        }
      }
    } catch (_) {}
  }
  return null;
}

function formatSchemaRecipe(item, url, platform) {
  const ingredients = (item.recipeIngredient || []).map(ing => parseIngredient(ing));
  const steps = (item.recipeInstructions || []).map((s, i) => {
    const text = typeof s === 'string' ? s : (s.text || s.name || '');
    return `Schritt ${i + 1}: ${text}`;
  });

  return {
    id: Date.now().toString(),
    title: item.name || 'Rezept',
    description: item.description || '',
    prepTime: parseDuration(item.prepTime),
    cookTime: parseDuration(item.cookTime || item.totalTime),
    servings: parseInt(item.recipeYield) || 4,
    imageUrl: extractImage(item.image),
    ingredients,
    steps,
    sourceUrl: url,
    platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

// Reziept-Text direkt parsen (aus Copy-Paste)
function parseRecipeText(text, url, platform) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 3) return null;

  const title = lines[0].replace(/[🍴🥗🍕🍝🍜🍲🥘🫕]/g, '').trim() || 'Rezept';
  const ingredients = [];
  const steps = [];
  let stepNum = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isIngredient(line)) {
      ingredients.push(parseIngredient(line));
    } else if (line.length > 15) {
      steps.push(`Schritt ${stepNum++}: ${line.replace(/^\d+[\.\)]\s*/, '')}`);
    }
  }

  if (ingredients.length === 0 && steps.length === 0) return null;

  return {
    id: Date.now().toString(),
    title,
    description: '',
    prepTime: 15,
    cookTime: 30,
    servings: 4,
    imageUrl: null,
    ingredients: ingredients.length > 0 ? ingredients : [{ name: 'Zutaten siehe Original', amount: '', unit: '', calories: 0, protein: 0, carbs: 0, fat: 0 }],
    steps: steps.length > 0 ? steps : ['Rezept aus Originalquelle entnehmen'],
    sourceUrl: url || '',
    platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

// Fallback: Rezept aus URL-Keywords
function generateFromUrl(url, platform) {
  const slug = (url || '').toLowerCase()
    .replace(/https?:\/\/[^/]+/, '')
    .replace(/[^a-z0-9\-]/g, ' ')
    .trim();

  const keywords = slug.split(/\s+/).filter(w => w.length > 3);
  const name = keywords.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Rezept';

  return {
    id: Date.now().toString(),
    title: name || `${platform}-Rezept`,
    description: 'Rezept wurde importiert. Bitte Zutaten und Schritte ergänzen.',
    prepTime: 15,
    cookTime: 30,
    servings: 4,
    imageUrl: null,
    ingredients: [
      { name: 'Zutaten bitte ergänzen', amount: '', unit: '', calories: 0, protein: 0, carbs: 0, fat: 0 }
    ],
    steps: ['Schritte bitte aus dem Original ergänzen'],
    sourceUrl: url || '',
    platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

function isIngredient(line) {
  return /\d+\s*(g|kg|ml|l|EL|TL|cup|oz|lb|Stück|Prise|Bund|Zehe|Scheibe)/i.test(line)
    || /^\d+\s+\w+/.test(line);
}

function parseIngredient(text) {
  const match = text.match(/^([\d,.]+)?\s*(g|kg|ml|l|EL|TL|cup|oz|lb|Stück|Prise|Bund|Zehe|Scheibe)?\s*(.+)/i);
  const name = match ? match[3].trim() : text.trim();
  const amount = match ? (match[1] || '') : '';
  const unit = match ? (match[2] || '') : '';
  const cal = estimateCalories(name, parseFloat(amount) || 100, unit);
  return { name, amount, unit, calories: cal.calories, protein: cal.protein, carbs: cal.carbs, fat: cal.fat };
}

function estimateCalories(name, amount, unit) {
  const grams = toGrams(amount, unit);
  const n = name.toLowerCase();
  // Grobe Nährwertschätzung nach Lebensmitteltyp
  if (/mehl|nudel|reis|pasta|brot|zucker|hafer/.test(n)) return perGram(grams, 3.5, 0.1, 0.75, 0.01);
  if (/butter|öl|fett|sahne/.test(n)) return perGram(grams, 7.0, 0.01, 0.01, 0.8);
  if (/fleisch|hähnchen|rind|schwein|thunfisch|lachs|fisch/.test(n)) return perGram(grams, 1.8, 0.2, 0.0, 0.08);
  if (/milch|joghurt|käse|ei/.test(n)) return perGram(grams, 1.0, 0.07, 0.05, 0.04);
  if (/gemüse|salat|tomate|zwiebel|knoblauch|paprika|zucchini|spinat/.test(n)) return perGram(grams, 0.3, 0.02, 0.05, 0.005);
  if (/obst|apfel|banane|beere|zitrone/.test(n)) return perGram(grams, 0.5, 0.01, 0.12, 0.002);
  return perGram(grams, 1.0, 0.05, 0.15, 0.03);
}

function perGram(g, kcalPer, protPer, carbPer, fatPer) {
  return {
    calories: Math.round(g * kcalPer * 10) / 10,
    protein: Math.round(g * protPer * 10) / 10,
    carbs: Math.round(g * carbPer * 10) / 10,
    fat: Math.round(g * fatPer * 10) / 10,
  };
}

function toGrams(amount, unit) {
  const a = parseFloat(amount) || 100;
  const u = (unit || '').toLowerCase();
  if (u === 'kg') return a * 1000;
  if (u === 'ml' || u === 'l') return u === 'l' ? a * 1000 : a;
  if (u === 'el') return a * 15;
  if (u === 'tl') return a * 5;
  if (u === 'cup') return a * 240;
  if (u === 'oz') return a * 28;
  if (u === 'lb') return a * 454;
  return a;
}

function parseDuration(iso) {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return (parseInt(m[1] || 0) * 60) + parseInt(m[2] || 0);
}

function extractImage(img) {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return img[0]?.url || img[0] || null;
  return img.url || null;
}

function detectPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'facebook';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'web';
}

app.listen(PORT, () => console.log(`RecipeSnap Backend läuft auf Port ${PORT}`));
