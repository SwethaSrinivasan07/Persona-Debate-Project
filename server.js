import express from 'express';
import { createServer } from 'node:http';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '32kb' }));

// Security headers (these override anything the HTML meta tags try to set)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",   // inline scripts in index.html
      "style-src 'self' 'unsafe-inline'",    // inline styles in index.html
      "connect-src 'self'",                  // frontend only talks to /api — never to openai directly
      "img-src 'self' data:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

// ── Static files ─────────────────────────────────────────────────────────────
// Serve index.html, config.js etc. — but NOT config-keys.js (gitignored, never deployed)
app.use(express.static('.', {
  index: 'index.html',
  // Never serve config-keys.js even if it somehow ends up on the server
  setHeaders(res, filePath) {
    if (filePath.endsWith('config-keys.js')) {
      res.status(403).end('Forbidden');
    }
  },
}));

// ── API proxy ─────────────────────────────────────────────────────────────────
app.post('/api/debate', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[/api/debate] OPENAI_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error — API key not set' });
  }

  const { model, input, instructions } = req.body;

  // Basic validation — reject obviously bad payloads
  if (typeof input !== 'string' || input.length === 0 || input.length > 20000) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  if (typeof model !== 'string' || !model.startsWith('gpt-')) {
    return res.status(400).json({ error: 'Invalid model' });
  }

  console.log(`[/api/debate] Request — model: ${model}, input length: ${input.length}`);

  let openAIRes;
  try {
    openAIRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input, instructions, stream: false }),
      signal: AbortSignal.timeout(55_000), // 55s — just under Render's 60s limit
    });
  } catch (networkErr) {
    if (networkErr.name === 'TimeoutError' || networkErr.name === 'AbortError') {
      console.error('[/api/debate] Request to OpenAI timed out');
      return res.status(504).json({ error: 'Request timed out — OpenAI took too long. Try a shorter prompt.' });
    }
    console.error('[/api/debate] Network error reaching OpenAI:', networkErr.message);
    return res.status(502).json({ error: 'Could not reach OpenAI — network error' });
  }

  const body = await openAIRes.text();
  console.log(`[/api/debate] OpenAI response status: ${openAIRes.status}`);
  console.log(`[/api/debate] OpenAI response body length: ${body.length}`);
  console.log(`[/api/debate] OpenAI response body preview: ${body.slice(0, 300)}`);

  // Forward status and body straight through — the frontend already handles error codes
  res.status(openAIRes.status)
     .setHeader('Content-Type', 'application/json')
     .send(body);
});

// ── Start ─────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`Persona Debate server running on port ${PORT}`);
});
