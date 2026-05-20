/**
 * api/generate.js — Serverless function (Vercel / Node.js)
 *
 * ARQUITECTURA HÍBRIDA:
 *
 *   Frontend
 *     └─→ POST /api/generate { problem }
 *           │
 *           ├─→ [1] Parser local (parser.js)
 *           │        confianza ≥ 70  → responder directo  ← $0 costo
 *           │        confianza < 70  → continuar a IA
 *           │
 *           └─→ [2] Gemini 2.0 Flash (gratis hasta 1500 req/día)
 *                    falla / no config → [3] gpt-4.1-mini fallback
 *
 * Costo estimado: ~$0 para 90%+ de los casos.
 */

const { parseLocal } = require('./parser');

// ─── Configuración ────────────────────────────────────────────────────────────

const CONFIANZA_MINIMA = 70;   // Por debajo de esto, llamar IA
const MAX_INPUT_CHARS  = 6000;
const MIN_INPUT_CHARS  = 20;
const AI_TIMEOUT_MS    = 55_000;
const RATE_WINDOW_MS   = 60_000;
const RATE_MAX_REQ     = 12;   // Por IP por minuto

// ─── Rate limiting en memoria ─────────────────────────────────────────────────

const rateMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const e = rateMap.get(ip);
  if (!e || now - e.ts > RATE_WINDOW_MS) {
    rateMap.set(ip, { ts: now, n: 1 });
    return false;
  }
  if (e.n >= RATE_MAX_REQ) return true;
  e.n++;
  return false;
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// ─── System prompt comprimido para IA ────────────────────────────────────────
// Se envía SOLO cuando el parser local no es suficiente.
// Está redactado de forma concisa para minimizar tokens de entrada.

const SYSTEM_PROMPT = `Eres experto en IO y PuLP. Dado un problema de optimización, genera EXACTAMENTE:

###MODELO###
(modelo matemático: conjuntos, variables, FO, restricciones)
###FIN_MODELO###

###CODIGO###
(código Python funcional con PuLP, comentado, sin bloques \`\`\`)
###FIN_CODIGO###

###NOTAS###
(correcciones y advertencias, una por línea)
###FIN_NOTAS###

Reglas: FO usa solo variables de flujo × costos. Big-M: x_ij ≤ M·y_ij. No negatividad siempre. Si y=2 significa "inactivo", corrige a y=0.`;

// ─── Extractor de secciones ───────────────────────────────────────────────────

function extract(text, tag) {
  const m = text.match(new RegExp(`###${tag}###([\\s\\S]*?)###FIN_${tag}###`, 'i'));
  return m ? m[1].trim() : '';
}

// ─── Escape HTML para evitar XSS ─────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Gemini (Free Tier) ───────────────────────────────────────────────────────

async function callGemini(problem, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY no configurada');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

  const body = {
    contents: [{
      parts: [{ text: `${SYSTEM_PROMPT}\n\n---\nPROBLEMA:\n${problem}` }]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini devolvió una respuesta vacía.');
  return text;
}

// ─── OpenAI gpt-4.1-mini (fallback) ──────────────────────────────────────────

async function callOpenAI(problem, signal) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY no configurada');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: problem },
      ],
    }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error('Respuesta truncada. Simplifica o divide el problema.');
  }

  return data.choices?.[0]?.message?.content || '';
}

// ─── Llamada IA con fallback ──────────────────────────────────────────────────

async function callAI(problem) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    // Intento 1: Gemini (gratis)
    try {
      const text = await callGemini(problem, controller.signal);
      clearTimeout(timer);
      return { text, provider: 'gemini' };
    } catch (geminiErr) {
      console.warn('[generate] Gemini falló, intentando OpenAI:', geminiErr.message);
    }

    // Intento 2: OpenAI fallback
    const text = await callOpenAI(problem, controller.signal);
    clearTimeout(timer);
    return { text, provider: 'openai' };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('La generación tardó demasiado. Intenta con un problema más corto.');
    }
    throw err;
  }
}

// ─── Respuesta JSON estándar ──────────────────────────────────────────────────

function respond(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.status(status).json(body);
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') { respond(res, 200, {}); return; }
  if (req.method !== 'POST')    { respond(res, 405, { error: 'Método no permitido.' }); return; }

  // Rate limit
  if (isRateLimited(getIP(req))) {
    respond(res, 429, { error: 'Demasiadas solicitudes. Espera un minuto.' });
    return;
  }

  // Validar input
  const { problem } = req.body || {};
  if (!problem || typeof problem !== 'string') {
    respond(res, 400, { error: 'Campo "problem" requerido.' });
    return;
  }
  const text = problem.trim();
  if (text.length < MIN_INPUT_CHARS) {
    respond(res, 400, { error: `Descripción muy corta (mínimo ${MIN_INPUT_CHARS} caracteres).` });
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    respond(res, 400, { error: `Descripción muy larga (máximo ${MAX_INPUT_CHARS} caracteres).` });
    return;
  }

  // ── PASO 1: Parser local ───────────────────────────────────────────────────
  const { resultado: localResult, confianza, razon } = parseLocal(text);
  console.log(`[generate] Parser local → confianza: ${confianza}/100 — ${razon}`);

  if (confianza >= CONFIANZA_MINIMA) {
    // Responder sin llamar a ninguna IA
    respond(res, 200, {
      ...localResult,
      meta: { source: 'parser_local', confianza, razon }
    });
    return;
  }

  // ── PASO 2: Verificar que hay al menos una API key configurada ─────────────
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasGemini && !hasOpenAI) {
    // Devolver resultado parcial del parser con advertencia
    const notas = localResult.notas + '\n\n⚠️ NOTA: El servidor no tiene IA configurada. ' +
      'Este modelo fue generado localmente y puede estar incompleto. ' +
      'Configura GEMINI_API_KEY en las variables de entorno para mejorar resultados.';
    respond(res, 200, {
      ...localResult,
      notas,
      meta: { source: 'parser_local_sin_ia', confianza, razon }
    });
    return;
  }

  // ── PASO 3: Llamar a IA ────────────────────────────────────────────────────
  try {
    // Enriquecer el prompt con lo que ya detectó el parser
    const enrichedProblem = text.length > 800
      ? text  // Si el texto es largo, enviarlo directo (el parser ya procesó)
      : `${text}\n\n[Contexto detectado: tipo=${detectType(text)}, objetivo ya identificado]`;

    const { text: aiText, provider } = await callAI(enrichedProblem);

    const modelo = extract(aiText, 'MODELO');
    const codigo = extract(aiText, 'CODIGO');
    const notas  = extract(aiText, 'NOTAS');

    if (!modelo && !codigo) {
      // Fallback: usar resultado del parser + respuesta cruda de IA
      respond(res, 200, {
        modelo: localResult.modelo + '\n\n[IA sin formato esperado — ver notas]',
        codigo: localResult.codigo,
        notas:  `Respuesta de IA sin delimitadores.\n${aiText.slice(0, 500)}`,
        meta:   { source: provider + '_fallback', confianza, razon }
      });
      return;
    }

    respond(res, 200, {
      modelo, codigo, notas,
      meta: { source: provider, confianza, razon }
    });

  } catch (aiErr) {
    console.error('[generate] IA falló:', aiErr.message);

    // Fallback final: resultado del parser local con advertencia
    const notas = localResult.notas +
      `\n\n⚠️ IA no disponible (${esc(aiErr.message)}). ` +
      'Resultado generado localmente — puede requerir ajustes manuales.';

    respond(res, 200, {
      ...localResult,
      notas,
      meta: { source: 'parser_local_ai_fallback', confianza, razon }
    });
  }
}

// Helper para el prompt enriquecido
function detectType(text) {
  if (/transporte|ruta|nodo/i.test(text))  return 'transporte';
  if (/producción|fábrica/i.test(text))    return 'produccion';
  if (/dieta|nutrición/i.test(text))       return 'dieta';
  return 'generico';
}
