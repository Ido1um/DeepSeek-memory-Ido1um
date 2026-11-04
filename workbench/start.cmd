@echo off
chcp 65001 >nul
title 记忆工作台
rem 需要 PATH 里有 Node.js 22.13+；没有就改用绝对路径。
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node，请先安装 Node.js 22.13+ 或把 node 加进 PATH。
  pause
  exit /b 1
)
node "%~dp0server.mjs" --port 7351
pause
