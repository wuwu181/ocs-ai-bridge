@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请安装 22 或更新版本。
  pause
  exit /b 1
)
node launcher.mjs --check
pause
