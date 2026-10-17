# КиберРадар — автозагрузка турниров FACEIT

Схема: GitHub Actions раз в час запускает `scripts/sync-faceit.mjs` → скрипт запрашивает FACEIT Data API
(ключ хранится в секретах, на сайт не попадает) → пишет `data/faceit.json` → сайт читает этот файл.

## Запуск (один раз)
1. Создайте репозиторий на GitHub и загрузите в него все файлы этой папки (включая `.github`).
2. FACEIT ключ: https://developers.faceit.com/ → приложение → API Keys → тип **Server side**. 
   Старый ключ, показанный в чате, считайте скомпрометированным: удалите и создайте новый.
3. Репозиторий → Settings → Secrets and variables → Actions → New repository secret:
   имя `FACEIT_API_KEY`, значение — новый ключ.
4. Settings → Pages → Source: Deploy from a branch → `main` / root.
5. Вкладка Actions → «Sync FACEIT tournaments» → Run workflow. Через минуту в `data/faceit.json` появятся турниры.

## Локальная проверка
    FACEIT_API_KEY=новый_ключ FACEIT_DEBUG=1 node scripts/sync-faceit.mjs
    npx serve .        # открывать сайт только через http, не двойным кликом (fetch не работает с file://)

## Настройка
Все параметры — в блоке `CONFIG` в начале `scripts/sync-faceit.mjs`: игры, регион, исключения по организатору и названию.
 
