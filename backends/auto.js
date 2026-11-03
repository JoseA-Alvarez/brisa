'use strict';
// Modo automático: combina varias fuentes de hardware REAL (nunca simuladas).
//  - nativa (siempre): GPU NVIDIA, solo lectura.
//  - asistente propio (a demanda, interruptor "Acceso a placa base"): placa base y CPU con control.
//  - LibreHardwareMonitor ya en marcha (si el usuario lo tiene abierto y no se usa el asistente).
const { LhmBackend } = require('./lhm');
const { NativeBackend } = require('./native');
const { HwHelper } = require('./hwhelper');

class AutoBackend {
  constructor({ lhm = {}, native = new NativeBackend(), helper = new HwHelper(), retryMs = 5000 } = {}) {
    this.lhm = new LhmBackend(lhm);
    this.native = native; this.helper = helper;
    this.retryMs = retryMs; this.nextTry = 0; this.lhmUp = false;
    this.owner = new Map(); // fanId -> backend que lo reportó
    this.name = 'Hardware real';
  }

  hardware() {
    return { available: this.helper.available(), state: this.helper.state, message: this.helper.message };
  }
  setHardware(enabled) { return enabled ? this.helper.start() : this.helper.stop(); }

  async read() {
    const parts = [];
    const nat = await this.native.read(); parts.push([this.native, nat]);
    if (this.helper.state === 'on') {
      const h = await this.helper.read();
      if (this.helper.state === 'on') parts.push([this.helper, h]);
    } else if (Date.now() >= this.nextTry || this.lhmUp) {
      this.nextTry = Date.now() + this.retryMs;
      try { const d = await this.lhm.read(); this.lhmUp = d.fans.length > 0 || d.sensors.length > 0; if (this.lhmUp) parts.push([this.lhm, d]); }
      catch { this.lhmUp = false; }
    }
    const out = { sensors: [], fans: [], notes: [] };
    this.owner.clear();
    for (const [b, d] of parts) {
      out.sensors.push(...d.sensors);
      for (const f of d.fans) { out.fans.push(f); this.owner.set(f.id, b); }
      out.notes.push(...(d.notes || []));
    }
    const board = parts.some(([b]) => b !== this.native);
    if (board) out.notes = out.notes.filter(n => !/placa base y la temperatura de la CPU requieren/.test(n)); // ya cubierto
    if (this.helper.state === 'off' && !this.helper.available()) out.notes.unshift('Acceso a placa base no disponible: no se encuentra la biblioteca de hardware en ' + this.helper.libDir);
    if (this.helper.state === 'error') out.notes.unshift('Acceso a placa base: ' + this.helper.message);
    if (this.helper.state === 'starting') out.notes.unshift('Acceso a placa base: ' + this.helper.message);
    if (!board && this.helper.state === 'off' && this.helper.available()) out.notes.push('Activa "Acceso a placa base" para detectar y controlar los ventiladores de la placa (pide permisos de administrador).');
    this.name = board ? 'Hardware real (placa base + GPU)' : 'Hardware real (solo GPU)';
    return out;
  }

  _own(id) { return this.owner.get(id) || this.native; }
  setDuty(id, pct) { return this._own(id).setDuty(id, pct); }
  release(id) { return this._own(id).release(id); }
  async close() { await this.helper.stop(); await this.lhm.close(); await this.native.close(); }
}

module.exports = { AutoBackend };
