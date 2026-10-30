import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ACCOUNT_AUTH_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_ANON_KEY)) {
  throw new Error('Hesap sistemi için SUPABASE_URL ve SUPABASE_ANON_KEY birlikte tanımlanmalı.');
}
if (!/^[a-zA-Z0-9._-]+$/.test(GEMINI_MODEL)) {
  throw new Error('GEMINI_MODEL geçersiz. Yalnızca model adı kullanın.');
}

const allowedImageTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      return cb(new Error('JPG, PNG, WebP veya iPhone HEIC/HEIF fotoğrafı yükleyin.'));
    }
    cb(null, true);
  }
});

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' && !process.env.APP_PASSWORD && !ACCOUNT_AUTH_ENABLED) {
  throw new Error('Production ortamında Supabase hesap sistemi veya APP_PASSWORD yapılandırılmalı.');
}
const sessions = new Map();
const attempts = new Map();
const analysisAttempts = new Map();
const SESSION_COOKIE = 'md_session';

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function isAuthenticated(req) {
  if (!process.env.APP_PASSWORD) return process.env.NODE_ENV !== 'production';
  const token = cookies(req)[SESSION_COOKIE];
  const expiry = token && sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}
async function requireAuth(req, res, next) {
  if (ACCOUNT_AUTH_ENABLED) {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Devam etmek için hesabına giriş yapmalısın.' });
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${match[1]}`
        },
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 401 || response.status === 403) {
        return res.status(401).json({ error: 'Oturumun geçersiz veya süresi dolmuş. Yeniden giriş yap.' });
      }
      if (!response.ok) {
        return res.status(503).json({ error: 'Hesap doğrulama servisine şu anda ulaşılamıyor.' });
      }
      req.user = await response.json();
      if (!req.user?.id) return res.status(401).json({ error: 'Hesap doğrulanamadı.' });
      return next();
    } catch {
      return res.status(503).json({ error: 'Hesap doğrulama servisine bağlanılamadı.' });
    }
  }
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Oturum açmalısın.' });
  next();
}
function tooManyAttempts(ip) {
  const now = Date.now();
  const row = attempts.get(ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > row.reset) { row.count = 0; row.reset = now + 10 * 60 * 1000; }
  row.count++;
  attempts.set(ip, row);
  return row.count > 8;
}
function tooManyAnalyses(ip) {
  const now = Date.now();
  const row = analysisAttempts.get(ip) || { count: 0, reset: now + 60 * 60 * 1000 };
  if (now > row.reset) { row.count = 0; row.reset = now + 60 * 60 * 1000; }
  row.count++;
  analysisAttempts.set(ip, row);
  return row.count > 30;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(express.json({ limit: '32kb' }));

app.get('/api/config', (_req, res) => {
  res.json({
    accountAuthEnabled: ACCOUNT_AUTH_ENABLED,
    supabaseUrl: ACCOUNT_AUTH_ENABLED ? SUPABASE_URL : null,
    supabaseAnonKey: ACCOUNT_AUTH_ENABLED ? SUPABASE_ANON_KEY : null
  });
});
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(process.env.GEMINI_API_KEY),
    protected: ACCOUNT_AUTH_ENABLED || Boolean(process.env.APP_PASSWORD),
    accountAuthEnabled: ACCOUNT_AUTH_ENABLED,
    provider: 'google-gemini',
    model: GEMINI_MODEL
  });
});
app.get('/api/session', (req, res) => {
  if (ACCOUNT_AUTH_ENABLED) {
    return res.json({ accountAuthEnabled: true, authenticated: false, passwordRequired: false });
  }
  res.json({ accountAuthEnabled: false, authenticated: isAuthenticated(req), passwordRequired: Boolean(process.env.APP_PASSWORD) });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Çok fazla deneme yapıldı. 10 dakika sonra tekrar dene.' });
  if (!process.env.APP_PASSWORD) return res.json({ authenticated: true, passwordRequired: false });
  if (!req.body || req.body.password !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Parola yanlış.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 30 * 24 * 60 * 60 * 1000);
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
  res.json({ authenticated: true, passwordRequired: true });
});
app.post('/api/logout', (req, res) => {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

const systemPrompt = `Sen Mantar Dedektifi uygulamasının görsel ön inceleme asistanısın. Mantar türünü fotoğraflardan KESİN teşhis edemezsin. Zehirli ve yenilebilir türler birbirine benzeyebilir; bazı ölümcül zehirli türler yenilebilir türlere çok benzer.

Görev: Birlikte verilen tüm fotoğrafları aynı örneğe ait farklı açılar olarak değerlendir. Görüntüde mantar olup olmadığını belirt. En fazla 3 olası tür adayı ver; yeterli görsel kanıt yoksa aday listesi boş bırakılabilir ve tahmin zorlanmamalıdır. Her adayın Türkçe ve bilimsel adını ver. Güven düzeyi low/medium/high yalnızca görsel benzerliğin niteliğini anlatsın; istatistiksel olasılık veya tüketim güvenliği anlamına gelmez. Her aday için yalnızca fotoğrafta gerçekten görülen ayırt edici özellikleri gerekçe göster; hangi kritik özelliklerin görünmediğini ve hangi bilgilerin ayırt etmeyi zorlaştırdığını açıkça belirt. Tehlikeli benzer türleri yalnızca makul bir benzerlik varsa belirt, emin değilsen uydurma. Fotoğraflar yetersizse bunu öne çıkar ve eksik açıları listele. Fotoğraftan coğrafi yayılış, habitat veya tür doğrulaması uydurma; bölge/habitat verilmediyse bilinmiyor de. Çelişkili özellikler varsa bunu summary ve risk_notes içinde açıkça belirt.

GÜVENLİK KURALLARI:
- edibility alanı her zaman UNVERIFIED olsun.
- consumption_safe her zaman false olsun.
- recipe her zaman null olsun. Yabani bir mantar için tarif veya tüketim önerisi üretme.
- Kaynağı paketli/market kültür mantarı olarak bildirilmiş olsa bile fotoğraftan türün ve ürünün güvenliğini onaylama; genel tarif arayüzde ayrı ve açıkça kültür mantarı için gösterilir.
- Tüketim veya ölümcül zehirlenme riski varsa bunu açık ve öncelikli uyarı olarak belirt.
- Yanıtı yalnızca geçerli JSON olarak, açıklama veya Markdown kod çiti olmadan döndür.

JSON şeması:
{
  "is_mushroom": true,
  "summary": "Türkçe kısa değerlendirme",
  "candidates": [{"common_name":"Türkçe ad veya bilinmiyor","scientific_name":"Latince ad veya bilinmiyor","confidence":"low|medium|high","reasons":["gözlemlenebilir özellik"],"lookalikes":["benzer veya tehlikeli tür"]}],
  "visible_features": {"cap":"şapka","underside":"lamel/gözenek","stem":"sap","base":"taban","habitat_clues":"habitat ipuçları"},
  "missing_views": ["gerekli ek fotoğraf açısı"],
  "risk_notes": ["güvenlik uyarısı"],
  "edibility": "UNVERIFIED",
  "consumption_safe": false,
  "recipe": null
}`;

app.post('/api/analyze', requireAuth, (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (tooManyAnalyses(ip)) return res.status(429).json({ error: 'Bu IP adresinden saatlik analiz sınırına ulaşıldı. Bir süre sonra tekrar dene.' });
  next();
}, upload.array('photos', 5), async (req, res) => {
  try {
    console.log('Analyze request received.');
    const files = req.files || [];
    if (files.length < 2) return res.status(400).json({ error: 'Tanıma için en az 2 farklı açıdan fotoğraf yüklemelisin.' });
    if (files.length > 5) return res.status(400).json({ error: 'En fazla 5 fotoğraf yükleyebilirsin.' });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    console.log('Analyze upload validated:', { photos: files.length, totalBytes });
    if (totalBytes > 18 * 1024 * 1024) {
      return res.status(413).json({ error: 'Fotoğrafların toplam boyutu 18 MB sınırını aşıyor. Daha küçük fotoğraflarla tekrar dene.' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'Gemini görsel analiz servisi henüz yapılandırılmadı. Sunucuda GEMINI_API_KEY tanımlanmalı.' });
    }

    const source = req.body.source === 'packaged' ? 'Paketli/market kültür mantarı olarak kullanıcı tarafından bildirildi' : 'Doğadan toplanmış yabani mantar olarak kullanıcı tarafından bildirildi';
    const parts = [{
      text: `Kullanıcının örnek kaynağı beyanı: ${source}. Yüklenen fotoğrafları birlikte değerlendir. En az iki farklı açı sağlandı. GPS koordinatı bu isteğe dahil edilmedi. Fotoğraflardan kesin tür veya yenilebilirlik teşhisi yapma. ${systemPrompt}`
    }];
    for (const file of files) {
      parts.push({ inline_data: { mime_type: file.mimetype, data: file.buffer.toString('base64') } });
    }

    console.log('Sending image request to Gemini:', { model: GEMINI_MODEL, photos: files.length });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          maxOutputTokens: 4000,
          responseMimeType: 'application/json'
        }
      })
    });

    console.log('Gemini HTTP response:', response.status);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Gemini API hata verdi (${response.status}).`;
      console.error('Gemini API error:', response.status, message);
      const userMessage = response.status === 401 || response.status === 403
        ? 'Gemini API anahtarı geçersiz, yetkisiz veya Gemini API erişimi kısıtlı. Sunucu ayarlarını kontrol et.'
        : response.status === 429
          ? 'Gemini kullanım kotası veya hız sınırına ulaşıldı. Google AI Studio kota bilgilerini kontrol et.'
          : `Gemini görsel analiz servisi yanıt vermedi (${response.status}). Biraz sonra tekrar dene.`;
      return res.status(502).json({ error: userMessage });
    }

    const outputText = (payload.candidates?.[0]?.content?.parts || [])
      .filter(part => typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
    if (!outputText) {
      const reason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || 'Bilinmeyen neden';
      return res.status(502).json({ error: `Gemini analiz yanıtı oluşturamadı (${reason}). Fotoğrafları değiştirip tekrar dene.` });
    }

    console.log('Gemini output details:', { finishReason: payload.candidates?.[0]?.finishReason || 'unknown', outputLength: outputText.length });
    let result;
    try {
      let cleaned = outputText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        result = JSON.parse(cleaned);
      } catch {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error('No JSON object found');
        result = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('JSON root must be an object');
    } catch {
      console.error('Gemini returned non-JSON output.');
      return res.status(502).json({ error: 'Gemini yanıtı beklenen JSON biçiminde değil. Tekrar deneyebilirsin.' });
    }

    // Safety invariants are enforced by the server, not trusted to model wording.
    result.edibility = 'UNVERIFIED';
    result.consumption_safe = false;
    result.recipe = null;
    if (!Array.isArray(result.candidates)) result.candidates = [];
    if (!Array.isArray(result.risk_notes)) result.risk_notes = [];
    result.risk_notes.unshift('Bu sonuç yalnızca fotoğrafa dayalı ön değerlendirmedir. Yabani mantarı tüketme; uzman mikolog veya yetkili tarafından yerinde doğrulat.');

    console.log('Gemini analysis parsed successfully.');
    res.json({ result, provider: 'Google Gemini', model: GEMINI_MODEL });
  } catch (error) {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Her fotoğraf en fazla 8 MB olabilir.' : 'Fotoğraf yükleme sınırını aştın.' });
    }
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini analiz isteği zaman aşımına uğradı. Daha sonra tekrar dene.' });
    }
    console.error('Analyze error:', error.message);
    res.status(500).json({ error: 'Beklenmeyen sunucu hatası. Sunucu kayıtlarını kontrol et.' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Her fotoğraf en fazla 8 MB olabilir.' : 'Fotoğraf yükleme sınırını aştın.' });
  res.status(400).json({ error: err.message || 'İstek işlenemedi.' });
});

app.listen(port, () => console.log(`Mantar Dedektifi hazır: http://localhost:${port}`));
