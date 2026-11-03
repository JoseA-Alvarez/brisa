'use strict';
// Genera dist/Brisa.exe: un ejecutable de Windows que incluye Node, el código y la interfaz (sin dependencias).
// Uso: node build-exe.js     (necesita Node 20+ en el PC donde se construye; el .exe resultante no lo necesita)
// Técnica: Node SEA (Single Executable Application). La inyección del recurso usa la API de Windows UpdateResource,
// igual que la herramienta oficial postject, pero sin descargar nada.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'win32') { console.error('Este script construye el .exe de Windows.'); process.exit(1); }
const root = __dirname, dist = process.env.BRISA_DIST ? path.resolve(process.env.BRISA_DIST) : path.join(root, 'dist'); // BRISA_DIST: carpeta de salida alternativa
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1) Un solo archivo JS con todos los módulos
const MODULES = ['server.js', 'controller.js', 'profiles.js', 'curve.js', 'backends/sim.js', 'backends/lhm.js', 'backends/native.js', 'backends/auto.js', 'backends/hwhelper.js'];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let out = `'use strict';\nglobalThis.BRISA_VERSION = ${JSON.stringify(pkg.version)};\nconst __real = require;\nconst __defs = {\n`;
for (const m of MODULES) out += `${JSON.stringify(m)}: function (module, exports, require, __dirname) {\n${fs.readFileSync(path.join(root, m), 'utf8')}\n},\n`;
out += `};
const __cache = {}, __main = { exports: {} };
function __load(key, preset) {
  if (__cache[key]) return __cache[key].exports;
  const m = preset || { exports: {} }; __cache[key] = m;
  const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '.';
  const req = n => {
    if (n.startsWith('./') || n.startsWith('../')) {
      const parts = (dir === '.' ? [] : dir.split('/')).concat(n.split('/')), st = [];
      for (const p of parts) { if (p === '..') st.pop(); else if (p !== '.') st.push(p); }
      let k = st.join('/'); if (!k.endsWith('.js')) k += '.js';
      return __load(k);
    }
    return __real(n);
  };
  req.main = __main;
  __defs[key](m, m.exports, req, '/bundle/' + dir);
  return m.exports;
}
__load('server.js', __main);
`;
fs.writeFileSync(path.join(dist, 'bundle.js'), out);

// 2) Blob SEA con la interfaz y el asistente como recursos
const cfg = {
  main: path.join(dist, 'bundle.js'), output: path.join(dist, 'sea.blob'), disableExperimentalSEAWarning: true,
  assets: { 'index.html': path.join(root, 'public', 'index.html'), 'hw-helper.ps1': path.join(root, 'helper', 'hw-helper.ps1') },
};
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(cfg, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { cwd: root, stdio: 'inherit' });

// 3) Copia de node.exe con el "fuse" activado y el blob inyectado
const exe = path.join(dist, 'Brisa.exe');
fs.copyFileSync(process.execPath, exe);
const buf = fs.readFileSync(exe);
const fuse = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0');
const at = buf.indexOf(fuse);
if (at < 0) { console.error('No se encontró el fuse SEA en este Node.'); process.exit(1); }
buf[at + fuse.length - 1] = 0x31; // ':0' -> ':1'
fs.writeFileSync(exe, buf);

const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Res {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr BeginUpdateResource(string f, bool del);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint cb);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h, bool discard);
}
"@
$data = [IO.File]::ReadAllBytes($env:BRISA_BLOB)
$h = [Res]::BeginUpdateResource($env:BRISA_EXE, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
if (-not [Res]::UpdateResource($h, [IntPtr]10, "NODE_SEA_BLOB", 1033, $data, $data.Length)) { throw "UpdateResource: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
if (-not [Res]::EndUpdateResource($h, $false)) { throw "EndUpdateResource: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
`;
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  stdio: 'inherit', env: { ...process.env, BRISA_EXE: exe, BRISA_BLOB: path.join(dist, 'sea.blob') },
});
const named = path.join(dist, `Brisa-v${pkg.version}-win-x64.exe`);
fs.copyFileSync(exe, named); // nombre con versión: es el archivo que se publica en las releases
console.log(`\nListo: ${named} (${(fs.statSync(named).size / 1048576).toFixed(0)} MB)`);
