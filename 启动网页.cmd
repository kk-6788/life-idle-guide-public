@echo off
chcp 65001 >nul
setlocal
rem 人生浪费指南 — 启动本机网页
rem 只监听 127.0.0.1:8765，不修改机器设置，不自动安装 Python。

cd /d "%~dp0"

set "PY_EXE="
rem 只选择已有的真实解释器，跳过可能打开商店的 WindowsApps 入口。
for /f "delims=" %%P in ('where python 2^>nul') do (
  echo "%%P" | findstr /i /l /c:"\WindowsApps\" >nul
  if errorlevel 1 if not defined PY_EXE set "PY_EXE=%%P"
)
if not defined PY_EXE if exist "%USERPROFILE%\.hermes\hermes-agent\venv\Scripts\python.exe" set "PY_EXE=%USERPROFILE%\.hermes\hermes-agent\venv\Scripts\python.exe"

if not defined PY_EXE (
  echo.
  echo 没有找到 Python。
  echo 请先安装 Python 3（https://www.python.org/downloads/），
  echo 安装时勾选 "Add Python to PATH"。
  echo 本脚本不会自动安装 Python。安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

"%PY_EXE%" --version 2>&1 | findstr /l /c:"Python 3." >nul
if errorlevel 1 (
  echo 未检测到可用的 Python 3，请手动选择你已有的 Python 环境。
  pause
  exit /b 1
)

echo 正在启动本机服务（仅 127.0.0.1:8765）...
echo 启动后请在浏览器打开： http://127.0.0.1:8765/
echo 关闭本窗口即可停止服务。
echo.

"%PY_EXE%" server\app.py

endlocal
