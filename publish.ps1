# ============================================================
#  一键发布到 GitHub
#
#  用法（在项目根目录打开 PowerShell）：
#     .\publish.ps1 -RepoUrl https://github.com/你的用户名/quiz-bot.git
#
#  会依次：检查 git → 初始化仓库 → 提交 → 推送
#  推送时会弹出登录窗口，用你的 GitHub 账号登录即可（或填 Personal Access Token）
# ============================================================
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoUrl,
  [string]$Branch = "main",
  [string]$CommitMessage = "feat: 网页 AI 答题助手（油猴脚本 + 桌面版）"
)

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

Step "检查 git"
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Warn "没有找到 git。"
  Write-Host ""
  Write-Host "请先安装 Git for Windows：https://git-scm.com/download/win"
  Write-Host "安装后重开 PowerShell，再运行本脚本。"
  Write-Host ""
  Write-Host "或者改用「网页上传」方式（无需安装 git）："
  Write-Host "  1. 打开 https://github.com/new 新建仓库（不要勾选 README）"
  Write-Host "  2. 把本目录下的 quiz-bot-upload.zip 拖到仓库页面的上传区域"
  exit 1
}
OK ("git 版本: " + (git --version))

Step "检查是否已初始化仓库"
if (-not (Test-Path .git)) {
  git init | Out-Null
  git branch -M $Branch
  OK "已初始化 git 仓库（分支 $Branch）"
} else {
  OK "已是 git 仓库"
}

Step "配置提交身份（若未设置）"
$name = git config user.name
$email = git config user.email
if (-not $name) {
  $name = Read-Host "请输入用于提交的用户名（如 your-github-name）"
  git config user.name $name
}
if (-not $email) {
  $email = Read-Host "请输入用于提交的邮箱"
  git config user.email $email
}
OK "提交身份: $name <$email>"

Step "暂存文件"
git add -A
$staged = git diff --cached --name-only
if (-not $staged) { Warn "没有需要提交的改动" }
else { OK ("共 " + ($staged | Measure-Object).Count + " 个文件待提交") }

Step "安全检查：确认不会提交敏感文件"
$danger = $staged | Where-Object { $_ -match "(^|/)config\.json$|(^|/)node_modules/|(^|/)logs/|\.env$" }
if ($danger) {
  Warn "以下文件不该提交，已中止："
  $danger | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
  Write-Host "    请检查 .gitignore 后重试。"
  exit 1
}
OK "未发现敏感文件 ✔"

Step "提交"
git commit -m $CommitMessage | Out-Null
OK "已提交"

Step "关联远程仓库"
$existing = git remote get-url origin 2>$null
if ($existing) {
  git remote set-url origin $RepoUrl
  OK "已更新 origin -> $RepoUrl"
} else {
  git remote add origin $RepoUrl
  OK "已添加 origin -> $RepoUrl"
}

Step "推送到 GitHub"
Warn "如果弹出登录窗口，请用 GitHub 账号登录"
git push -u origin $Branch

Write-Host ""
Write-Host "完成 ✔ 仓库地址：$RepoUrl" -ForegroundColor Green
