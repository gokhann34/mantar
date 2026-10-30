@echo off
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo .env dosyasi olusturuldu. Simdi .env dosyasini acip API anahtarini ve APP_PASSWORD degerlerini doldur.
  notepad .env
  pause
  exit /b 0
)
if not exist node_modules (
  echo Paketler kuruluyor...
  npm install
  if errorlevel 1 pause & exit /b 1
)
npm start
pause
