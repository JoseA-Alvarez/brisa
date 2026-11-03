'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { validateCurve, evalCurve } = require('../curve');
const { ProfileStore, BUILTIN } = require('../profiles');
const { Controller } = require('../controller');
const { SimBackend } = require('../backends/sim');
const { LhmBackend } = require('../backends/lhm');
const { createApp } = require('../server');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok -', m); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brisa-'));
const P = (...a) => a.map(([t, d]) => ({ t, d }));

(async () => {
  // ---- curvas ----
  const c = P([30, 20], [50, 40], [70, 100]);
  ok(evalCurve(c, 40) === 30 && evalCurve(c, 10) === 20 && evalCurve(c, 99) === 100, 'interpolación lineal y extremos fijos');
  ok(validateCurve(c) === null, 'curva válida aceptada');
  ok(validateCurve(P([30, 50], [40, 20])) !== null, 'curva que baja al subir la temperatura rechazada');
  ok(validateCurve(P([30, 20], [30, 40])) !== null, 'temperaturas repetidas rechazadas');
  ok(validateCurve(P([30, 20])) !== null && validateCurve(P([30, 120], [40, 130])) !== null, 'pocos puntos y valores fuera de rango rechazados');
  ok(validateCurve([{ t: NaN, d: 1 }, { t: 2, d: 3 }]) !== null, 'NaN rechazado');

  // ---- perfiles ----
  const dir = tmp();
  let store = new ProfileStore(dir);
  ok(store.list().filter(p => p.builtin).length === BUILTIN.length && BUILTIN.length === 4, '4 perfiles integrados');
  ok(store.globalEnabled === false, 'el control arranca desactivado por seguridad');
  const base = store.get('balanced').fans;
  const mine = store.create('Mi perfil', base);
  ok(mine.id === 'mi-perfil' && !mine.builtin, 'perfil personalizado creado');
  ok(store.create('Mi perfil', base).id === 'mi-perfil-2', 'nombre repetido genera id único');
  let threw = false; try { store.update('silent', { name: 'x' }); } catch { threw = true; }
  ok(threw, 'perfil integrado no modificable');
  threw = false; try { store.remove('balanced'); } catch { threw = true; }
  ok(threw && store.get('balanced'), 'perfil integrado no borrable');
  const edited = clone(base); edited.default.points = P([20, 30], [60, 60], [80, 100]);
  store.update('mi-perfil', { fans: edited });
  store.setActive('mi-perfil'); store.setGlobalEnabled(true);
  store = new ProfileStore(dir);
  ok(store.get('mi-perfil').fans.default.points[1].d === 60 && store.activeId === 'mi-perfil' && store.globalEnabled, 'perfiles, activo y estado persisten tras reiniciar');
  fs.writeFileSync(path.join(dir, 'brisa.json'), '{ roto');
  ok(new ProfileStore(dir).list().length === 4, 'archivo corrupto no rompe: quedan los integrados');
  const imp = store.importCustom({ brisa: 1, profiles: [{ name: 'Mi perfil', fans: base }] });
  ok(imp[0].id !== 'mi-perfil' && store.get('mi-perfil'), 'importación no sobrescribe (se renombra)');
  threw = false; try { store.importCustom({ brisa: 1, profiles: [{ name: 'x', fans: { default: { enabled: true } } }] }); } catch { threw = true; }
  ok(threw, 'importación de perfil inválido rechazada');

  // ---- controlador sobre el simulador ----
  const sd = tmp(); const s = new ProfileStore(sd);
  const sim = new SimBackend(); sim.temps.cpu = 50; sim.temps.gpu = 50;
  const ctl = new Controller(sim, s);
  await ctl.tick(1);
  ok(!sim.fans.cpu_fan.controlled, 'con control global desactivado no se toca ningún ventilador');
  s.setGlobalEnabled(true); s.setActive('balanced');
  for (let i = 0; i < 40; i++) await ctl.tick(1);
  const expect = Math.round(evalCurve(s.get('balanced').fans.default.points, 50));
  ok(sim.fans.cpu_fan.controlled && Math.abs(sim.fans.cpu_fan.duty - expect) <= 1, `sigue la curva (50 °C -> ${expect} %)`);
  // histéresis: baja 2 °C (< 3) y no debe cambiar
  const before = sim.fans.cpu_fan.duty; sim.temps.cpu = 48; await ctl.tick(1);
  ok(sim.fans.cpu_fan.duty === before, 'la histéresis evita cambios por bajadas pequeñas');
  sim.temps.cpu = 44; for (let i = 0; i < 40; i++) await ctl.tick(1);
  ok(sim.fans.cpu_fan.duty < before, 'baja la velocidad al enfriarse más que la histéresis');
  // rampa de subida limitada
  sim.temps.cpu = 78; sim.temps.gpu = 30; await ctl.tick(1);
  ok(sim.fans.cpu_fan.duty < 100, 'la rampa limita la subida por tick');
  // temperatura crítica
  sim.temps.cpu = 95; await ctl.tick(1);
  ok(sim.fans.cpu_fan.duty === 100 && ctl.snapshot().fans.find(f => f.id === 'cpu_fan').mode === 'failsafe', 'temperatura crítica => 100 % inmediato (failsafe)');
  // sensor perdido
  const broken = new SimBackend(); const realRead = broken.read.bind(broken);
  broken.read = async () => { const d = await realRead(); d.sensors = []; return d; };
  const s2 = new ProfileStore(tmp()); s2.setGlobalEnabled(true);
  const ctl2 = new Controller(broken, s2, { failsafeTicks: 3 });
  for (let i = 0; i < 4; i++) await ctl2.tick(1);
  ok(broken.fans.cpu_fan.duty === 100, 'sin sensor tras N ticks => 100 %');
  // configuración por ventilador y desactivar
  const custom = clone(s.get('balanced').fans); custom.cpu_fan = { ...custom.default, enabled: false };
  s.create('Sin CPU', custom); s.setActive('sin-cpu');
  await ctl.tick(1);
  ok(!sim.fans.cpu_fan.controlled && sim.fans.cpu_fan.duty === sim.fans.cpu_fan.auto && sim.fans.case_fan.controlled, 'desactivar un ventilador lo devuelve a la BIOS sin afectar a los demás');
  s.setGlobalEnabled(false); await ctl.releaseAll();
  ok(Object.values(sim.fans).every(f => !f.controlled), 'desactivar el control global libera todos los ventiladores');
  // error de escritura no detiene el bucle
  s.setGlobalEnabled(true); s.setActive('balanced');
  sim.setDuty = async () => { throw new Error('sin permisos'); };
  await ctl.tick(1);
  ok(ctl.snapshot().fans[0].mode === 'error' && /sin permisos/.test(ctl.snapshot().fans[0].error), 'error de escritura se informa sin romper el bucle');

  // ---- simulador térmico: más velocidad => más fresco ----
  const a = new SimBackend(), b = new SimBackend();
  a.fans.cpu_fan.duty = 20; b.fans.cpu_fan.duty = 100; a.load.cpu = b.load.cpu = 0.8;
  for (let i = 0; i < 300; i++) { a.step(1); b.step(1); }
  ok(a.temps.cpu > b.temps.cpu + 10, 'modelo térmico: ventilador rápido enfría más');

  // ---- API HTTP ----
  const o = { data: tmp(), tickMs: 20, simSpeed: 1, backend: 'sim' };
  const app = createApp(o); app.startLoop();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = (method, p, body, headers = { 'X-Brisa': '1' }, host) => new Promise((resolve, reject) => {
    const d = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(d ? { 'Content-Type': 'application/json' } : {}), ...headers, ...(host ? { Host: host } : {}) } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ code: res.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() })); });
    req.on('error', reject); if (d) req.write(d); req.end();
  });
  let st = (await call('GET', '/api/state')).json;
  ok(st.fans.length === 3 && st.profiles.length === 4 && st.globalEnabled === false, 'API: estado inicial (3 ventiladores, 4 perfiles, control apagado)');
  ok((await call('POST', '/api/enabled', { enabled: true }, {})).code === 403, 'API: POST sin X-Brisa rechazado (anti CSRF)');
  st = (await call('POST', '/api/enabled', { enabled: true })).json;
  ok(st.globalEnabled === true, 'API: activar control global');
  await new Promise(r => setTimeout(r, 150));
  st = (await call('GET', '/api/state')).json;
  ok(st.fans.every(f => f.mode === 'brisa' || f.mode === 'failsafe'), 'API: ventiladores bajo control de Brisa');
  const created = await call('POST', '/api/profiles', { name: 'Gaming', fans: st.profiles.find(p => p.id === 'performance').fans });
  ok(created.code === 201 && created.json.profile.id === 'gaming', 'API: crear perfil personalizado');
  ok((await call('PUT', '/api/profiles/gaming', { fans: { default: { enabled: true, source: 'auto', points: P([40, 50], [30, 60]), hysteresis: 2, minDuty: 10, maxDuty: 100 } } })).code === 400, 'API: curva inválida rechazada con 400');
  ok((await call('PUT', '/api/profiles/silent', { name: 'x' })).code === 400, 'API: modificar integrado rechazado');
  ok((await call('POST', '/api/active', { id: 'gaming' })).json.activeId === 'gaming', 'API: activar perfil');
  ok((await call('DELETE', '/api/profiles/gaming')).json.activeId === 'balanced', 'API: borrar el activo vuelve a Equilibrado');
  ok((await call('GET', '/api/state', null, {}, 'evil.example')).code === 403, 'API: Host ajeno rechazado');
  ok((await call('GET', '/..%2f..%2fserver.js', null, {})).code !== 200, 'sin salida de la carpeta pública');
  await call('POST', '/api/enabled', { enabled: false });
  ok(Object.values(app.backend.fans).every(f => !f.controlled), 'API: desactivar libera los ventiladores');
  await call('POST', '/api/enabled', { enabled: true }); await new Promise(r => setTimeout(r, 100));
  await app.shutdown();
  ok(Object.values(app.backend.fans).every(f => !f.controlled), 'al cerrar se devuelve el control a la BIOS');

  // ---- backend LibreHardwareMonitor contra un servidor falso (formato supuesto, no verificado) ----
  const sets = [];
  const fake = http.createServer((req, res) => {
    if (req.url.startsWith('/data.json')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ Text: 'Sensor', Children: [{ Text: 'PC', Children: [{ Text: 'Placa', Children: [
        { Text: 'Temperaturas', Children: [{ Text: 'CPU', Value: '45,5 °C', SensorId: '/lpc/x/0/temperature/0', Type: 'Temperature', Children: [] }] },
        { Text: 'Ventiladores', Children: [{ Text: 'Fan #1', Value: '1200 RPM', SensorId: '/lpc/x/0/fan/1', Type: 'Fan', Children: [] }] },
        { Text: 'Controles', Children: [{ Text: 'Fan #1', Value: '40,0 %', SensorId: '/lpc/x/0/control/1', Type: 'Control', Children: [] }] },
      ] }] }] }));
    }
    sets.push(req.url); res.end('ok');
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const lhm = new LhmBackend({ port: fake.address().port });
  const d = await lhm.read();
  ok(d.sensors[0].value === 45.5 && d.fans[0].rpm === 1200 && d.fans[0].duty === 40 && d.fans[0].canControl, 'LHM: parseo de temperaturas, RPM y control (coma decimal)');
  await lhm.setDuty(d.fans[0].id, 55); await lhm.release(d.fans[0].id);
  ok(sets[0].includes('action=Set') && sets[0].includes('value=55') && sets[1].includes('action=ResetDefault'), 'LHM: solicitudes de escritura y liberación');
  let rej = false; try { new LhmBackend({ host: '192.168.1.5' }); } catch { rej = true; }
  ok(rej, 'LHM: hosts remotos rechazados');
  fake.close();

  // ---- detección nativa y modo automático ----
  const { NativeBackend, parseNvidia } = require('../backends/native');
  const { AutoBackend } = require('../backends/auto');
  const g = parseNvidia('0, NVIDIA GeForce RTX 5070 Ti, 58, 0\n1, GPU B, 70, [N/A]\n');
  ok(g.length === 2 && g[0].temp === 58 && g[0].fan === 0 && Number.isNaN(g[1].fan), 'nvidia-smi: parseo (incluye valores [N/A])');
  const nat = new NativeBackend({ exec: async () => '0, NVIDIA GeForce RTX 5070 Ti, 59, 35\n' });
  const nd = await nat.read();
  ok(nd.fans.length === 1 && nd.fans[0].duty === 35 && nd.fans[0].canControl === false && nd.sensors[0].value === 59, 'nativo: detecta GPU real, ventilador de solo lectura');
  ok(nd.fans[0].defaultSource === nd.sensors[0].id && nd.notes.length >= 2, 'nativo: sensor asociado y avisos de limitaciones');
  const none = new NativeBackend({ exec: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  const nn = await none.read();
  ok(nn.fans.length === 0 && nn.sensors.length === 0 && nn.notes[0].includes('ningún ventilador'), 'nativo: sin hardware no inventa nada');
  // El controlador nunca escribe en un ventilador de solo lectura
  const ro = new ProfileStore(tmp()); ro.setGlobalEnabled(true);
  const roCtl = new Controller(nat, ro); let wrote = false; nat.setDuty = async () => { wrote = true; };
  await roCtl.tick(1);
  ok(!wrote && roCtl.snapshot().fans[0].mode === 'bios' && Number.isFinite(roCtl.snapshot().fans[0].temp), 'solo lectura: no se escribe y se informa la temperatura');
  // ---- asistente de placa base (lanzador falso: simula el asistente elevado) + modo automático ----
  const { HwHelper } = require('../backends/hwhelper');
  const board = { fans: [{ id: '/lpc/nct/0/fan/1', name: 'Placa - Fan #1', rpm: 900, duty: 30, canControl: true, controlId: '/lpc/nct/0/control/1' },
                         { id: '/lpc/ec/fan/0', name: 'EC - Opcional', rpm: 0, duty: null, canControl: false, controlId: null }],
                  sensors: [{ id: '/intelcpu/0/temperature/0', name: 'CPU Package', value: 48 }], notes: [] };
  const calls = []; let fakeSrv = null; let launchCount = 0;
  const fakeLauncher = async (port, token) => {
    launchCount++;
    fakeSrv = http.createServer((req, res) => {
      if (req.headers['x-token'] !== token) { res.statusCode = 403; return res.end('{}'); }
      const u = new URL(req.url, 'http://x'); calls.push(u.pathname + u.search);
      res.setHeader('Content-Type', 'application/json'); res.end(u.pathname === '/read' ? JSON.stringify(board) : '{"ok":true}');
    });
    await new Promise(r => fakeSrv.listen(port, 'localhost', r));
  };
  const libDir = tmp(); fs.writeFileSync(path.join(libDir, 'LibreHardwareMonitorLib.dll'), 'x');
  const gpuOnly = () => new NativeBackend({ exec: async () => '0, GPU, 50, 20\n' });
  const helper = new HwHelper({ libDir, launcher: fakeLauncher, startTimeoutMs: 3000 });
  const hauto = new AutoBackend({ lhm: { port: 1 }, native: gpuOnly(), helper, retryMs: 0 });
  let ad = await hauto.read();
  ok(ad.fans.length === 1 && ad.fans[0].id === 'gpu0:fan' && hauto.hardware().state === 'off' && hauto.hardware().available, 'auto: interruptor apagado => solo GPU');
  ok(launchCount === 0 && ad.notes.some(x => /Acceso a placa base/.test(x)), 'auto: no lanza nada solo y sugiere activar el acceso a placa base');
  await hauto.setHardware(true);
  ok(hauto.hardware().state === 'on' && launchCount === 1, 'asistente: arranca a demanda y responde');
  ad = await hauto.read();
  ok(ad.fans.length === 3 && ad.sensors.length === 2 && /placa base/.test(hauto.name), 'auto: combina GPU + placa base');
  await hauto.setDuty('/lpc/nct/0/fan/1', 55); await hauto.release('/lpc/nct/0/fan/1');
  ok(calls.some(c => c.includes('/set') && c.includes('value=55') && c.includes(encodeURIComponent('/lpc/nct/0/control/1'))) && calls.some(c => c.startsWith('/release')), 'asistente: set/release por el control correcto');
  let blocked = false; try { await hauto.setDuty('/lpc/ec/fan/0', 50); } catch { blocked = true; }
  ok(blocked, 'asistente: ventilador sin control no admite escritura');
  await hauto.setHardware(false);
  ok(hauto.hardware().state === 'off' && calls.includes('/quit'), 'asistente: al apagar el interruptor se cierra (/quit)');
  ad = await hauto.read();
  ok(ad.fans.length === 1, 'auto: sin asistente vuelve a solo GPU');
  fakeSrv.close();
  const cancel = new HwHelper({ libDir, launcher: async () => { throw new Error('se canceló la solicitud de administrador'); } });
  await cancel.start();
  ok(cancel.state === 'error' && /cancel/.test(cancel.message), 'asistente: cancelar UAC deja un error claro, sin colgarse');
  const nolib = new HwHelper({ libDir: tmp() }); await nolib.start();
  ok(nolib.state === 'error' && !nolib.available(), 'asistente: sin biblioteca no intenta lanzar nada');
  const fake2 = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Text: 'S', Children: [{ Text: 'Placa', Children: [
    { Text: 'F', Value: '900 RPM', SensorId: '/lpc/x/0/fan/1', Type: 'Fan', Children: [] }, { Text: 'F', Value: '30,0 %', SensorId: '/lpc/x/0/control/1', Type: 'Control', Children: [] }] }] })); });
  await new Promise(r => fake2.listen(0, '127.0.0.1', r));
  const lauto = new AutoBackend({ lhm: { port: fake2.address().port }, native: gpuOnly(), helper: new HwHelper({ libDir: tmp() }), retryMs: 0 });
  ad = await lauto.read();
  ok(ad.fans.some(f => f.id.includes('/fan/1') && f.canControl) && ad.fans.some(f => f.id === 'gpu0:fan'), 'auto: LibreHardwareMonitor ya abierto se combina con la GPU');
  fake2.close();

  // ---- bomba, nombres y sensores del asistente ----
  const pd = tmp(); const ps = new ProfileStore(pd);
  ps.setFanMeta('/lpc/nct/0/fan/6', { name: 'Bomba AIO', pump: true });
  ps.setFanMeta('/lpc/nct/0/fan/0', { name: '  ' });
  ok(ps.fanMeta['/lpc/nct/0/fan/6'].name === 'Bomba AIO' && ps.isPump('/lpc/nct/0/fan/6') && !ps.fanMeta['/lpc/nct/0/fan/0'], 'ventilador: nombre y marca de bomba (nombre vacío se borra)');
  ok(new ProfileStore(pd).isPump('/lpc/nct/0/fan/6') && new ProfileStore(pd).fanMeta['/lpc/nct/0/fan/6'].name === 'Bomba AIO', 'ventilador: nombre y bomba persisten');
  let bad2 = false; try { ps.setFanMeta('x', { name: 'x'.repeat(41) }); } catch { bad2 = true; }
  ok(bad2, 'ventilador: nombre demasiado largo rechazado');
  // bomba: aunque la curva pida 20 %, nunca baja de 60 %
  ps.setGlobalEnabled(true); ps.setActive('silent');
  const pumpSim = new SimBackend(); pumpSim.temps.cpu = 30; pumpSim.temps.gpu = 30;
  const pumpFan = { name: 'Bomba', max: 2500, auto: 100, duty: 100, controlled: false, source: 'cpu' };
  pumpSim.fans = { '/lpc/nct/0/fan/6': pumpFan, other: { name: 'Otro', max: 1500, auto: 100, duty: 100, controlled: false, source: 'cpu' } };
  const pctl = new Controller(pumpSim, ps);
  for (let i = 0; i < 40; i++) await pctl.tick(1);
  ok(pumpSim.fans['/lpc/nct/0/fan/6'].duty === 100 && pumpSim.fans.other.duty < 40, 'bomba: siempre al 100 %, sin curva, mientras otro ventilador sí baja');
  // asistente: sensores
  const hh = new HwHelper({ libDir });
  hh._ingest({ sensors: [{ id: '/intelcpu/0/temperature/17', name: 'Intel - P-Core #1 Distance to TjMax', value: 36 }, { id: '/lpc/nct/0/temperature/13', name: 'NCT - Chipset', value: 82 },
                         { id: '/intelcpu/0/temperature/16', name: 'Intel - CPU Package', value: 59.04999 }], fans: [{ id: 'f', name: 'F', rpm: 700, duty: 29.41, canControl: true, controlId: 'c' }] });
  ok(!hh.cache.sensors.some(s => /TjMax/.test(s.name)) && hh.cache.sensors.find(s => /Package/.test(s.name)).value === 59, 'asistente: descarta "Distance to TjMax" y redondea');
  ok(hh.cache.fans[0].defaultSource === '/intelcpu/0/temperature/16' && hh.cache.fans[0].duty === 29, 'asistente: sensor por defecto = CPU Package (no el más caliente)');
  // retardo: un pico corto no mueve el ventilador; un cambio sostenido sí
  {
    const { validateFanConfig } = require('../curve');
    const base = { enabled: true, source: 'auto', points: [{ t: 30, d: 20 }, { t: 90, d: 100 }], hysteresis: 0, minDuty: 20, maxDuty: 100, delay: 10 };
    ok(validateFanConfig(base) === null && validateFanConfig({ ...base, delay: 500 }) !== null && validateFanConfig({ ...base, delay: -1 }) !== null, 'retardo: validación 0–120 s');
    const ds = tmp(); const dst = new ProfileStore(ds); dst.setGlobalEnabled(true);
    const cp = dst.create('R', { default: base }); dst.setActive(cp.id);
    let tempNow = 40; const writes = [];
    const fb = { name: 't', async read() { return { sensors: [{ id: 's', name: 'S', value: tempNow }], fans: [{ id: 'f', name: 'F', duty: 30, rpm: 500, canControl: true, defaultSource: 's' }], notes: [] }; }, async setDuty(id, v) { writes.push(v); }, async release() {}, async close() {} };
    const dc = new Controller(fb, dst, { rampUp: 1000, rampDown: 1000 });
    for (let k = 0; k < 15; k++) await dc.tick(1);
    const calm = writes[writes.length - 1];
    tempNow = 80; for (let k = 0; k < 4; k++) await dc.tick(1); tempNow = 40; for (let k = 0; k < 15; k++) await dc.tick(1);
    ok(Math.max(...writes.slice(writes.indexOf(calm))) <= calm + 1, 'retardo: un pico de 4 s con retardo de 10 s no sube el ventilador');
    tempNow = 80; for (let k = 0; k < 8; k++) await dc.tick(1);
    ok(writes[writes.length - 1] <= calm + 1, 'retardo: a los 8 s todavía no reacciona');
    for (let k = 0; k < 6; k++) await dc.tick(1);
    ok(writes[writes.length - 1] > 60, 'retardo: un cambio sostenido sí sube el ventilador');
    tempNow = 95; await dc.tick(1);
    ok(writes[writes.length - 1] === 100, 'retardo: la temperatura crítica no espera');
  }

  console.log(`\n${n} comprobaciones superadas`);
  process.exit(0);
})().catch(e => { console.error('FALLO:', e); process.exit(1); });

function clone(o) { return JSON.parse(JSON.stringify(o)); }
