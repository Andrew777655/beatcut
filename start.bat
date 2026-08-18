@echo off
title BeatCut
cd /d "%~dp0"
rem Give the server a moment to bind before the browser hits it.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:5173"
node server.js
pause
