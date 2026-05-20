/**
 * parser.js — Motor de análisis local para problemas de IO
 *
 * Este módulo intenta resolver el problema SIN llamar a ninguna IA.
 * Solo cuando la confianza es baja se delega al backend con IA.
 *
 * Exporta: parseLocal(text) → { resultado, confianza, razon }
 *   - resultado: { modelo, codigo, notas } (puede ser parcial)
 *   - confianza: 0–100 (≥70 = no llamar IA)
 *   - razon: string explicando por qué la confianza es alta/baja
 */

// ─── Patrones de detección ────────────────────────────────────────────────────

const PAT = {
  // Objetivo
  maximizar: /\b(maximiz[ae]r?|max(?:imum)?|m[aá]ximo|ganancia|utilidad|beneficio|ingreso)\b/i,
  minimizar: /\b(minimiz[ae]r?|min(?:imum)?|m[ií]nimo|costo?s?|gasto|distancia|tiempo)\b/i,

  // Variables
  varDecision: /\b([xy]_?\d*[ij]?|[a-z]{1,4}\d{0,2})\s*[=:]\s*(?:n[uú]mero|cantidad|unidades|kg|litros?|horas?|flujo)/gi,
  varNamed:    /\b([xy]\d+|x_[a-z0-9]+|y_?[a-z0-9]+)\b/g,
  varBinaria:  /\b(binari[ao]|y_?\w+\s*[∈∊]\s*\{0[,;]\s*1\}|0\s*[oó]\s*1|si\/no|s[íi]\/no)\b/i,
  varEntera:   /\b(enter[ao]|integer|unidades\s+enteras?|no\s+fraccion)\b/i,

  // Coeficientes y costos
  costo:   /(?:costo?s?|precio|ganancia|beneficio|coef[^:]*)[:\s]+\$?\s*([\d.]+)/gi,
  bigM:    /\b(?:big[-\s]?m|M\s*=\s*([\d,]+)|[\d,]+\s*\*?\s*y_?\w+)\b/i,

  // Restricciones explícitas
  restriccion: /\b(restricci[oó]n|constraint|s\.?\s*a\.?|sujeto\s+a|subject\s+to)\b/i,
  ineqLeq:  /\b\w[\w_]*(?:\s*\+\s*\w[\w_]*)*\s*≤|<=\s*[\d,]+/g,
  ineqGeq:  /\b\w[\w_]*(?:\s*\+\s*\w[\w_]*)*\s*≥|>=\s*[\d,]+/g,
  ineqEq:   /\b\w[\w_]*(?:\s*\+\s*\w[\w_]*)*\s*=\s*[\d,]+/g,
  noNeg:    /\b(no\s+negativ|non[-\s]?negativ|≥\s*0|>=\s*0)\b/i,

  // Tipos de problema por keywords
  transporte:   /\b(transporte|ruta|nodo|flujo|origen|destino|ciudad|envío)\b/i,
  produccion:   /\b(producci[oó]n|f[aá]brica|manufactura|recurso|capacidad|planta)\b/i,
  dieta:        /\b(dieta|nutrici[oó]n|alimento|proteína|grasa|vitamina|calor[íi]a)\b/i,
  inversion:    /\b(inversi[oó]n|portafolio|bono|acci[oó]n|rendimiento|riesgo)\b/i,
  asignacion:   /\b(asignaci[oó]n|assignment|tarea|trabajador|máquina)\b/i,

  // Números
  numero: /\b\d[\d,]*(?:\.\d+)?\b/g,
};

// ─── Extractor de variables ───────────────────────────────────────────────────

function extractVariables(text) {
  const vars = new Set();

  // Patrón 1: x1, x2, x_1, xA31, etc.
  const m1 = text.match(/\b([xy][_]?[a-zA-Z0-9]{0,4})\b/g) || [];
  m1.forEach(v => { if (/\d/.test(v) || v.length <= 4) vars.add(v); });

  // Patrón 2: variables declaradas explícitamente "x₁ = ..."
  const m2 = [...text.matchAll(/([a-zA-Z][_a-zA-Z0-9]{0,5})\s*[=:]\s*(?:n[uú]mero|cantidad|kg|unidades|flujo|pasajeros)/gi)];
  m2.forEach(m => vars.add(m[1]));

  return [...vars].filter(v => v.length >= 2).slice(0, 20);
}

// ─── Extractor de coeficientes y restricciones ────────────────────────────────

function extractConstraints(text) {
  const lines = text.split(/\n/);
  const constraints = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Línea que parece una restricción matemática
    if (/[xy][\w_]*.*[<>≤≥=].*\d/.test(trimmed)) {
      constraints.push(trimmed);
    }
    // Línea con demandas tipo "xA + xB = 1234"
    if (/\w+\s*[\+\-]\s*\w+\s*=\s*\d/.test(trimmed)) {
      constraints.push(trimmed);
    }
  }
  return [...new Set(constraints)].slice(0, 30);
}

// ─── Detección del tipo de objetivo ──────────────────────────────────────────

function detectObjective(text) {
  const isMax = PAT.maximizar.test(text);
  const isMin = PAT.minimizar.test(text);

  if (isMax && !isMin) return 'MAX';
  if (isMin && !isMax) return 'MIN';
  if (isMax && isMin) return 'AMBIGUO'; // Menciona ambos → necesita IA
  return 'DESCONOCIDO';
}

// ─── Detector de tipo de problema ────────────────────────────────────────────

function detectProblemType(text) {
  if (PAT.transporte.test(text))  return 'transporte';
  if (PAT.produccion.test(text))  return 'produccion';
  if (PAT.dieta.test(text))       return 'dieta';
  if (PAT.inversion.test(text))   return 'inversion';
  if (PAT.asignacion.test(text))  return 'asignacion';
  return 'generico';
}

// ─── Generador de modelo matemático (plantilla local) ────────────────────────

function buildModel(parsed) {
  const { objetivo, tipo, variables, constraints, hasBigM, hasBinarias, hasEnteras } = parsed;
  const lines = [];

  // Encabezado
  lines.push(`Tipo de problema: ${tipo.toUpperCase()}`);
  lines.push('');

  // Variables
  if (variables.length > 0) {
    lines.push('VARIABLES DE DECISIÓN:');
    variables.forEach(v => {
      const cat = hasBinarias && v.startsWith('y') ? 'binaria ∈ {0,1}'
                : hasEnteras ? 'entera ≥ 0'
                : 'continua ≥ 0';
      lines.push(`  ${v}: [${cat}]`);
    });
    lines.push('');
  }

  // Función objetivo
  lines.push(`FUNCIÓN OBJETIVO:`);
  if (objetivo !== 'AMBIGUO' && objetivo !== 'DESCONOCIDO') {
    lines.push(`  ${objetivo} Z = Σ cᵢ · xᵢ`);
    lines.push(`  (coeficientes detectados del enunciado — ver código)`);
  } else {
    lines.push(`  [No determinado automáticamente — requiere revisión]`);
  }
  lines.push('');

  // Restricciones extraídas
  if (constraints.length > 0) {
    lines.push('RESTRICCIONES:');
    constraints.forEach((c, i) => lines.push(`  (${i+1}) ${c}`));
    lines.push('');
  }

  // Big-M
  if (hasBigM) {
    lines.push('RESTRICCIONES BIG-M:');
    lines.push('  x_ij ≤ M · y_ij   para cada variable de flujo');
    lines.push('  (M debe ser ≥ máximo posible de x_ij)');
    lines.push('');
  }

  // No negatividad
  lines.push('NO NEGATIVIDAD:');
  if (variables.length > 0) {
    const cont = variables.filter(v => !v.startsWith('y'));
    if (cont.length) lines.push(`  ${cont.join(', ')} ≥ 0`);
  } else {
    lines.push('  xᵢ ≥ 0  para todas las variables continuas');
  }

  return lines.join('\n');
}

// ─── Generador de código Python PuLP (plantilla local) ───────────────────────

function buildCode(parsed) {
  const { objetivo, tipo, variables, constraints, hasBigM, hasBinarias, hasEnteras } = parsed;
  const objPulp = objetivo === 'MAX' ? 'LpMaximize' : 'LpMinimize';
  const lines = [];

  lines.push('from pulp import *');
  lines.push('');
  lines.push(`# Problema: ${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`);
  lines.push(`# Generado localmente con parser IO`);
  lines.push('');
  lines.push(`prob = LpProblem("Problema_IO", ${objPulp})`);
  lines.push('');

  // Variables
  if (variables.length > 0) {
    lines.push('# ── Variables de decisión ──────────────────────────────────────');
    variables.forEach(v => {
      const isBin  = hasBinarias && v.startsWith('y');
      const isInt  = hasEnteras  && !v.startsWith('y');
      const cat    = isBin ? '"Binary"' : isInt ? '"Integer"' : '"Continuous"';
      const bound  = isBin ? '' : ', lowBound=0';
      lines.push(`${v} = LpVariable("${v}"${bound}, cat=${cat})`);
    });
  } else {
    lines.push('# ATENCIÓN: no se detectaron variables con nombres explícitos.');
    lines.push('# Define tus variables aquí:');
    lines.push('# x1 = LpVariable("x1", lowBound=0)');
    lines.push('# x2 = LpVariable("x2", lowBound=0)');
  }
  lines.push('');

  // Función objetivo (placeholder si no se pudo extraer)
  lines.push('# ── Función objetivo ────────────────────────────────────────────');
  if (variables.length >= 2) {
    lines.push(`# Reemplaza los coeficientes (c1, c2, ...) con los del enunciado`);
    const varList = variables.filter(v => !v.startsWith('y')).slice(0, 6);
    const foTerms = varList.map((v, i) => `c${i+1}*${v}`).join(' + ');
    lines.push(`prob += ${foTerms || '0'}, "Funcion_Objetivo"`);
  } else {
    lines.push('prob += 0, "Funcion_Objetivo"  # TODO: agregar términos');
  }
  lines.push('');

  // Restricciones
  lines.push('# ── Restricciones ───────────────────────────────────────────────');
  if (constraints.length > 0) {
    constraints.slice(0, 10).forEach((c, i) => {
      lines.push(`# prob += ${c}, "R${i+1}"`);
    });
    lines.push('# (Descomenta y ajusta las restricciones anteriores)');
  } else {
    lines.push('# TODO: agregar restricciones');
    lines.push('# prob += x1 + x2 <= 100, "Recurso_A"');
  }

  // Big-M
  if (hasBigM) {
    lines.push('');
    lines.push('# ── Restricciones Big-M ─────────────────────────────────────────');
    lines.push('M = 999999  # Ajusta M al máximo posible de tus variables de flujo');
    const xVars = variables.filter(v => !v.startsWith('y'));
    const yVars = variables.filter(v =>  v.startsWith('y'));
    if (xVars.length && yVars.length) {
      xVars.slice(0, yVars.length).forEach((xv, i) => {
        lines.push(`prob += ${xv} <= M * ${yVars[i] || 'y'+i}, "BigM_${xv}"`);
      });
    } else {
      lines.push('# prob += x_ij <= M * y_ij, "BigM_ij"');
    }
  }

  lines.push('');
  lines.push('# ── Resolver ────────────────────────────────────────────────────');
  lines.push('prob.solve(PULP_CBC_CMD(msg=0))');
  lines.push('');
  lines.push('# ── Resultados ──────────────────────────────────────────────────');
  lines.push('print(f"Estado : {LpStatus[prob.status]}")');
  lines.push('print(f"Z óptimo: {value(prob.objective)}")');
  lines.push('for v in prob.variables():');
  lines.push('    print(f"  {v.name} = {v.varValue}")');

  return lines.join('\n');
}

// ─── Función de confianza ─────────────────────────────────────────────────────

function scoreConfianza(parsed) {
  let score = 0;
  const notas = [];

  if (parsed.objetivo !== 'DESCONOCIDO' && parsed.objetivo !== 'AMBIGUO') {
    score += 25;
  } else {
    notas.push('No se pudo determinar si el objetivo es MAX o MIN.');
  }

  if (parsed.variables.length >= 2) {
    score += 25;
  } else {
    notas.push('Se detectaron pocas variables con nombre explícito.');
  }

  if (parsed.constraints.length >= 2) {
    score += 25;
  } else {
    notas.push('Se detectaron pocas restricciones matemáticas.');
  }

  if (parsed.tipo !== 'generico') {
    score += 15;
  }

  if (parsed.hasNoNeg) {
    score += 10;
  }

  return { score, notas };
}

// ─── Función principal exportada ──────────────────────────────────────────────

/**
 * Analiza el texto del problema de IO localmente.
 *
 * @param {string} text — Descripción del problema en lenguaje natural
 * @returns {{ resultado: object, confianza: number, razon: string }}
 */
function parseLocal(text) {
  const parsed = {
    objetivo:    detectObjective(text),
    tipo:        detectProblemType(text),
    variables:   extractVariables(text),
    constraints: extractConstraints(text),
    hasBigM:     PAT.bigM.test(text),
    hasBinarias: PAT.varBinaria.test(text),
    hasEnteras:  PAT.varEntera.test(text),
    hasNoNeg:    PAT.noNeg.test(text),
  };

  const { score, notas: notasConfianza } = scoreConfianza(parsed);

  const modelo = buildModel(parsed);
  const codigo = buildCode(parsed);

  const notasBase = [
    `Tipo detectado: ${parsed.tipo}`,
    `Objetivo detectado: ${parsed.objetivo}`,
    `Variables detectadas: ${parsed.variables.join(', ') || 'ninguna explícita'}`,
    `Restricciones detectadas: ${parsed.constraints.length}`,
    parsed.hasBigM    ? '✓ Restricciones Big-M detectadas' : null,
    parsed.hasBinarias ? '✓ Variables binarias detectadas' : null,
    parsed.hasEnteras  ? '✓ Variables enteras detectadas' : null,
  ].filter(Boolean);

  const notas = [...notasBase, ...notasConfianza].join('\n');

  const razon = score >= 70
    ? `Confianza alta (${score}/100): problema bien estructurado, sin necesidad de IA.`
    : `Confianza baja (${score}/100): problema ambiguo o incompleto → delegando a IA.`;

  return {
    resultado: { modelo, codigo, notas },
    confianza: score,
    razon,
    parsed, // útil para debug o para enriquecer el prompt de IA
  };
}

// Exportar para Node.js (backend) y también disponible en window (si se incluye en frontend)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLocal };
} else if (typeof window !== 'undefined') {
  window.IOParser = { parseLocal };
}
