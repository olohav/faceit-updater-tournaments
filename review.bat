@echo off
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>nul || (echo [ОШИБКА] Git не установлен. & goto :end)
where node >nul 2>nul || (echo [ОШИБКА] Node.js не установлен. & goto :end)
if not exist ".git" (echo [ОШИБКА] Это не клонированный репозиторий: нет папки .git. & goto :end)

echo [1/2] Скачиваю свежих кандидатов с GitHub...
git pull --rebase --autostash
if errorlevel 1 goto :end

echo [2/2] Открываю проверку: http://localhost:3000
echo Когда закончите, нажмите Ctrl+C, ответьте Y, затем запустите publish-review.bat
node scripts\review.mjs

:end
echo.
pause
