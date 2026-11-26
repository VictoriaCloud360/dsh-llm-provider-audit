# Instala o actualiza la habilidad dsh-llm-provider-audit en la carpeta de habilidades del usuario.
# Uso:  powershell -ExecutionPolicy Bypass -File .\install.ps1
param(
  [string]$Repo = 'https://github.com/VictoriaCloud360/dsh-llm-provider-audit.git',
  [string]$Name = 'dsh-llm-provider-audit'
)

$ErrorActionPreference = 'Stop'
$skillsRoot = Join-Path $env:USERPROFILE '.dsh\skills'
$dest = Join-Path $skillsRoot $Name

New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

if (Test-Path (Join-Path $dest '.git')) {
  Write-Host "Actualizando $dest"
  git -C $dest pull --ff-only
} elseif (Test-Path $dest) {
  Write-Host "Ya existe $dest (sin .git). Se reemplaza por una copia del repo."
  git clone --depth 1 $Repo "$dest.tmp"
  Remove-Item $dest -Recurse -Force
  Move-Item "$dest.tmp" $dest
} else {
  Write-Host "Clonando en $dest"
  git clone --depth 1 $Repo $dest
}

Write-Host ''
Write-Host "Instalado. Comprobando:"
node (Join-Path $dest 'scripts\audit.mjs') --no-chat
Write-Host ''
Write-Host 'Reinicia DeepSeek Harness y usa en una sesión nueva:'
Write-Host '  "auditá los proveedores LLM de mi perfil y borrá los modelos que no existan"'
