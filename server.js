const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
};

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/extract', async (req, res) => {
  const { url, text } = req.body;
  if (!url && !text) return res.status(400).json({ error: 'URL oder Text fehlt' });

  const platform = detectPlatform(url || '');

  try {
    let recipe = null;

    // ── 1. Instagram: Embed-Seite lesen (kein Login noetig) ──
    if (!recipe && url && platform === 'instagram') {
      recipe = await tryInstagramEmbed(url, platform);
    }

    // ── 2. TikTok: oEmbed-API ──
    if (!recipe && url && platform === 'tiktok') {
      recipe = await tryTikTokOembed(url, platform);
    }

    // ── 3. Normale Webseite: Schema.org + OG-Description ──
    if (!recipe && url) {
      try {
        const pageRes = await fetch(url, { headers: BROWSER_HEADERS, timeout: 10000 });
        if (pageRes.ok) {
          const html = await pageRes.text();
          recipe = extractSchemaRecipe(html, url, platform);
          if (!recipe) {
            const ogText = extractOgText(html);
            if (ogText && ogText.length > 60) {
              recipe = parseRecipeText(ogText, url, platform);
            }
          }
        }
      } catch (_) {}
    }

    // ── 4. Text parsen (OCR oder Copy-Paste) ──
    if (!recipe && text) {
      recipe = parseRecipeText(text, url, platform);
    }

    // ── 5. Social-Media immer noch nichts → klare Fehlermeldung ──
    if (!recipe && (platform === 'instagram' || platform === 'tiktok' || platform === 'facebook')) {
      return res.status(422).json({
        error: 'social_media_blocked',
        platform,
        message: 'Caption konnte nicht gelesen werden. Bitte Caption-Text kopieren oder Screenshot machen.',
      });
    }

    // ── 6. Allgemeiner Fallback ──
    if (!recipe) {
      recipe = generateFromUrl(url, platform);
    }

    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Instagram Embed-Seite ──
async function tryInstagramEmbed(url, platform) {
  try {
    // Shortcode aus URL extrahieren: /p/CODE/, /reel/CODE/, /reels/CODE/
    const shortcodeMatch = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!shortcodeMatch) return null;

    const type = shortcodeMatch[1] === 'p' ? 'p' : 'reel';
    const shortcode = shortcodeMatch[2];

    // Embed-URL: gibt Caption ohne Login zurueck
    const embedUrl = `https://www.instagram.com/${type}/${shortcode}/embed/captioned/`;
    const res = await fetch(embedUrl, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': 'https://www.instagram.com/',
      },
      timeout: 12000,
    });

    if (!res.ok) return null;
    const html = await res.text();

    // Caption aus dem Embed-HTML extrahieren
    const caption = extractInstagramCaption(html);
    if (!caption || caption.length < 30) return null;

    return parseRecipeText(caption, url, platform);
  } catch (_) {
    return null;
  }
}

function extractInstagramCaption(html) {
  // Verschiedene Stellen, wo Instagram die Caption im Embed ablegt
  const patterns = [
    // JSON-Daten im Embed-Script
    /"caption"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    // HTML-Klassen (wechseln, daher mehrere Varianten)
    /class="[^"]*[Cc]aption[^"]*"[^>]*>[\s\S]*?<[^>]+>([\s\S]{20,}?)<\/(?:span|div|p)>/,
    /class="[^"]*PostCaption[^"]*"[\s\S]*?>([\s\S]{20,}?)<\/\w/,
    // OG-Description im Embed
    /<meta[^>]*property="og:description"[^>]*content="([^"]{30,})"/i,
    /<meta[^>]*content="([^"]{30,})"[^>]*property="og:description"/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].trim().length > 20) {
      return decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '\n').replace(/\\n/g, '\n').replace(/\\u[\dA-F]{4}/gi, c => String.fromCharCode(parseInt(c.slice(2), 16))));
    }
  }
  return null;
}

// ── TikTok oEmbed ──
async function tryTikTokOembed(url, platform) {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetch(oembedUrl, { headers: BROWSER_HEADERS, timeout: 8000 });
    if (!res.ok) return null;
    const data = await res.json();
    const text = [data.title, data.author_name].filter(Boolean).join('\n');
    if (text.length < 20) return null;
    return parseRecipeText(text, url, platform);
  } catch (_) {
    return null;
  }
}

// ── OG/Meta-Description aus HTML ──
function extractOgText(html) {
  const patterns = [
    /<meta[^>]*property="og:description"[^>]*content="([^"]{20,})"[^>]*>/i,
    /<meta[^>]*content="([^"]{20,})"[^>]*property="og:description"[^>]*>/i,
    /<meta[^>]*name="description"[^>]*content="([^"]{20,})"[^>]*>/i,
    /<meta[^>]*content="([^"]{20,})"[^>]*name="description"[^>]*>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return decodeHtmlEntities(m[1].replace(/\\n/g, '\n'));
  }
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ── Schema.org JSON-LD aus HTML extrahieren ──
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

// ── Text-Parser (OCR / Copy-Paste / Caption) ──
function parseRecipeText(text, url, platform) {
  const lines = text.split('\n')
    .map(l => l.replace(/^[-*•·\s]+/, '').trim())
    .filter(l => l.length > 1);

  if (lines.length < 2) return null;

  // Titel: erste sinnvolle Zeile (kein Username, keine URL, kein Datum)
  const isSkippableLine = (l) =>
    /^https?:\/\/\S+$/.test(l) ||                        // reine URL
    /^[@_][\w._]{2,}[@_]?$/.test(l) ||                   // @name oder _name_
    /^[a-zA-Z0-9][\w.]*_+$/.test(l) ||                   // endet mit _ (z.B. schmidines_)
    (!l.includes(' ') && /^[a-zA-Z0-9][\w.]{3,}$/.test(l) && (
      /[._]/.test(l) ||                                   // Punkt/Underscore im Wort
      !/[aeiouäöüAEIOUÄÖÜ]/.test(l) ||                  // keine Vokale (z.B. trphltv)
      l.length > 13 ||                                    // sehr langes Wort (z.B. mellisabnehmweg)
      /^q[^u]/i.test(l) ||                               // q + kein u am Anfang (qlfkitchen)
      (/^[bcdfghjklmnpqrstvwxyz]{4}/i.test(l) && !/^sch/i.test(l)) // 4+ Konsonanten (qlfk...)
    )) ||
    /^\d[\d,.]*[KkMm]?\s*(likes?|comments?|views?|Tsd\.?|shares?)/i.test(l) ||
    /^(on|am|vom?)\s+\w+\s+\d/i.test(l);

  // Emoji-Stripping-Helfer (deckt auch ✨ U+2728, ⏱ U+23F1 ab)
  const stripEmoji = s => s
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[☀-➿⏠-⏿■-⛿]/g, '')
    .trim();

  const titleLine = lines.find(l => !isSkippableLine(l)) || lines[0];
  let title = stripEmoji(titleLine.replace(/#\w+/g, ''));

  // Führendes Username-Wort entfernen (z.B. "qlfkitchen Power-Frühstücks-Bowl")
  title = title.replace(/^(\S+)\s+(.+)/, (m, word, rest) => {
    const w = word.toLowerCase();
    const looksLikeUsername =
      /^q[^u]/.test(w) ||
      (!/[aeiouäöü]/.test(w) && word.length >= 4) ||
      (/^[bcdfghjklmnpqrstvwxyz]{4}/i.test(w) && !/^sch/i.test(w));
    return looksLikeUsername ? rest.trim() : m;
  });

  title = title
    .replace(/\s*[·|–]\s*(Instagram|TikTok|Facebook|YouTube|Reels|Shorts).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Rezept';

  const ingredients = [];
  const steps = [];
  let stepNum = 1;
  let section = 'unknown';
  let ingredientMode = false; // true sobald 2+ Zutaten gefunden

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 2) continue;

    // Social-Media-Zeilen, Usernamen und reine URLs ignorieren
    if (/^(#\w|@\w|follow|like|comment|share|save|tag|link in bio)/i.test(line)) continue;
    if (/^https?:\/\/\S+$/.test(line)) continue;
    if (/^[@_][\w._]{2,}[@_]?$/.test(line)) continue;
    if (/^[a-zA-Z0-9][\w.]*_+$/.test(line)) continue;
    if (!line.includes(' ') && /^[a-zA-Z0-9][\w.]{3,}$/.test(line) && (
      /[._]/.test(line) || !/[aeiouäöüAEIOUÄÖÜ]/.test(line) || line.length > 13 ||
      /^q[^u]/i.test(line) || (/^[bcdfghjklmnpqrstvwxyz]{4}/i.test(line) && !/^sch/i.test(line))
    )) continue;
    // Instagram/TikTok Werbe- und Motivationstexte ignorieren
    if (/\b(folg\w*|follow me|abonniere|subscribiere?|fuer\s+mehr|für\s+mehr|for more|link in bio|mehr rezepte|mehr content|transformation|giveaway)\b/i.test(line)) continue;
    if (/\b(habe ich|ich habe|mir gern|trotz\s+\w+|\d+\s*kg\s*(abg|zug)|abgenommen|zugenommen|gewicht\s+verloren)\b/i.test(line)) continue;

    // Nährwert-/Kalorienzeilen ignorieren (würden sonst als Zutaten geparst)
    if (/\d+\s*kcal\b/i.test(line)) continue;

    // Abschnitts-Header erkennen (Emojis erst entfernen: "✨ Zutaten", "🍳 Zubereitung")
    const linePlain = stripEmoji(line);
    if (/^(zutaten|ingredients?|what you need|you.ll need|f[uü]r\s+\d|fuer\s+\d|makes?\s+\d|serves?\s+\d)/i.test(linePlain)) {
      section = 'ingredients'; ingredientMode = true; continue;
    }
    if (/^(zubereitung|anleitung|method|directions?|instructions?|preparation|steps?|how to|so geht|und so)/i.test(linePlain)) {
      section = 'steps'; ingredientMode = false; continue;
    }

    // Non-Food-Metazeilen IMMER überspringen (egal ob ingredientMode oder steps-Sektion)
    if (/^(tipp\b|haltbarkeit|zubereitungszeit|hinweis|lagerung|aufbewahrung|portionen|ergibt\b|haltbar\b|aufbewahrungshinweis|nährwerte?\b|naehrwerte?\b)/i.test(linePlain)) continue;
    // Emoji-Zeile ohne Zahl (z.B. "📦 Haltbarkeit", "⏱ Zubereitungszeit") immer überspringen
    if (/^[\u{1F000}-\u{1FFFF}☀-➿⏠-⏿]/u.test(line) && !/\d/.test(line)) continue;

    const isIng = isIngredient(line);
    const isStep = /^\d+[\.\)]\s+\S/.test(line) ||
      (line.length > 20 && /\b(mix|stir|cook|bake|add|heat|combine|place|cut|chop|dice|slice|mash|blend|grill|fry|boil|simmer|season|pour|fold|whisk|preheat|mischen|kochen|braten|schneiden|geben|erhitzen|vermengen|backen|ruehren|wuerzen|duensten|anbraten|verteilen|servieren|vorheizen|vermischen)\b/i.test(line));

    if (section === 'ingredients') {
      ingredients.push(parseIngredient(line));
    } else if (section === 'steps' || (section === 'unknown' && isStep && !ingredientMode)) {
      ingredientMode = false;
      steps.push(`Schritt ${stepNum++}: ${line.replace(/^\d+[\.\)]\s*/, '')}`);
    } else if (section === 'unknown' && isIng) {
      // Erkannte Zutat (mit Menge/Einheit)
      ingredients.push(parseIngredient(line));
      if (ingredients.length >= 2) ingredientMode = true;
    } else if (ingredientMode && !isStep && line.length < 80) {
      // Ingredient-Modus aktiv: Zeile ohne Menge trotzdem als Zutat (z.B. "Salat")
      ingredients.push(parseIngredient(line));
    } else if (section === 'unknown' && ingredients.length > 0 && !ingredientMode) {
      steps.push(`Schritt ${stepNum++}: ${line.replace(/^\d+[\.\)]\s*/, '')}`);
    }
  }

  // Letzter Versuch: alle Zeilen aufteilen
  if (ingredients.length === 0 && steps.length === 0) {
    for (let i = 1; i < Math.min(lines.length, 30); i++) {
      const l = lines[i];
      if (l.length < 3 || /^#/.test(l) || /^https?:\/\//.test(l)) continue;
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
  const unitPattern = /\d[\d\/.,]*\s*(g|kg|ml|l|cl|dl|EL|TL|tbsp|tsp|cups?|oz|lbs?|lb|Stueck|pcs|Prisen?|pinch|Bund|bunch|Zehen?|cloves?|Scheiben?|slices?|can|dose|Dosen?|Tassen?|Pkg\.?|Packung)\b/i;
  const simpleNum = /^[\d¼-¾⅐-⅟]+[\s\/]*\d*\s+(large|medium|small|whole|fresh|dried|gross|klein|mittel|frisch)\b/i;
  const numIngredient = /^[\d¼-¾]+\s+[a-zA-ZÀ-ž]{2,}/;
  return unitPattern.test(line) || simpleNum.test(line) || numIngredient.test(line);
}

function parseIngredient(text) {
  const unitStr = 'g|kg|ml|l|cl|dl|EL|TL|tbsp|tsp|cups?|oz|lbs?|lb|Stueck|pcs|Prisen?|pinch|Bund|bunch|Zehen?|cloves?|Scheiben?|slices?|can|dose|Dosen?|Tassen?|Pkg\\.?|Packung';
  const m = text.match(new RegExp(`^([\\d\\u00BC-\\u00BE.,\\/\\s]+)?\\s*(${unitStr})?\\s*(.+)`, 'i'));
  const name = m ? m[3].trim().replace(/^(of |von )/i, '') : text.trim();
  const amount = m ? (m[1] || '').trim() : '';
  const unit = m ? (m[2] || '').trim() : '';
  const parsedAmount = parseFloat(amount.replace(',', '.'));
  // Keine Menge angegeben → 100g nur für echte Zutaten, Gewürze bekommen ihren eigenen Cap
  const cal = estimateCalories(name, isNaN(parsedAmount) ? 100 : parsedAmount, unit);
  return { name, amount, unit, ...cal };
}

function estimateCalories(name, amount, unit) {
  const g = toGrams(amount, unit);
  const n = name.toLowerCase();
  // Gewürze & Würzmittel: winzige Mengen, max. 10 g angenommen wenn keine Menge angegeben
  if (/\b(salz|pfeffer|paprikapulver|kurkuma|ingwer|zimt|nelke|kardamom|oregano|basilikum|thymian|rosmarin|koriander|petersilie|schnittlauch|knoblauchpulver|zwiebelpulver|chili|curry\b|kreuzkümmel|kümmel|muskat|cayenne|sumach|safran|würzmischung|gewürz)\b/.test(n)) {
    const spiceG = Math.min(g, 10); // max 10 g bei fehlender Mengenangabe
    return cal(spiceG, 0.3, 0.01, 0.05, 0.01);
  }
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
