@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%FACEIT_API_KEY%"=="" (
  echo [ОШИБКА] Не задана переменная FACEIT_API_KEY. Выполните: setx FACEIT_API_KEY "ваш_ключ"
  echo Затем перезайдите в Windows или откройте новое окно cmd.
  goto :end
)
where node >nul 2>nul || (echo [ОШИБКА] Node.js не установлен. & goto :end)

echo [1/3] Загружаю турниры с FACEIT...
node scripts\sync-faceit.mjs
if errorlevel 1 goto :end

echo [2/3] Пересобираю турниры из ВКонтакте (по вашим одобрениям)...
node scripts\vk-tournaments.mjs --publish-only
if errorlevel 1 goto :end

echo [3/3] Создаю страницы для поисковиков...
node scripts\build-pages.mjs
if errorlevel 1 goto :end

echo.
echo Готово. Загрузите на хостинг (в корневую папку сайта, рядом с index.html):
echo   data\faceit.json, data\vk.json, папку t\, файлы sitemap.xml и robots.txt, а при правках сайта ещё и index.html

:end
echo.
pause
