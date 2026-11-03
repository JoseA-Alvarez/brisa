# Publicar una versión

El `.exe` se compila siempre desde el código fuente en GitHub Actions (`.github/workflows/release.yml`); no se sube a mano.

1. Pasa los tests en local: `npm test`.
2. Mueve lo de "Sin publicar" de `CHANGELOG.md` a una sección nueva con la versión y la fecha, y haz commit.
3. Sube la versión y crea la etiqueta (el mensaje de `npm version` crea commit y etiqueta `vX.Y.Z`):
   ```bash
   npm version minor        # o patch / major; también vale: npm version 0.2.0
   git push origin main --follow-tags
   ```
4. Al llegar la etiqueta, el workflow comprueba que coincide con `package.json`, ejecuta los tests, compila `Brisa-vX.Y.Z-win-x64.exe`, genera `SHA256SUMS.txt`, firma la procedencia (atestación de GitHub) y crea la release con notas automáticas.
5. Revisa la release en GitHub y edita las notas si hace falta.

## Verificar una descarga

```powershell
(Get-FileHash .\Brisa-v0.1.0-win-x64.exe -Algorithm SHA256).Hash   # debe coincidir con SHA256SUMS.txt
gh attestation verify .\Brisa-v0.1.0-win-x64.exe --repo <usuario>/brisa
```

## Notas

- El `.exe` no está firmado con certificado de código: SmartScreen puede avisar. La atestación y las sumas permiten comprobar que sale de este repositorio.
- No se incluye LibreHardwareMonitor en la release: se instala aparte (ver README).
- Para deshacer una etiqueta mal puesta: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` y borra la release en GitHub.
