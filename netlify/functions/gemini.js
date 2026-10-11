/* TestPaper Pro — server-side Gemini proxy (Netlify Function)
   ---------------------------------------------------------------
   WHY: the API key must never appear in the page source or in git
   (GitHub secret scanning blocks it, and a public key gets abused).
   The key lives ONLY in Netlify: Site configuration → Environment
   variables → GEMINI_API_KEY. Browsers call this function; this
   function calls Google. Teachers need zero setup.

   OPTIONAL HARDENING: set ALLOWED_ORIGINS (comma separated, e.g.
   "https://my-site.netlify.app,https://testpaper.example.com") to
   reject calls from other websites.
*/

const ALLOWED_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  // GET = health check (handy for "Test AI" style checks and deploys)
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, service: 'gemini-proxy', configured: !!process.env.GEMINI_API_KEY });
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PUT') return json(405, { ok: false, error: 'Use POST' });

  // optional origin allowlist
  const allowed = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const h = event.headers || {};
  const origin = h.origin || h.referer || '';
  if (allowed.length && origin && !allowed.some((a) => origin.includes(a))) {
    return json(403, { ok: false, error: 'Origin not allowed' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json(500, {
      ok: false,
      error: 'Proxy is missing GEMINI_API_KEY — set it in Netlify (Site configuration → Environment variables) and redeploy'
    });
  }

  // Capture Paper sends base64 photos; keep requests inside Lambda payload limits
  if (event.body && event.body.length > 5500000) {
    return json(413, { ok: false, error: 'Request too large — use up to 4 smaller photos' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'gemini-3.5-flash-lite';
  const prompt = String(body.prompt || '').slice(0, 24000);
  const systemPrompt = String(body.systemPrompt || '').slice(0, 4000);
  if (!prompt.trim()) return json(400, { ok: false, error: 'Empty prompt' });

  // optional vision parts (Capture Paper): up to 4 base64 images before the text
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  const vparts = images
    .filter((im) => im && typeof im.mime_type === 'string' && typeof im.data === 'string' && im.data.length <= 2000000)
    .map((im) => ({ inline_data: { mime_type: im.mime_type, data: im.data } }));
  vparts.push({ text: prompt });

  const payload = {
    contents: [{ role: 'user', parts: vparts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      let msg = 'Gemini HTTP ' + r.status;
      try { msg = (await r.json()).error.message || msg; } catch (e) {}
      // never echo the key back to the browser
      msg = String(msg).replace(new RegExp(key, 'g'), '[redacted]');
      return json(r.status >= 500 ? 502 : r.status, { ok: false, status: r.status, error: msg });
    }

    const data = await r.json();
    const parts = ((((data.candidates || [])[0] || {}).content || {}).parts) || [];
    const text = parts.filter((p) => p && p.text && p.thought !== true).map((p) => p.text).join('\n').trim();
    if (!text) {
      const reason = (((data.promptFeedback || {}).blockReason) || 'empty reply');
      return json(502, { ok: false, error: 'Gemini returned no text (' + reason + ')' });
    }
    return json(200, { ok: true, text, model });
  } catch (e) {
    return json(502, { ok: false, error: 'Proxy network error: ' + (e && e.message) });
  }
};
