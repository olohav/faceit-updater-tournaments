@echo off
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>nul || (echo [ОШИБКА] Git не установлен. & goto :end)

git add data\vk-decisions.json data\vk-skip.json
git diff --cached --quiet && (echo Новых решений нет. & goto :end)

git commit -m "Решения по турнирам из ВКонтакте"
git pull --rebase --autostash
if errorlevel 1 goto :end
git push
if errorlevel 1 goto :end

echo.
echo Готово. GitHub сам соберёт data/vk.json и выложит сайт на хостинг (обычно 1-3 минуты).
echo Ход выполнения: вкладка Actions в репозитории, workflow "Update site data".

:end
echo.
pause
