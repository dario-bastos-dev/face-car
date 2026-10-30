@echo off
chcp 65001 >nul
rem Sobe o simulador (http://localhost:8000/simulador/) e o estimador em Python (ws://localhost:8765)
cd /d "%~dp0.."
where py >nul 2>&1
if %errorlevel% == 0 (
    py -3.12 simulador\servidor.py %*
) else (
    python simulador\servidor.py %*
)
pause
