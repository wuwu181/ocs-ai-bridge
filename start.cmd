@echo off
chcp 65001 >nul
setlocal
title OCS AI 多模型控制台
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 或更新版本，再重新双击本文件。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 (
  echo Node.js 版本过低，请升级到 22 或更新版本。
  pause
  exit /b 1
)
echo 正在启动控制台。首次启动会自动创建配置，无需 npm install。
node launcher.mjs %*
if errorlevel 1 (
  echo.
  echo 启动未完成，可双击 diagnose.cmd 查看环境诊断。
  pause
)
