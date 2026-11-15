@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Převod časopisů
python convert.py %*
echo.
pause
