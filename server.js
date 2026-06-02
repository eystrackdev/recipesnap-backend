const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });

  const platform = detectPlatform(url);

  const prompt = `Du bist ein Rezept-Extraktions-Assistent. Analysiere diese URL von ${platform} und erstelle ein passendes authentisches Rezept.

URL: ${url}

Nutze alle Informationen aus der URL. Falls keine spezifischen Hinweise vorhanden sind, erstelle ein typisches ${platform}-Rezept.

Nährwerte: Berechne für die GESAMTE Zutatenmenge (nicht pro 100g).

Antworte NUR mit einem validen JSON-Objekt ohne Markdown:
{
  "title": "Rezeptname",
  "description": "Kurze Beschreibung",
  "prepTime": 15,
  "cookTime": 30,
  "servings": 4,
  "imageUrl": null,
  "ingredients": [
    { "name": "Zutat", "amount": "500", "unit": "g", "calories": 825, "protein": 31.0, "carbs": 0.0, "fat": 3.6 }
  ],
  "steps": ["Schritt 1: ...", "Schritt 2: ..."]
}`;

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'API Fehler' });
    }

    const data = await response.json();
    let content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!content) return res.status(500).json({ error: 'Keine Antwort vom KI-Modell' });

    // JSON aus Antwort extrahieren
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      content = content.substring(start, end + 1);
    }

    const recipe = JSON.parse(content);
    recipe.sourceUrl = url;
    recipe.platform = platform;
    recipe.id = Date.now().toString();
    recipe.importedAt = new Date().toISOString();
    recipe.isFavorite = false;

    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function detectPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'facebook';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'web';
}

app.listen(PORT, () => console.log(`RecipeSnap Backend läuft auf Port ${PORT}`));
