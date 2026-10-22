# 一键抓取 aicode 编程关卡
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行本文件
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

Write-Host "项目目录: $root" -ForegroundColor Cyan

# 1. 检查调试端口
try {
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -UseBasicParsing
  Write-Host "调试端口 9222 已就绪" -ForegroundColor Green
} catch {
  Write-Host "调试端口未开启。需要先完全退出 Edge 再重启。" -ForegroundColor Yellow
  $ans = Read-Host "现在帮你关掉所有 Edge 窗口并重开？(y/N)"
  if ($ans -eq "y") {
    Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList "--remote-debugging-port=9222"
    Write-Host "已重开 Edge。请在新窗口里登录 aicode，然后回来按回车。" -ForegroundColor Yellow
    Read-Host "登录完成后按回车继续"
  } else {
    Write-Host "已取消。请手动完全退出 Edge 后重跑。" -ForegroundColor Red
    exit 1
  }
}

# 2. 找 node
$node = $null
foreach ($cand in @(
  "C:\Users\郑\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
  "$env:ProgramFiles\nodejs\node.exe"
)) { if (Test-Path $cand) { $node = $cand; break } }
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Host "找不到 node.exe" -ForegroundColor Red; exit 1 }
Write-Host "node: $node" -ForegroundColor Gray

# 3. 运行抓取
Push-Location $root
& $node (Join-Path $here "scrape-levels.mjs") --cdp 9222
Pop-Location

Write-Host ""
if (Test-Path (Join-Path $root "levels.json")) {
  Write-Host "完成！levels.json 已生成，把内容发给我。" -ForegroundColor Green
} else {
  Write-Host "没有生成 levels.json，请把上面的报错发给我。" -ForegroundColor Red
}
Read-Host "按回车关闭"