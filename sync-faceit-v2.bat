@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%FACEIT_API_KEY%"=="" (
  echo [ОШИБКА] Не задана переменная FACEIT_API_KEY.
  echo Выполните: setx FACEIT_API_KEY "ваш_ключ"
  echo Затем перезайдите в Windows или откройте новое окно cmd.
  goto :end
)

where git >nul 2>nul || (echo [ОШИБКА] Git не установлен. & goto :end)
where node >nul 2>nul || (echo [ОШИБКА] Node.js не установлен. & goto :end)

if not exist ".git" (
  echo [ОШИБКА] Это не клонированный репозиторий: нет папки .git.
  echo Выполните: git clone https://github.com/olohav/faceit-updater-tournaments
  goto :end
)

echo [1/3] Получаю свежую версию репозитория...
git pull --rebase
if errorlevel 1 goto :end

echo [2/3] Загружаю турниры с FACEIT...
node scripts\sync-faceit.mjs
if errorlevel 1 goto :end

echo [3/3] Отправляю изменения на GitHub...
git add data\faceit.json
git diff --cached --quiet && (echo Изменений нет. & goto :end)
git commit -m "Обновление турниров FACEIT"
git push

:end
echo.
if /i not "%1"=="auto" pause
