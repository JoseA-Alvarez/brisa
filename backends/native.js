'use strict';
// Detección nativa, sin drivers ni permisos de administrador: solo lo que el sistema expone de forma pública.
// Hoy: GPU NVIDIA vía nvidia-smi (temperatura y velocidad real del ventilador). Es de solo lectura:
// nvidia-smi no permite fijar la velocidad del ventilador en Windows.
// La CPU y los ventiladores de la placa base NO son accesibles sin un controlador de hardware (p. ej. LibreHardwareMonitor).
const { execFile } = require('child_process');

const QUERY = 'index,name,temperature.gpu,fan.speed';

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// Cada línea CSV: "0, NVIDIA GeForce RTX 5070 Ti, 58, 0"  (valores no disponibles: "[N/A]")
function parseNvidia(csv) {
  const gpus = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split(',').map(s => s.trim());
    if (p.length < 4) continue;
    const num = s => { const v = parseFloat(s); return Number.isFinite(v) ? v : NaN; };
    gpus.push({ index: p[0], name: p[1], temp: num(p[2]), fan: num(p[3]) });
  }
  return gpus;
}

class NativeBackend {
  constructor({ exec = run, nvidia = 'nvidia-smi' } = {}) {
    this.name = 'Detección nativa (solo lectura)';
    this.exec = exec; this.nvidia = nvidia;
    this.nvidiaMissing = false;
  }

  async read() {
    const sensors = [], fans = [], notes = [];
    if (!this.nvidiaMissing) {
      try {
        const gpus = parseNvidia(await this.exec(this.nvidia, [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits']));
        for (const g of gpus) {
          const sid = `gpu${g.index}:temp`;
          if (Number.isFinite(g.temp)) sensors.push({ id: sid, name: `${g.name} · temperatura del núcleo`, value: g.temp });
          fans.push({ id: `gpu${g.index}:fan`, name: `${g.name} · ventilador`, duty: g.fan, rpm: NaN, canControl: false, defaultSource: sid });
        }
      } catch (e) {
        if (e.code === 'ENOENT') this.nvidiaMissing = true; else notes.push('No se pudo leer la GPU NVIDIA: ' + e.message);
      }
    }
    if (!fans.length) notes.push('No se detectó ningún ventilador con las herramientas nativas.');
    notes.push('Los ventiladores de la placa base y la temperatura de la CPU requieren acceso privilegiado al hardware: se habilita con el interruptor "Acceso a placa base".');
    notes.push('La velocidad del ventilador de la GPU solo se puede leer: Windows y nvidia-smi no permiten fijarla.');
    return { sensors, fans, notes };
  }

  async setDuty() { throw new Error('este ventilador es de solo lectura'); }
  async release() {}
  async close() {}
}

module.exports = { NativeBackend, parseNvidia };
