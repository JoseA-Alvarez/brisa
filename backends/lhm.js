'use strict';
// Backend EXPERIMENTAL para LibreHardwareMonitor (servidor web remoto, por defecto http://127.0.0.1:8085).
// - Lectura: /data.json (documentado públicamente).
// - Escritura: /Sensor?action=Set|ResetDefault&id=...&value=... — NO verificado contra una instalación real;
//   si LibreHardwareMonitor no lo admite, los ventiladores se muestran como no controlables.
// Solo se aceptan hosts de bucle local.
const http = require('http');

const num = s => { const m = /(-?\d+(?:[.,]\d+)?)/.exec(String(s || '')); return m ? parseFloat(m[1].replace(',', '.')) : NaN; };

function getJson(host, port, path, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => { s += c; if (s.length > 8e6) req.destroy(new Error('respuesta demasiado grande')); });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('JSON inválido')); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function request(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: 2500 }, res => { res.resume(); res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error('HTTP ' + res.statusCode)))); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Recorre el árbol y devuelve hojas con { id, name, unit, value, path }
function flatten(node, trail = [], out = []) {
  const name = node.Text || '';
  const kids = node.Children || [];
  if (!kids.length && node.Value !== undefined) out.push({ sensorId: node.SensorId || null, type: node.Type || null, name, raw: node.Value, path: trail.join(' / ') });
  for (const k of kids) flatten(k, name ? [...trail, name] : trail, out);
  return out;
}

class LhmBackend {
  constructor({ host = '127.0.0.1', port = 8085 } = {}) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('solo se admite LibreHardwareMonitor en la propia máquina');
    this.name = 'LibreHardwareMonitor (experimental)';
    Object.assign(this, { host, port });
    this.controls = new Map(); // fanId -> sensorId del control
    this.writable = true;
  }

  async read() {
    const tree = await getJson(this.host, this.port, '/data.json');
    const leaves = flatten(tree);
    const sensors = [], fans = [], controlByIndex = new Map();
    for (const l of leaves) {
      const sid = l.sensorId || '';
      const type = (l.type || (/\/temperature\//.test(sid) ? 'Temperature' : /\/fan\//.test(sid) ? 'Fan' : /\/control\//.test(sid) ? 'Control' : '')).toLowerCase();
      if (type === 'temperature' || (!type && /°C/.test(l.raw))) sensors.push({ id: sid || l.path + '/' + l.name, name: `${l.path} · ${l.name}`, value: num(l.raw) });
      else if (type === 'control') controlByIndex.set(sid.replace(/\/control\/(\d+)$/, '/#$1'), { sensorId: sid, duty: num(l.raw) });
    }
    for (const l of leaves) {
      const sid = l.sensorId || '';
      const type = (l.type || (/\/fan\//.test(sid) ? 'Fan' : '')).toLowerCase();
      if (type !== 'fan' || !/RPM/i.test(String(l.raw))) continue;
      const ctl = controlByIndex.get(sid.replace(/\/fan\/(\d+)$/, '/#$1')); // mismo índice en el mismo chip
      const id = sid || l.path + '/' + l.name;
      if (ctl) this.controls.set(id, ctl.sensorId);
      fans.push({ id, name: `${l.path} · ${l.name}`, rpm: num(l.raw), duty: ctl ? ctl.duty : NaN, canControl: !!ctl && this.writable, defaultSource: null });
    }
    return { sensors, fans };
  }

  async setDuty(id, pct) {
    const c = this.controls.get(id); if (!c) throw new Error('el ventilador no tiene control');
    try { await request(this.host, this.port, `/Sensor?action=Set&id=${encodeURIComponent(c)}&value=${Math.round(pct)}`); }
    catch (e) { this.writable = false; throw new Error('LibreHardwareMonitor rechazó la escritura (' + e.message + ')'); }
  }

  async release(id) {
    const c = this.controls.get(id); if (!c) return;
    await request(this.host, this.port, `/Sensor?action=ResetDefault&id=${encodeURIComponent(c)}`);
  }

  async close() {}
}

module.exports = { LhmBackend, flatten };
