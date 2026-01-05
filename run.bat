@echo off
chcp 65001 >nul
echo 檢查 Node.js 環境...

REM 檢查 Node.js 是否已安裝
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [錯誤] 未偵測到 Node.js！
    echo.
    echo 請先安裝 Node.js 才能執行此專案。
    echo.
    echo 安裝方式：
    echo 1. 官方網站下載：https://nodejs.org/
    echo 2. 使用 winget 安裝：winget install OpenJS.NodeJS.LTS
    echo 3. 使用 Chocolatey 安裝：choco install nodejs-lts
    echo.
    echo 安裝完成後，請重新執行此批次檔。
    echo.
    pause
    exit /b 1
)

REM 檢查 npm 是否可用
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 未偵測到 npm（Node.js 套件管理器）！
    echo 請確認 Node.js 安裝是否完整。
    pause
    exit /b 1
)

REM 顯示 Node.js 和 npm 版本
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo [成功] Node.js 版本：%NODE_VERSION%
echo [成功] npm 版本：%NPM_VERSION%
echo.

echo 檢查依賴套件(node_modules)...
if not exist "node_modules" (
    echo 未偵測到 node_modules，開始安裝依賴套件...
    npm install
    if %errorlevel% neq 0 (
        echo [錯誤] 依賴套件安裝失敗！
        pause
        exit /b 1
    )
) else (
    echo 依賴套件已存在，跳過安裝步驟
)
echo.
echo 啟動開發伺服器
npm run dev