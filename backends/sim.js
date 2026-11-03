'use strict';
// Backend simulado: modelo térmico simple para probar curvas sin hardware.
// Temperatura: dT/dt = (calor - refrigeración(duty)) / inercia
class SimBackend {
  constructor() {
    this.name = 'Simulador';
    this.load = { cpu: 0.5, gpu: 0.3 }; // 0..1, ajustable desde la API de pruebas
    this.temps = { cpu: 40, gpu: 38 };
    this.fans = {
      cpu_fan: { name: 'Ventilador CPU', max: 2200, auto: 40, duty: 40, controlled: false, source: 'cpu' },
      gpu_fan: { name: 'Ventilador GPU', max: 3000, auto: 35, duty: 35, controlled: false, source: 'gpu' },
      case_fan: { name: 'Ventilador caja', max: 1500, auto: 50, duty: 50, controlled: false, source: 'cpu' },
    };
    this.timer = null;
  }

  start(tickMs = 1000, speed = 1) {
    this.timer = setInterval(() => this.step(tickMs / 1000 * speed), tickMs);
    this.timer.unref();
  }

  step(dt) {
    const cool = k => 0.1 + 0.9 * (this.fans[k].duty / 100); // 0.1..1
    const model = (key, fanKey, power, ambient) => {
      const heat = this.load[key] * power;
      const target = ambient + heat * (1.6 - 1.0 * cool(fanKey)) ; // más duty => menos temperatura de equilibrio
      this.temps[key] += (target - this.temps[key]) * Math.min(1, dt / 25);
    };
    model('cpu', 'cpu_fan', 70, 28);
    model('gpu', 'gpu_fan', 75, 28);
    // La caja ayuda a ambos un poco
    const c = this.fans.case_fan.duty / 100;
    this.temps.cpu -= c * 0.02 * dt; this.temps.gpu -= c * 0.02 * dt;
  }

  async read() {
    return {
      sensors: [
        { id: 'cpu', name: 'CPU', value: this.temps.cpu },
        { id: 'gpu', name: 'GPU', value: this.temps.gpu },
      ],
      fans: Object.entries(this.fans).map(([id, f]) => ({
        id, name: f.name, duty: f.duty, rpm: Math.round(f.max * f.duty / 100), canControl: true, controlled: f.controlled, defaultSource: f.source,
      })),
    };
  }

  async setDuty(id, pct) {
    const f = this.fans[id]; if (!f) throw new Error('ventilador desconocido');
    f.duty = Math.max(0, Math.min(100, pct)); f.controlled = true;
  }

  async release(id) { const f = this.fans[id]; if (f) { f.controlled = false; f.duty = f.auto; } }
  async close() { clearInterval(this.timer); }
}

module.exports = { SimBackend };
