# Formulación IO v2 — Generador IA Híbrido

## Arquitectura del sistema

```
Alumno (navegador)
  │
  │  POST /api/generate  { problem: "..." }
  ▼
┌────────────────────────────────────────────────────┐
│  Vercel Serverless  (api/generate.js)              │
│                                                    │
│  [1] Parser Local (parser.js)                      │
│       └─ Regex + plantillas + scoring              │
│       └─ Confianza ≥ 70% → responder directo ✓    │  ← COSTO $0
│       └─ Confianza < 70% → continuar              │
│                                                    │
│  [2] Gemini 2.0 Flash (FREE TIER)                  │
│       └─ 1,500 req/día gratis                      │  ← COSTO $0
│       └─ Falla → continuar                        │
│                                                    │
│  [3] gpt-4.1-mini (fallback)                       │
│       └─ Solo si Gemini falla                      │  ← COSTO ~$0.001
│       └─ Falla → usar resultado parcial del parser │
│                                                    │
│  [4] Parser local como último fallback             │  ← COSTO $0
└────────────────────────────────────────────────────┘
```

**La API key nunca llega al navegador.** El frontend solo ve `/api/generate`.

---

## Estructura del proyecto

```
formulacion-io-v2/
├── api/
│   ├── generate.js    ← Serverless: orquesta parser + IA
│   └── parser.js      ← Motor local de análisis (sin IA)
├── public/
│   └── index.html     ← Frontend (UI original intacta)
├── vercel.json        ← Configuración de Vercel
├── .env.example       ← Plantilla de variables de entorno
├── .gitignore         ← Protege .env de subirse a Git
└── README.md
```

---

## Variables de entorno

| Variable         | Descripción                          | Requerida |
|------------------|--------------------------------------|-----------|
| `GEMINI_API_KEY` | Clave de Google Gemini (free tier)   | Recomendada |
| `OPENAI_API_KEY` | Clave de OpenAI gpt-4.1-mini         | Opcional (fallback) |
| `ALLOWED_ORIGIN` | Dominio CORS en producción           | Opcional |

---

## Por qué Gemini sobre OpenAI para este proyecto

| Criterio                        | Gemini 2.0 Flash | gpt-4.1-mini  |
|---------------------------------|------------------|---------------|
| Free tier diario                | **1,500 req**    | $0 (de pago)  |
| Calidad en código Python/PuLP   | ✅ Muy buena     | ✅ Muy buena  |
| Modelos matemáticos IO          | ✅ Buena         | ✅ Buena      |
| Velocidad de respuesta          | ✅ Muy rápida    | ✅ Rápida     |
| Costo si superas el free tier   | $0.075/1M tokens | $0.40/1M in  |
| Ideal para                      | **Uso principal**| Fallback      |

**Conclusión:** Gemini como principal (gratis), OpenAI como seguro de caída.

---

## Estrategia de costos ≈ $0

```
Escenario típico (100 alumnos, 2 usos por clase):

  Parser local resuelve (estimado 60–70% de los casos):
    200 req × $0        = $0.00

  Gemini resuelve el resto (free tier: 1500 req/día):
    ~80 req × $0        = $0.00

  OpenAI solo en emergencias (Gemini down):
    ~20 req × $0.002    = $0.04

  TOTAL ESTIMADO POR CLASE: $0.00 – $0.05
```

---

## Deployment en Vercel

### Opción A — desde GitHub (recomendada)

```bash
# 1. Inicia un repo en GitHub y sube los archivos
git init
git add .
git commit -m "Formulación IO v2"
git remote add origin https://github.com/TU_USUARIO/formulacion-io
git push -u origin main
```

```
# 2. En vercel.com:
#    Add New Project → importa tu repo → en Environment Variables agrega:
#    GEMINI_API_KEY = AIzaSy...tu_clave...
#    (opcionalmente) OPENAI_API_KEY = sk-proj-...

# 3. Deploy → copia la URL y compártela con tus alumnos.
```

### Opción B — CLI de Vercel

```bash
npm install -g vercel
vercel                   # sigue las instrucciones
vercel env add GEMINI_API_KEY
vercel --prod
```

### Desarrollo local

```bash
cp .env.example .env.local
# Edita .env.local con tus claves reales
npm install -g vercel
vercel dev               # disponible en http://localhost:3000
```

---

## Obtener claves API

### Gemini (GRATIS)
1. Ve a [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Clic en **Create API Key**
3. Copia y pega en `GEMINI_API_KEY`

### OpenAI (opcional, para fallback)
1. Ve a [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. **Create new secret key**
3. Copia y pega en `OPENAI_API_KEY`

---

## Vulnerabilidades corregidas respecto a v1

| Problema original                        | Corrección en v2                              |
|------------------------------------------|-----------------------------------------------|
| API key expuesta en el HTML              | Solo en `process.env` del servidor            |
| Llamada directa a `api.anthropic.com`    | Proxy `/api/generate` — sin CORS              |
| Fallaba con `file://`                    | Ruta relativa, solo funciona en servidor      |
| Sin rate limiting                        | 12 req/min por IP (en memoria)                |
| Sin validación de longitud               | Doble: cliente (JS) + servidor                |
| XSS en notas generadas                   | Escape de `< > & "` en todos los outputs     |
| Timeout infinito                         | `AbortController` 58 s cliente + 55 s server |
| Dependencia total de IA                  | Parser local cubre ~65% de los casos gratis  |
| Costo ilimitado                          | Free tier Gemini cubre hasta 1500 req/día    |
| Sin fallback si IA cae                   | 4 niveles de fallback encadenados            |

---

## Solución de problemas

| Error visible                             | Causa                        | Solución                               |
|-------------------------------------------|------------------------------|----------------------------------------|
| "Error de configuración del servidor"     | Sin claves configuradas      | Agrega `GEMINI_API_KEY` en Vercel      |
| "Demasiadas solicitudes"                  | Rate limit (12 req/min)      | Esperar 1 minuto                       |
| "Tiempo de espera agotado"                | Conexión lenta / Gemini down | Reintentar; el fallback actuará        |
| Modelo incompleto, con TODOs              | Parser local de baja confianza + sin IA | Configura `GEMINI_API_KEY`    |
| Badge "🟢 Generado localmente"            | Normal — sin costo            | No requiere acción                     |
