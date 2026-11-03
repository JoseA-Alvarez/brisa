# Brisa

Control de ventiladores para Windows, local y sin dependencias: detecta los ventiladores reales de tu PC, y te deja darle a **cada uno su propia curva** (temperatura → velocidad), con perfiles integrados y personalizados. La interfaz es una página web que solo escucha en tu propio equipo (`127.0.0.1`).

> Estado: versión 0.x. Probado en una placa ASUS con chip Nuvoton NCT6798D (escritura de velocidad incluida). En otras placas puede variar; abre un *issue* con lo que veas.

## Descarga (usuarios)

1. Baja `Brisa-vX.Y.Z-win-x64.exe` desde [Releases](../../releases) y comprueba su suma en `SHA256SUMS.txt` (ver [docs/RELEASING.md](docs/RELEASING.md)).
2. Para controlar los ventiladores de la **placa base** necesitas, además:
   - el controlador firmado **[PawnIO](https://pawnio.eu)** (si usas LibreHardwareMonitor o SignalRGB probablemente ya lo tienes);
   - la biblioteca de [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases) (se usa solo la biblioteca): descomprime el `.zip` de la release en `%LOCALAPPDATA%\Brisa\LibreHardwareMonitor` de modo que exista `LibreHardwareMonitorLib.dll` dentro. Comprueba el hash que publica esa release antes de usarlo.
3. Doble clic en `Brisa.exe`: se abre el navegador en `http://localhost:8760`. La ventana de consola es Brisa; si la cierras, los ventiladores vuelven a la BIOS.
4. Activa **"Acceso a placa base"** y acepta el aviso de Windows (administrador).

Sin la biblioteca solo se ve la GPU NVIDIA, en modo solo lectura.

## Funciones

- **Una curva por ventilador**: gráfica propia (2–12 puntos), sensor, histéresis, **retardo** (ignora picos cortos de la CPU), mínimo y máximo. También puedes aplicar un perfil a un solo ventilador sin tocar la curva a mano.
- **Perfiles**: 4 integrados e inmutables (Silencioso, Equilibrado, Rendimiento, Máximo) y los tuyos: crear, duplicar, renombrar, borrar, guardar como, exportar e importar JSON.
- **Detección real**: solo se muestran ventiladores y sensores que existen en tu PC. El modo simulado (`--backend sim`) queda marcado como "DATOS SIMULADOS".
- **Bomba**: el Fan #7 del chip Nuvoton (la bomba de refrigeración líquida en la placa de referencia) va siempre al 100 %, sin curva. Si tu bomba está en otro canal, ver `PUMP_IDS` en `profiles.js`.
- **Nombres propios** para cada ventilador, que se conservan.
- **Control a demanda**: el interruptor global arranca apagado la primera vez; al apagarlo o cerrar Brisa, todo vuelve a la BIOS.

## Seguridad

- Temperatura ≥ 90 °C o sensor perdido durante 5 s ⇒ 100 % inmediato (sin retardo). Se rechazan curvas decrecientes. La velocidad sube rápido y baja despacio.
- Servidor solo en `127.0.0.1`, con comprobación de `Host` (anti DNS rebinding) y cabecera `X-Brisa` en cambios (anti CSRF).
- El acceso a placa base lanza un asistente PowerShell **elevado** que carga una DLL y un script desde carpetas de tu usuario: un proceso con tus mismos permisos podría sustituirlos antes de la elevación. Es una limitación de las instalaciones por usuario; protege esas carpetas.
- El `.exe` no lleva firma de código: SmartScreen puede avisar. Las releases incluyen suma SHA-256 y atestación de procedencia de GitHub.
- Conflicto con **SignalRGB**: su servicio controla los mismos ventiladores y pisa lo que escribe Brisa. Ciérralo del todo (incluido `SignalRgbService`) mientras uses Brisa.

## Desarrollo

Requisitos: Node.js 24+ (sin dependencias de npm) y Windows para el hardware.

```bash
npm start                      # http://localhost:8760 (hardware real)
node server.js --backend sim   # simulador, para probar la interfaz
npm test                       # comprobaciones automáticas
npm run build:exe              # genera dist/Brisa.exe y dist/Brisa-vX.Y.Z-win-x64.exe
```

Opciones: `--port`, `--data <carpeta>` (por defecto `%APPDATA%\Brisa`), `--backend sim|native|lhm|auto`, `--lhm host:puerto`, `--open`, `--version`.

Estructura:

| Ruta | Contenido |
|---|---|
| `server.js` | Servidor local y API |
| `controller.js`, `curve.js`, `profiles.js` | Bucle de control, curvas, perfiles y su almacenamiento |
| `backends/` | Fuentes de hardware: nativa (GPU), asistente elevado, LibreHardwareMonitor web, simulador |
| `helper/hw-helper.ps1` | Asistente elevado (usa LibreHardwareMonitorLib) |
| `public/index.html` | Interfaz |
| `build-exe.js` | Compila el `.exe` (Node SEA) sin descargar nada |
| `.github/workflows/` | CI y publicación de releases |

El `.exe` se genera con Node SEA: un único archivo con Node, el código y la interfaz. `BRISA_DIST=<carpeta>` cambia la carpeta de salida (útil si `dist/` está en uso).

## Releases

Se publican solas al subir una etiqueta `vX.Y.Z`; ver [docs/RELEASING.md](docs/RELEASING.md).

## Estado de verificación

- Con tests: curvas, perfiles, controlador (incluido el retardo), API, análisis de sensores, flujo del asistente con un lanzador simulado.
- Probado a mano en la placa de referencia: detección, escritura de velocidad con perfil Máximo y el `.exe` fuera de la sesión de desarrollo.
- Sin probar: otras placas y chips, backend de LibreHardwareMonitor web (escritura), portátiles.

## Licencia

[MIT](LICENSE). LibreHardwareMonitor (MPL-2.0) y PawnIO son proyectos independientes y no se incluyen en este repositorio ni en las releases.
