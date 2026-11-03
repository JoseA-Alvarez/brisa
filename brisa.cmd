@echo off
rem Lanza Brisa y abre la interfaz en el navegador. Cierra la ventana para devolver el control a la BIOS.
rem Simulador por defecto; para LibreHardwareMonitor: brisa.cmd --backend lhm
cd /d "%~dp0"
node server.js --open %*
