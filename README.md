# Mantar Dedektifi — iPhone PWA + Google Gemini

Türkçe mushroom discovery PWA that runs in iPhone Safari and can be added to the Home Screen. The server sends 2–5 mushroom photos together to Google Gemini for a visual pre-assessment. GPS coordinates stay out of the AI request.

- Minimum 2, maximum 5 photos per analysis.
- Accepts JPEG, PNG, WebP, HEIC and HEIF.
- Stores discoveries and optional GPS coordinates locally in IndexedDB.
- Includes a discovery map, record archive and per-record location sharing.
- Enforces `edibility=UNVERIFIED`, `consumption_safe=false`, and `recipe=null` server-side.
- Keeps Gemini API key in the server-only `GEMINI_API_KEY` environment variable.

See [README-TR.md](README-TR.md) for complete setup and iPhone installation instructions.

Default model: `gemini-3.8-flash`. API key creation: https://aistudio.google.com/apikey
