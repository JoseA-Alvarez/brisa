'use strict';
// Perfiles: los integrados viven en el código (inmutables, siempre se conservan);
// los personalizados se guardan en disco con escritura atómica.
const fs = require('fs');
const path = require('path');
const { validateFanConfig } = require('./curve');

const fan = (points, o = {}) => ({ enabled: true, source: 'auto', points, hysteresis: 3, minDuty: 20, maxDuty: 100, delay: 5, ...o });
const P = (...pairs) => pairs.map(([t, d]) => ({ t, d }));

// Perfiles base; 'default' se aplica a cualquier ventilador sin entrada propia
const BUILTIN = [
  { id: 'silent', name: 'Silencioso', builtin: true, fans: { default: fan(P([30, 20], [50, 25], [65, 40], [75, 60], [85, 100]), { hysteresis: 4, minDuty: 15, delay: 10 }) } },
  { id: 'balanced', name: 'Equilibrado', builtin: true, fans: { default: fan(P([30, 25], [45, 35], [60, 55], [70, 75], [80, 100])) } },
  { id: 'performance', name: 'Rendimiento', builtin: true, fans: { default: fan(P([30, 40], [45, 55], [55, 75], [65, 90], [72, 100]), { hysteresis: 2, minDuty: 35, delay: 3 }) } },
  { id: 'max', name: 'Máximo', builtin: true, fans: { default: fan(P([0, 100], [100, 100]), { hysteresis: 0, minDuty: 100, delay: 0 }) } },
];

const PUMP_IDS = /^\/lpc\/[^/]+\/\d+\/fan\/6$/;
const clone = o => JSON.parse(JSON.stringify(o));
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'perfil';

class ProfileStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'brisa.json');
    this.custom = {};
    this.activeId = 'balanced';
    this.globalEnabled = false; // por seguridad, al instalar no se toma el control hasta que el usuario lo active
    this.hwEnabled = false;     // acceso a placa base: se recuerda y se reactiva al arrancar (Windows pide permiso cada vez)
    this.fanMeta = {};          // id de ventilador -> { name?: string, pump?: boolean }
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, p] of Object.entries(j.custom || {})) {
        if (this.validateProfile(p) === null && !BUILTIN.some(b => b.id === id)) this.custom[id] = { id, name: String(p.name).slice(0, 40), builtin: false, fans: p.fans };
      }
      if (this.get(j.activeId)) this.activeId = j.activeId;
      this.globalEnabled = j.globalEnabled === true;
      this.hwEnabled = j.hardware === true;
      for (const [id, m] of Object.entries(j.fanMeta || {})) {
        if (typeof id !== 'string' || id.length > 200 || !m || typeof m !== 'object') continue;
        const meta = {};
        if (typeof m.name === 'string' && m.name.trim() && m.name.length <= 40) meta.name = m.name.trim();
        if (m.pump === true) meta.pump = true;
        if (Object.keys(meta).length) this.fanMeta[id] = meta;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('Aviso: configuración ilegible, se usan valores por defecto:', e.message); }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ activeId: this.activeId, globalEnabled: this.globalEnabled, hardware: this.hwEnabled, fanMeta: this.fanMeta, custom: this.custom }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  validateProfile(p) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) return 'nombre inválido (1–40 caracteres)';
    if (!p.fans || typeof p.fans !== 'object' || Array.isArray(p.fans)) return 'faltan los ventiladores';
    const keys = Object.keys(p.fans);
    if (!keys.length || keys.length > 64) return 'número de ventiladores inválido';
    for (const k of keys) { const e = validateFanConfig(p.fans[k]); if (e) return `${k}: ${e}`; }
    return null;
  }

  list() { return [...BUILTIN.map(clone), ...Object.values(this.custom).map(clone)]; }
  get(id) { return BUILTIN.find(b => b.id === id) || this.custom[id] || null; }
  active() { return this.get(this.activeId); }

  // Configuración efectiva de un ventilador en un perfil
  fanConfig(profile, fanId) { return profile.fans[fanId] || profile.fans.default || null; }

  uniqueId(name) {
    let id = slug(name), n = 2;
    while (this.get(id)) id = `${slug(name)}-${n++}`;
    return id;
  }

  create(name, fans) {
    const p = { name, fans: clone(fans) };
    const e = this.validateProfile(p);
    if (e) throw new Error(e);
    const id = this.uniqueId(name.trim());
    this.custom[id] = { id, name: name.trim(), builtin: false, fans: p.fans };
    this.save();
    return clone(this.custom[id]);
  }

  update(id, { name, fans }) {
    const cur = this.custom[id];
    if (!cur) throw new Error(this.get(id) ? 'los perfiles integrados no se pueden modificar; usa "Guardar como"' : 'perfil no encontrado');
    const next = { name: name === undefined ? cur.name : name, fans: fans === undefined ? cur.fans : fans };
    const e = this.validateProfile(next);
    if (e) throw new Error(e);
    this.custom[id] = { id, name: next.name.trim(), builtin: false, fans: clone(next.fans) };
    this.save();
    return clone(this.custom[id]);
  }

  remove(id) {
    if (!this.custom[id]) throw new Error(this.get(id) ? 'los perfiles integrados no se pueden borrar' : 'perfil no encontrado');
    delete this.custom[id];
    if (this.activeId === id) this.activeId = 'balanced';
    this.save();
  }

  setActive(id) {
    if (!this.get(id)) throw new Error('perfil no encontrado');
    this.activeId = id; this.save();
  }

  setHardwarePref(v) { this.hwEnabled = !!v; this.save(); }
  setGlobalEnabled(v) { this.globalEnabled = !!v; this.save(); }

  // Nombre propio y marca de bomba de un ventilador (se conservan entre sesiones y perfiles)
  setFanMeta(id, { name, pump }) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('ventilador inválido');
    const cur = { ...(this.fanMeta[id] || {}) };
    if (name !== undefined) {
      if (typeof name !== 'string' || name.length > 40) throw new Error('nombre inválido (máximo 40 caracteres)');
      if (name.trim()) cur.name = name.trim(); else delete cur.name;
    }
    if (pump !== undefined) { if (pump === true) cur.pump = true; else delete cur.pump; }
    if (Object.keys(cur).length) this.fanMeta[id] = cur; else delete this.fanMeta[id];
    this.save();
  }
  // El Fan #7 de la placa (índice 6 del Super I/O) es la bomba de este equipo: siempre se trata como bomba, sin opción de cambiarlo
  isPump(id) { return PUMP_IDS.test(id) || !!(this.fanMeta[id] && this.fanMeta[id].pump); }

  exportCustom() { return { brisa: 1, profiles: Object.values(this.custom).map(p => ({ name: p.name, fans: p.fans })) }; }

  // Importa perfiles personalizados; nunca sobrescribe los existentes (se renombran)
  importCustom(data) {
    if (!data || data.brisa !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 50) throw new Error('archivo de perfiles no válido');
    const bad = data.profiles.map(p => this.validateProfile(p)).find(Boolean);
    if (bad) throw new Error('perfil inválido: ' + bad);
    return data.profiles.map(p => this.create(p.name, p.fans));
  }
}

module.exports = { ProfileStore, BUILTIN };
