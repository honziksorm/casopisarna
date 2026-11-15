@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "program\server.py" cd program
title Aktualizace
if not exist "update.py" goto zip
set "PY=%CD%\python\python.exe"
if not exist "%PY%" (
  set "PY=python"
  python -c "import pymupdf, PIL" >nul 2>nul || goto nopython
)
"%PY%" update.py %* & echo. & pause & exit /b

:zip
echo.
echo   Čtečka ještě není rozbalená.
echo.
echo   Zavři tohle okno, na stažený soubor ZIP klikni pravým tlačítkem,
echo   vyber "Extrahovat vše" a pak spusť "Spustit čtečku" z rozbalené složky.
echo.
pause
exit /b

:nopython
echo.
echo   Tohle je jen zdrojový kód bez Pythonu. Stáhni si hotovou čtečku,
echo   stránku ke stažení ti teď otevřu.
start "" "https://github.com/honziksorm/casopisarna/releases/latest"
echo.
pause
