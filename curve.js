'use strict';
// Curvas temperatura (°C) -> velocidad (%): validación e interpolación lineal.
const LIMITS = { minPoints: 2, maxPoints: 12, maxTemp: 110, hysteresis: [0, 15], duty: [0, 100], delay: [0, 120] };

function validateCurve(points) {
  if (!Array.isArray(points)) return 'la curva debe ser una lista de puntos';
  if (points.length < LIMITS.minPoints || points.length > LIMITS.maxPoints) return `la curva necesita entre ${LIMITS.minPoints} y ${LIMITS.maxPoints} puntos`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.d)) return `punto ${i + 1} inválido`;
    if (p.t < 0 || p.t > LIMITS.maxTemp) return `punto ${i + 1}: temperatura fuera de 0–${LIMITS.maxTemp} °C`;
    if (p.d < 0 || p.d > 100) return `punto ${i + 1}: velocidad fuera de 0–100 %`;
    if (i > 0) {
      if (p.t <= points[i - 1].t) return `punto ${i + 1}: la temperatura debe ser mayor que la del anterior`;
      // Una curva que baja la velocidad al subir la temperatura enfriaría peor justo cuando más se necesita
      if (p.d < points[i - 1].d) return `punto ${i + 1}: la velocidad no puede bajar al subir la temperatura`;
    }
  }
  return null;
}

function evalCurve(points, temp) {
  if (temp <= points[0].t) return points[0].d;
  const last = points[points.length - 1];
  if (temp >= last.t) return last.d;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (temp <= b.t) return a.d + ((b.d - a.d) * (temp - a.t)) / (b.t - a.t);
  }
  return last.d;
}

// Validación de la configuración de un ventilador dentro de un perfil
function validateFanConfig(c) {
  if (!c || typeof c !== 'object') return 'configuración de ventilador inválida';
  if (typeof c.enabled !== 'boolean') return '"enabled" debe ser booleano';
  if (typeof c.source !== 'string' || !c.source || c.source.length > 200) return 'sensor de origen inválido';
  const e = validateCurve(c.points);
  if (e) return e;
  if (!Number.isFinite(c.hysteresis) || c.hysteresis < LIMITS.hysteresis[0] || c.hysteresis > LIMITS.hysteresis[1]) return `histéresis fuera de ${LIMITS.hysteresis.join('–')} °C`;
  if (!Number.isFinite(c.minDuty) || !Number.isFinite(c.maxDuty) || c.minDuty < 0 || c.maxDuty > 100 || c.minDuty > c.maxDuty) return 'límites mínimo/máximo inválidos';
  if (c.delay !== undefined && (!Number.isFinite(c.delay) || c.delay < LIMITS.delay[0] || c.delay > LIMITS.delay[1])) return `retardo fuera de ${LIMITS.delay.join('–')} s`;
  return null;
}

module.exports = { validateCurve, evalCurve, validateFanConfig, LIMITS };
