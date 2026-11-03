'use strict';
// Bucle de control: lee sensores, evalúa la curva del perfil activo y ordena la velocidad.
// Seguridad: temperatura crítica o sensor perdido => 100 %; al desactivar o salir se devuelve el control a la BIOS.
const { evalCurve } = require('./curve');

const DEFAULTS = { critical: 90, failsafeTicks: 5, rampUp: 40, rampDown: 4, pumpMin: 60 }; // °C, ticks, %/s, %

class Controller {
  constructor(backend, store, opts = {}) {
    this.backend = backend; this.store = store;
    this.o = { ...DEFAULTS, ...opts };
    this.fans = new Map(); // id -> estado interno
    this.last = { sensors: [], fans: [] };
    this.busy = false;
  }

  resolveTemp(source, fan, sensors) {
    const byId = new Map(sensors.map(s => [s.id, s.value]));
    const v = source === 'auto' ? (fan.defaultSource ? byId.get(fan.defaultSource) : undefined) : byId.get(source);
    if (Number.isFinite(v)) return { value: v, sensor: source === 'auto' ? fan.defaultSource : source };
    if (source === 'auto') { // sin sensor asociado: el más caliente
      const temps = sensors.filter(s => Number.isFinite(s.value));
      if (temps.length) { const m = temps.reduce((a, b) => (b.value > a.value ? b : a)); return { value: m.value, sensor: m.id }; }
    }
    return { value: NaN, sensor: source };
  }

  // Retardo: una subida o bajada de temperatura solo cuenta si se mantiene durante "delay" segundos.
  // Sube a la temperatura más baja de la ventana y baja a la más alta, así los picos cortos de la CPU no mueven el ventilador.
  filterTemp(st, temp, delay, dt) {
    st.clock = (st.clock || 0) + dt;
    const s = st.samples || (st.samples = []);
    s.push({ t: st.clock, v: temp });
    while (s.length > 1 && st.clock - s[0].t > delay) s.shift();
    if (!Number.isFinite(st.eff)) st.eff = temp;
    const lo = Math.min(...s.map(x => x.v)), hi = Math.max(...s.map(x => x.v));
    if (lo > st.eff) st.eff = lo; else if (hi < st.eff) st.eff = hi;
    return st.eff;
  }

  async tick(dt = 1) {
    if (this.busy) return;
    this.busy = true;
    try {
      const data = await this.backend.read();
      const profile = this.store.active();
      const status = [];
      for (const fan of data.fans) {
        const st = this.fans.get(fan.id) || { controlled: false, refTemp: NaN, duty: NaN, written: NaN, missing: 0 };
        this.fans.set(fan.id, st);
        const cfg = this.store.fanConfig(profile, fan.id);
        const pump = this.store.isPump(fan.id); // la bomba va siempre al 100 %, sin curva
        const wanted = this.store.globalEnabled && fan.canControl && (pump || (cfg && cfg.enabled));
        const info = { id: fan.id, mode: 'bios', target: null, temp: null, sensor: null, error: st.error || null };
        if (cfg && !pump) { // la temperatura se informa aunque mande la BIOS
          const pre = this.resolveTemp(cfg.source, fan, data.sensors);
          if (Number.isFinite(pre.value)) { info.temp = pre.value; info.sensor = pre.sensor; }
        }
        if (!wanted) {
          if (st.controlled) await this.release(fan.id, st);
          info.mode = 'bios'; info.error = st.error || null;
          status.push(info); continue;
        }
        if (pump) { // sin sensor ni rampa: 100 % fijo
          st.missing = 0; st.duty = 100;
          if (!st.controlled || st.written !== 100) {
            try { await this.backend.setDuty(fan.id, 100); st.written = 100; st.controlled = true; st.error = null; }
            catch (e) { st.error = e.message; }
          }
          info.mode = st.error ? 'error' : 'brisa'; info.target = 100; info.error = st.error || null; info.temp = null; info.sensor = null;
          status.push(info); continue;
        }
        const { value: temp, sensor } = this.resolveTemp(cfg.source, fan, data.sensors);
        info.sensor = sensor;
        let target, mode = 'brisa';
        if (!Number.isFinite(temp)) {
          st.missing++;
          if (st.missing < this.o.failsafeTicks) { status.push({ ...info, mode: st.controlled ? 'brisa' : 'bios' }); continue; } // mantiene el último valor unos ticks
          target = 100; mode = 'failsafe';
        } else {
          st.missing = 0; info.temp = temp;
          if (temp >= this.o.critical) { target = 100; mode = 'failsafe'; st.refTemp = temp; st.eff = temp; st.samples = [{ t: st.clock || 0, v: temp }]; } // sin retardo en emergencias
          else {
            // histéresis: sube al instante, baja solo tras enfriarse "hysteresis" grados
            const eff = this.filterTemp(st, temp, cfg.delay || 0, dt);
            if (!Number.isFinite(st.refTemp) || eff > st.refTemp || st.refTemp - eff >= cfg.hysteresis) st.refTemp = eff;
            target = Math.min(cfg.maxDuty, Math.max(cfg.minDuty, evalCurve(cfg.points, st.refTemp)));
          }
        }
        if (!st.controlled) st.duty = Number.isFinite(fan.duty) ? fan.duty : target;
        if (mode === 'failsafe') st.duty = target;
        else if (target > st.duty) st.duty = Math.min(target, st.duty + this.o.rampUp * dt);
        else st.duty = Math.max(target, st.duty - this.o.rampDown * dt);
        const out = Math.round(st.duty);
        if (!st.controlled || out !== st.written) {
          try { await this.backend.setDuty(fan.id, out); st.written = out; st.controlled = true; st.error = null; }
          catch (e) { st.error = e.message; }
        }
        info.mode = st.error ? 'error' : mode; info.target = Math.round(target); info.error = st.error || null;
        status.push(info);
      }
      for (const id of [...this.fans.keys()]) if (!data.fans.some(f => f.id === id)) this.fans.delete(id); // ventilador desaparecido: sin estado obsoleto
      this.last = { sensors: data.sensors, notes: data.notes || [], fans: data.fans.map(f => ({ ...f, ...status.find(s => s.id === f.id) })) };
    } finally { this.busy = false; }
  }

  async release(id, st = this.fans.get(id)) {
    try { await this.backend.release(id); if (st) { st.controlled = false; st.refTemp = NaN; st.eff = NaN; st.samples = []; st.written = NaN; st.error = null; } }
    catch (e) { if (st) st.error = e.message; }
  }

  async releaseAll() {
    for (const [id, st] of this.fans) if (st.controlled) await this.release(id, st);
  }

  snapshot() { return this.last; }
}

module.exports = { Controller, DEFAULTS };
