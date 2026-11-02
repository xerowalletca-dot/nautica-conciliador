@echo off
title Conciliador Nautica
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --omit=dev
)
start "" http://localhost:3900
node src\server.js
pause
