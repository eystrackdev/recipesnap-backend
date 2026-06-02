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
    let recipe = null;
    let fetchedHtml = null;

    // 1. Schema.org aus URL lesen (fuer Rezept-Blogs)
    if (url) {
      try {
        const pageRes = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
          },
          timeout: 10000,
        });
        if (pageRes.ok) {
          fetchedHtml = await pageRes.text();
          recipe = extractSchemaRecipe(fetchedHtml, url, platform);

          // 1b. OG-Description lesen (enthaelt oft die Caption / Beschreibung)
          if (!recipe) {
            const ogText = extractOgText(fetchedHtml);
            if (ogText && ogText.length > 60) {
              recipe = parseRecipeText(ogText, url, platform);
            }
          }
        }
      } catch (_) {}
    }

    // 2. Text parsen (OCR oder Copy-Paste)
    if (!recipe && text) {
      recipe = parseRecipeText(text, url, platform);
    }

    // 3. Social-Media ohne Ergebnis: hilfreiche Fehlermeldung
    if (!recipe && (platform === 'instagram' || platform === 'tiktok' || platform === 'facebook')) {
      return res.status(422).json({
        error: 'social_media_blocked',
        platform,
        message: 'Instagram/TikTok/Facebook-Links koennen nicht automatisch gelesen werden. Bitte Caption-Text kopieren oder Screenshot machen.',
      });
    }

    // 4. Fallback fuer andere Seiten
    if (!recipe) {
      recipe = generateFromUrl(url, platform);
    }

    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OG-Description / OG-Title aus HTML lesen (z.B. Instagram Caption)
function extractOgText(html) {
  const patterns = [
    /<meta[^>]*property="og:description"[^>]*content="([^"]{20,})"[^>]*>/i,
    /<meta[^>]*content="([^"]{20,})"[^>]*property="og:description"[^>]*>/i,
    /<meta[^>]*name="description"[^>]*content="([^"]{20,})"[^>]*>/i,
    /<meta[^>]*content="([^"]{20,})"[^>]*name="description"[^>]*>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      return m[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .replace(/\\n/g, '\n');
    }
  }
  return null;
}

// Schema.org JSON-LD aus HTML extrahieren
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
    const t = typeof s === 'string' ? s : (s.text || s.name || '');
    return `Schritt ${i + 1}: ${t}`;
  });
  return {
    id: Date.now().toString(),
    title: item.name || 'Rezept',
    description: item.description || '',
    prepTime: parseDuration(item.prepTime),
    cookTime: parseDuration(item.cookTime || item.totalTime),
    servings: parseInt(item.recipeYield) || 4,
    imageUrl: extractImage(item.image),
    ingredients, steps,
    sourceUrl: url, platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

// Intelligenter Text-Parser (OCR / Copy-Paste)
function parseRecipeText(text, url, platform) {
  // Zeilen bereinigen
  const lines = text.split('\n')
    .map(l => l.replace(/^[-*•·\s]+/, '').trim())
    .filter(l => l.length > 1);

  if (lines.length < 2) return null;

  // Titel: erste nicht-leere Zeile, die keine reine URL ist
  const titleLine = lines.find(l => !/^https?:\/\/\S+$/.test(l)) || lines[0];
  const title = titleLine
    .replace(/#\w+/g, '')
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/\s*[·|–]\s*(Instagram|TikTok|Facebook|YouTube|Reels|Shorts).*$/i, '')
    .trim() || 'Rezept';

  const ingredients = [];
  const steps = [];
  let stepNum = 1;
  let section = 'unknown'; // unknown, ingredients, steps

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 2) continue;

    // Social-Media-Zeilen und reine URLs ignorieren
    if (/^(#\w|@\w|follow|like|comment|share|save|tag|link in bio)/i.test(line)) continue;
    if (/^https?:\/\/\S+$/.test(line)) continue; // reine URL-Zeile ignorieren

    // Abschnitts-Header erkennen
    if (/^(zutaten|ingredients?|what you need|you.ll need|fur [0-9]|fuer [0-9])/i.test(line)) {
      section = 'ingredients'; continue;
    }
    if (/^(zubereitung|anleitung|method|instructions?|preparation|steps?|how to|so geht|und so)/i.test(line)) {
      section = 'steps'; continue;
    }

    const isIng = isIngredient(line);
    const isStep = /^\d+[\.\)]\s+\S/.test(line) ||
      (line.length > 20 && /\b(mix|stir|cook|bake|add|heat|combine|place|cut|chop|dice|slice|mash|blend|grill|fry|boil|simmer|season|pour|fold|whisk|preheat|mischen|kochen|braten|schneiden|geben|erhitzen|vermengen|backen|ruehren|wuerzen|duensten|anbraten|verteilen|servieren|vorheizen|vermischen)\b/i.test(line));

    if (section === 'ingredients' || (section === 'unknown' && isIng && steps.length === 0)) {
      ingredients.push(parseIngredient(line));
    } else if (section === 'steps' || (section === 'unknown' && isStep)) {
      steps.push(`Schritt ${stepNum++}: ${line.replace(/^\d+[\.\)]\s*/, '')}`);
    } else if (section === 'unknown' && ingredients.length > 0) {
      // Nach Zutaten: Rest als Schritte
      steps.push(`Schritt ${stepNum++}: ${line.replace(/^\d+[\.\)]\s*/, '')}`);
    }
  }

  // Letzter Versuch: alle Zeilen aufteilen
  if (ingredients.length === 0 && steps.length === 0) {
    for (let i = 1; i < Math.min(lines.length, 30); i++) {
      const l = lines[i];
      if (l.length < 3 || /^#/.test(l)) continue;
      if (isIngredient(l)) ingredients.push(parseIngredient(l));
      else if (l.length > 8) steps.push(`Schritt ${stepNum++}: ${l.replace(/^\d+[\.\)]\s*/, '')}`);
    }
  }

  return {
    id: Date.now().toString(),
    title,
    description: '',
    prepTime: 15,
    cookTime: 30,
    servings: 4,
    imageUrl: null,
    ingredients: ingredients.length > 0 ? ingredients
      : [{ name: 'Zutaten bitte pruefen', amount: '', unit: '', calories: 0, protein: 0, carbs: 0, fat: 0 }],
    steps: steps.length > 0 ? steps : ['Zubereitung aus dem Original entnehmen'],
    sourceUrl: url || '',
    platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

function generateFromUrl(url, platform) {
  return {
    id: Date.now().toString(),
    title: `${platform}-Rezept`,
    description: 'Tipp: Screenshot-Tab nutzen fuer bessere Ergebnisse!',
    prepTime: 15, cookTime: 30, servings: 4, imageUrl: null,
    ingredients: [{ name: 'Bitte Screenshot-Tab nutzen', amount: '', unit: '', calories: 0, protein: 0, carbs: 0, fat: 0 }],
    steps: ['Screenshot des Rezepts machen → Screenshot-Tab → importieren'],
    sourceUrl: url || '', platform,
    importedAt: new Date().toISOString(),
    isFavorite: false,
  };
}

function isIngredient(line) {
  // Deutsche + englische Einheiten
  const unitPattern = /\d[\d\/.,]*\s*(g|kg|ml|l|cl|dl|EL|TL|tbsp|tsp|cups?|oz|lbs?|lb|Stueck|pcs|Prise|pinch|Bund|bunch|Zehe|clove|Scheibe|slice|can|dose)\b/i;
  const simpleNum = /^[\d¼-¾⅐-⅟]+[\s\/]*\d*\s+(large|medium|small|whole|fresh|dried|gross|klein|mittel|frisch)\b/i;
  const numIngredient = /^[\d¼-¾]+\s+[a-zA-ZÀ-ž]{3,}/;
  return unitPattern.test(line) || simpleNum.test(line) || numIngredient.test(line);
}

function parseIngredient(text) {
  const unitStr = 'g|kg|ml|l|cl|dl|EL|TL|tbsp|tsp|cups?|oz|lbs?|Stueck|pcs|Prise|pinch|Bund|bunch|Zehe|clove|Scheibe|slice';
  const m = text.match(new RegExp(`^([\\d\\u00BC-\\u00BE.,\\/\\s]+)?\\s*(${unitStr})?\\s*(.+)`, 'i'));
  const name = m ? m[3].trim().replace(/^(of |von )/i, '') : text.trim();
  const amount = m ? (m[1] || '').trim() : '';
  const unit = m ? (m[2] || '').trim() : '';
  const cal = estimateCalories(name, parseFloat(amount) || 100, unit);
  return { name, amount, unit, ...cal };
}

function estimateCalories(name, amount, unit) {
  const g = toGrams(amount, unit);
  const n = name.toLowerCase();
  if (/flour|mehl|pasta|noodle|nudel|rice|reis|bread|brot|sugar|zucker|oat|hafer|potato|kartoffel/.test(n)) return cal(g, 3.5, 0.1, 0.75, 0.01);
  if (/butter|oil|oel|fat|fett|cream|sahne|avocado/.test(n)) return cal(g, 7.0, 0.01, 0.01, 0.8);
  if (/chicken|beef|pork|turkey|lamb|tuna|salmon|fish|meat|fleisch|haeh|rind|schwein|lachs|fisch/.test(n)) return cal(g, 1.8, 0.2, 0.0, 0.08);
  if (/milk|milch|yogurt|joghurt|cheese|kaese|feta|egg|ei/.test(n)) return cal(g, 1.0, 0.07, 0.05, 0.04);
  if (/tomato|onion|garlic|pepper|zucchini|spinach|spinat|carrot|karotte|broccoli|cucumber/.test(n)) return cal(g, 0.3, 0.02, 0.05, 0.005);
  if (/apple|banana|berry|lemon|orange|fruit|obst|apfel|banane|beere/.test(n)) return cal(g, 0.5, 0.01, 0.12, 0.002);
  return cal(g, 1.0, 0.05, 0.15, 0.03);
}

function cal(g, k, p, c, f) {
  return {
    calories: Math.round(g * k * 10) / 10,
    protein: Math.round(g * p * 10) / 10,
    carbs: Math.round(g * c * 10) / 10,
    fat: Math.round(g * f * 10) / 10,
  };
}

function toGrams(amount, unit) {
  const a = parseFloat(String(amount).replace(',', '.')) || 100;
  const u = (unit || '').toLowerCase();
  if (u === 'kg') return a * 1000;
  if (u === 'l') return a * 1000;
  if (u === 'tbsp' || u === 'el') return a * 15;
  if (u === 'tsp' || u === 'tl') return a * 5;
  if (u.startsWith('cup')) return a * 240;
  if (u === 'oz') return a * 28;
  if (u.startsWith('lb')) return a * 454;
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

app.listen(PORT, () => console.log(`RecipeSnap Backend laeuft auf Port ${PORT}`));
