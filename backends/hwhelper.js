'use strict';
// Acceso a placa base / CPU mediante el asistente elevado (helper/hw-helper.ps1), solo a demanda.
// Brisa lo lanza con la elevación de Windows (el usuario acepta el aviso UAC) y se comunica por localhost con token.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LIB_DLL = 'LibreHardwareMonitorLib.dll';
// Carpetas donde se busca la biblioteca (por si LOCALAPPDATA no está definido en el entorno de quien lanza Brisa)
const libCandidates = () => [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Brisa', 'LibreHardwareMonitor'),
  path.join(os.homedir(), 'AppData', 'Local', 'Brisa', 'LibreHardwareMonitor'),
  path.join(path.dirname(process.execPath), 'LibreHardwareMonitor'),
].filter(Boolean);
const defaultLib = () => libCandidates().find(d => fs.existsSync(path.join(d, LIB_DLL))) || libCandidates()[0];
const DEFAULT_LIB = defaultLib();
const SCRIPT = path.join(__dirname, '..', 'helper', 'hw-helper.ps1');

// En el .exe el script del asistente va incrustado: se extrae (y se reescribe en cada arranque) junto a la biblioteca
function scriptPath() {
  try {
    const sea = require('node:sea');
    if (!sea.isSea()) return SCRIPT;
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Brisa');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'hw-helper.ps1');
    fs.writeFileSync(f, Buffer.from(sea.getAsset('hw-helper.ps1')));
    return f;
  } catch { return SCRIPT; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class HwHelper {
  // launcher(port, token, libDir, sha) -> Promise: permite sustituir el lanzamiento elevado en pruebas
  constructor({ libDir = null, libSha256 = '', launcher = null, startTimeoutMs = 60000 } = {}) {
    Object.assign(this, { libDir: libDir || defaultLib(), fixedLib: !!libDir, libSha256, startTimeoutMs });
    this.launcher = launcher || HwHelper.launchElevated;
    this.state = 'off';          // off | starting | on | error
    this.message = '';
    this.port = 0; this.token = '';
    this.controls = new Map();   // fanId -> controlId
    this.cache = { sensors: [], fans: [], notes: [] };
    this.lastTouch = 0;
  }

  static launchElevated(port, token, libDir, sha) {
    if (process.platform !== 'win32') return Promise.reject(new Error('el asistente solo existe en Windows'));
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${scriptPath()}"`, '-Port', String(port), '-Token', token, '-LibDir', `"${libDir}"`];
    if (sha) args.push('-LibSha256', sha);
    const cmd = `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${args.map(q).join(',')}`;
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; ps.stderr.on('data', d => { err += d; });
      ps.on('error', reject);
      ps.on('close', code => (code === 0 ? resolve() : reject(new Error(/cancel|canceled|cancelada|operación fue cancelada/i.test(err) ? 'se canceló la solicitud de administrador' : 'no se pudo lanzar el asistente: ' + err.trim().split('\n')[0]))));
    });
  }

  available() {
    if (!this.fixedLib && this.state !== 'on') this.libDir = defaultLib(); // se vuelve a buscar mientras no esté en uso
    return process.platform === 'win32' && fs.existsSync(path.join(this.libDir, LIB_DLL));
  }

  _call(pathname, query = {}, timeoutMs = 4000) {
    const qs = new URLSearchParams(query).toString();
    return new Promise((resolve, reject) => {
      const req = http.get({ host: 'localhost', port: this.port, path: pathname + (qs ? '?' + qs : ''), headers: { 'X-Token': this.token }, timeout: timeoutMs }, res => {
        let s = ''; res.setEncoding('utf8'); res.on('data', c => { s += c; });
        res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('asistente: HTTP ' + res.statusCode)); try { resolve(JSON.parse(s)); } catch { reject(new Error('respuesta inválida')); } });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  async start() {
    if (this.state === 'on' || this.state === 'starting') return;
    if (!this.available()) { this.state = 'error'; this.message = 'No se encuentra la biblioteca de hardware en ' + this.libDir; return; }
    this.state = 'starting'; this.message = 'Esperando la autorización de administrador…';
    this.token = crypto.randomBytes(16).toString('hex');
    try {
      this.port = await freePort();
      await this.launcher(this.port, this.token, this.libDir, this.libSha256);
      const t0 = Date.now();
      for (;;) {
        if (this.state !== 'starting') return; // se canceló mientras esperaba
        try { this._ingest(await this._call('/read', {}, 15000)); this.state = 'on'; this.message = ''; return; }
        catch { if (Date.now() - t0 > this.startTimeoutMs) throw new Error('el asistente no respondió'); await new Promise(r => setTimeout(r, 700)); }
      }
    } catch (e) { this.state = 'error'; this.message = e.message; }
  }

  async stop() {
    const was = this.state;
    this.state = 'off'; this.message = '';
    if (was === 'on' || was === 'starting') { try { await this._call('/quit', {}, 2000); } catch { /* ya cerrado */ } }
    this.controls.clear(); this.cache = { sensors: [], fans: [], notes: [] };
  }

  _ingest(d) {
    this.controls.clear();
    for (const f of d.fans || []) if (f.canControl && f.controlId) this.controls.set(f.id, f.controlId);
    // "Distance to TjMax" no es una temperatura (es el margen hasta el límite del procesador)
    const sensors = (d.sensors || []).filter(s => !/distance to tjmax/i.test(s.name))
      .map(s => ({ id: s.id, name: s.name, value: Math.round(s.value * 10) / 10 }));
    // Sensor por defecto de los ventiladores de placa: temperatura del paquete de la CPU (como hace SignalRGB con la CPU)
    const cpu = sensors.find(s => /cpu\/\d+\/temperature/.test(s.id) && /CPU Package/i.test(s.name))
      || sensors.find(s => /cpu\/\d+\/temperature/.test(s.id) && /Core Max|Core Average/i.test(s.name));
    this.cache = {
      sensors,
      fans: (d.fans || []).map(f => ({ id: f.id, name: f.name, rpm: f.rpm ?? NaN, duty: f.duty == null ? NaN : Math.round(f.duty), canControl: !!f.canControl, defaultSource: cpu ? cpu.id : null })),
      notes: d.notes || [],
    };
  }

  // Lectura con el último dato válido; si el asistente deja de responder pasa a error
  async read() {
    if (this.state !== 'on') return { sensors: [], fans: [], notes: [] };
    try { this._ingest(await this._call('/read')); }
    catch (e) { this.state = 'error'; this.message = 'se perdió la comunicación con el asistente (' + e.message + ')'; return { sensors: [], fans: [], notes: [] }; }
    return this.cache;
  }

  async setDuty(fanId, pct) {
    const cid = this.controls.get(fanId); if (!cid) throw new Error('el ventilador no tiene control');
    await this._call('/set', { id: cid, value: String(Math.round(pct)) });
  }

  async release(fanId) {
    const cid = this.controls.get(fanId); if (!cid || this.state !== 'on') return;
    await this._call('/release', { id: cid });
  }
}

module.exports = { HwHelper, DEFAULT_LIB };
