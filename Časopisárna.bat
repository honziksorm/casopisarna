@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Časopisárna
python server.py %*
if errorlevel 1 pause
