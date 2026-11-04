@echo off
chcp 65001 >nul
title 工业设备 PHM 状态监测系统 - 本地服务器

echo =======================================================
echo    工业设备 PHM 状态监测与数字孪生系统 (Windows 本地服务)
echo =======================================================
echo.

if not exist node_modules (
  echo [1/3] 正在检测到依赖未安装，开始自动安装项目依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 执行失败，请检查网络或 Node.js 环境！
    pause
    exit /b 1
  )
)

if not exist dist\server.cjs (
  echo [2/3] 正在编译前端与后端代码...
  call npm run build
  if errorlevel 1 (
    echo [错误] 代码编译失败！
    pause
    exit /b 1
  )
)

echo [3/3] 正在启动 PHM 本地服务器...
echo 服务启动后，请在浏览器中访问: http://localhost:3000
echo 局域网内其他电脑可通过访问本机 IP 访问: http://^<本机IP^>:3000
echo.
echo 按 Ctrl + C 可停止服务器。
echo =======================================================
echo.

node dist/server.cjs
pause
