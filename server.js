'use strict';
// Brisa: control de ventiladores. Servidor local (solo 127.0.0.1) + interfaz web.
// Uso: node server.js [--port 8760] [--backend sim|lhm] [--lhm 127.0.0.1:8085] [--data <carpeta>] [--open]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ProfileStore, BUILTIN } = require('./profiles');
const { Controller } = require('./controller');
const { SimBackend } = require('./backends/sim');
const { LhmBackend } = require('./backends/lhm');
const { NativeBackend } = require('./backends/native');
const { AutoBackend } = require('./backends/auto');

function parseArgs(argv) {
  if (argv.includes('--version')) { console.log(VERSION); process.exit(0); }
  const o = { port: 8760, backend: 'auto', lhm: '127.0.0.1:8085', data: null, open: false, tickMs: 1000, simSpeed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = +argv[++i];
    else if (a === '--backend') o.backend = argv[++i];
    else if (a === '--lhm') o.lhm = argv[++i];
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--open') o.open = true;
    else if (a === '--sim-speed') o.simSpeed = +argv[++i];
  }
  if (!o.data) o.data = process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'Brisa') : path.join(os.homedir(), '.brisa');
  return o;
}

// Versión: el .exe la recibe del build; en desarrollo se lee de package.json
const VERSION = globalThis.BRISA_VERSION || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return 'dev'; } })();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');
// Dentro del .exe (Node SEA) la interfaz va incrustada como recurso; en desarrollo se lee de la carpeta public
let sea = null;
try { const m = require('node:sea'); if (m.isSea()) sea = m; } catch { /* no es un ejecutable SEA */ }

function createApp(o, backendOverride) {
  let backend = backendOverride;
  if (!backend) {
    const [h, p] = (o.lhm || '127.0.0.1:8085').split(':');
    const lhmOpts = { host: h, port: +p || 8085 };
    if (o.backend === 'lhm') backend = new LhmBackend(lhmOpts);
    else if (o.backend === 'native') backend = new NativeBackend();
    else if (o.backend === 'sim') { backend = new SimBackend(); backend.start(o.tickMs, o.simSpeed); }
    else backend = new AutoBackend({ lhm: lhmOpts }); // 'auto': solo hardware real
  }
  const store = new ProfileStore(o.data);
  const ctl = new Controller(backend, store, o.controller);
  let loop = null, lastErr = null;

  const runTick = async () => { try { await ctl.tick(o.tickMs / 1000); lastErr = null; } catch (e) { lastErr = e.message; } };
  const startLoop = () => { runTick(); loop = setInterval(runTick, o.tickMs); loop.unref(); };

  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('cuerpo demasiado grande')); req.destroy(); } else ch.push(c); });
    req.on('end', () => resolve(Buffer.concat(ch).toString()));
  });

  const state = () => {
    const snap = ctl.snapshot();
    return {
      version: VERSION, backend: backend.name, hardware: typeof backend.hardware === 'function' ? backend.hardware() : null, simulated: backend instanceof SimBackend, notes: snap.notes || [], error: lastErr,
      globalEnabled: store.globalEnabled, activeId: store.activeId,
      profiles: store.list(), critical: ctl.o.critical,
      sensors: snap.sensors, pumpMin: ctl.o.pumpMin,
      fans: snap.fans.map(f => { const m = store.fanMeta[f.id] || {}; return { ...f, name: m.name || f.name, origName: f.name, pump: store.isPump(f.id) }; }),
    };
  };

  async function api(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/api/state') return send(res, 200, state());
      if (p === '/api/export') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="brisa-perfiles.json"' }); return res.end(JSON.stringify(store.exportCustom(), null, 2)); }
      if (p === '/api/sim' && backend instanceof SimBackend) return send(res, 200, { load: backend.load, temps: backend.temps });
      return send(res, 404, { error: 'no encontrado' });
    }
    // Las peticiones que cambian algo exigen la cabecera X-Brisa: obliga a un preflight CORS, que no se concede
    if (req.headers['x-brisa'] !== '1') return send(res, 403, { error: 'cabecera X-Brisa requerida' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    try {
      let m;
      if (req.method === 'POST' && p === '/api/enabled') {
        store.setGlobalEnabled(body.enabled === true);
        if (!store.globalEnabled) await ctl.releaseAll();
        await runTick();
        return send(res, 200, state());
      }
      if (req.method === 'POST' && p === '/api/fans/meta') { store.setFanMeta(String(body.id), { name: body.name, pump: body.pump }); await runTick(); return send(res, 200, state()); }
      if (req.method === 'POST' && p === '/api/hardware') {
        if (typeof backend.setHardware !== 'function') return send(res, 400, { error: 'este modo no admite acceso a placa base' });
        store.setHardwarePref(body.enabled === true);
        if (body.enabled === true) { backend.setHardware(true); } // espera la autorización UAC en segundo plano
        else { await ctl.releaseAll(); await backend.setHardware(false); }
        return send(res, 200, state());
      }
      if (req.method === 'POST' && p === '/api/active') { store.setActive(String(body.id)); await runTick(); return send(res, 200, state()); }
      if (req.method === 'POST' && p === '/api/profiles') { const c = store.create(String(body.name || ''), body.fans); return send(res, 201, { profile: c, ...state() }); }
      if ((m = /^\/api\/profiles\/([a-z0-9-]+)$/.exec(p))) {
        if (req.method === 'PUT') { store.update(m[1], { name: body.name, fans: body.fans }); await runTick(); return send(res, 200, state()); }
        if (req.method === 'DELETE') { store.remove(m[1]); await runTick(); return send(res, 200, state()); }
      }
      if (req.method === 'POST' && p === '/api/import') { const r = store.importCustom(body); return send(res, 200, { imported: r.length, ...state() }); }
      if (req.method === 'POST' && p === '/api/sim' && backend instanceof SimBackend) {
        for (const k of ['cpu', 'gpu']) if (Number.isFinite(body[k])) backend.load[k] = Math.max(0, Math.min(1, body[k]));
        return send(res, 200, { load: backend.load });
      }
      return send(res, 404, { error: 'no encontrado' });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  const server = http.createServer(async (req, res) => {
    const hostHdr = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostHdr)) { res.writeHead(403); return res.end('prohibido'); }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (sea) {
        let data = null;
        if (rel === 'index.html') { try { data = Buffer.from(sea.getAsset('index.html')); } catch { /* sin recurso */ } }
        if (!data) { res.writeHead(404); return res.end('no encontrado'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(data);
      }
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('no encontrado'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    } catch (e) { send(res, 500, { error: e.message }); }
  });

  // Al cerrar siempre se devuelve el control a la BIOS
  async function shutdown() {
    clearInterval(loop);
    await ctl.releaseAll();
    await backend.close();
    server.close();
  }

  return { server, store, ctl, backend, startLoop, shutdown, runTick };
}

module.exports = { createApp, parseArgs };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  o.tickMs = o.tickMs || 1000;
  if (sea) o.open = true; // el .exe abre el navegador al arrancar
  const app = createApp(o);
  app.startLoop();
  if (app.store.hwEnabled && typeof app.backend.setHardware === 'function') Promise.resolve(app.backend.setHardware(true)).catch(() => {}); // recordado: Windows pedirá permiso
  const openUrl = url => {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  };
  app.server.on('error', async e => { // segundo arranque: ya hay un Brisa abierto, solo se muestra su ventana
    if (e.code !== 'EADDRINUSE') { console.error('Error:', e.message); process.exit(1); }
    console.log(`Brisa ya está abierto en http://localhost:${o.port}`);
    if (o.open) openUrl(`http://localhost:${o.port}`);
    await app.backend.close().catch(() => {}); process.exit(0);
  });
  app.server.listen(o.port, '127.0.0.1', () => {
    const url = `http://localhost:${o.port}`;
    console.log(`Brisa en ${url}  (backend: ${app.backend.name}; datos: ${o.data})`);
    if (o.backend === 'sim') console.log('Modo simulado: no se controla hardware real.');
    else if (o.backend !== 'lhm' && o.backend !== 'native') console.log('Modo automático: LibreHardwareMonitor si está activo; si no, detección nativa de solo lectura.');
    if (o.open) openUrl(url);
  });
  let closing = false;
  const bye = async () => { if (closing) return; closing = true; await app.shutdown(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('SIGBREAK', bye); process.on('SIGHUP', bye);
}
