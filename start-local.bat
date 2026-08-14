@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo VisionAgent 本地启动器
echo 正在启动本地 HTTP 服务，避免 file:// 协议限制...
echo.

:: 优先用 Python（Windows 10/11 通常自带）
python --version >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto end
)

:: 备选 Node（如果用户有装）
node --version >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    node -e "require('http').createServer((req,res)=>{const fs=require('fs'),path=require('path'),p=path.join(__dirname,req.url==='/'?'index.html':req.url);const m={'html':'text/html','js':'application/javascript','css':'text/css','png':'image/png','jpg':'image/jpeg','svg':'image/svg+xml'};fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);res.end('Not Found')}else{res.writeHead(200,{'Content-Type':m[path.extname(p).slice(1)]||'application/octet-stream'});res.end(d)}})}).listen(8080,()=>console.log('http://localhost:8080'))"
    goto end
)

echo 未找到 Python 或 Node，请安装其一后重试。
echo 或手动把本文件夹用 VS Code 的 "Live Server" 插件打开。
pause

:end
pause
