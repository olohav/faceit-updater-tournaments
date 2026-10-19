@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%VK_TOKEN%"=="" (
  echo [ОШИБКА] Не задана переменная VK_TOKEN.
  echo Выполните: setx VK_TOKEN "ваш_сервисный_ключ"
  echo Затем откройте новое окно cmd.
  goto :end
)
where node >nul 2>nul || (echo [ОШИБКА] Node.js не установлен. & goto :end)

echo [1/2] Собираю турниры из ВКонтакте...
node scripts\sync-vk.mjs
if errorlevel 1 goto :end

echo [2/2] Создаю страницы для поисковиков...
node scripts\build-pages.mjs

echo Готово. Загрузите на хостинг: data\vk.json, папку t\, sitemap.xml.
:end
pause
