@echo off
chcp 65001 >nul
title Stop Memory Workbench
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
timeout /t 2 >nul
