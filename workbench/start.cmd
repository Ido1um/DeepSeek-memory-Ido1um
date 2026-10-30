@echo off
chcp 65001 >nul
title 记忆工作台
set NODE="\tools\node-runtime\bin\node.exe"
%NODE% "%~dp0server.mjs" --port 7351
pause
