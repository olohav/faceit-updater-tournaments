# КиберРадар

Сайт-агрегатор турниров по CS2, Dota 2, Valorant и MLBB для России.
Статический сайт (`index.html`) + автосбор FACEIT (`scripts/`) + аккаунты, роли и ручные турниры (Supabase) + форма обратной связи (Formspree).

## Структура
| Путь | Назначение |
|---|---|
| `index.html` | весь сайт |
| `data/faceit.json` | турниры FACEIT (обновляется скриптом) |
| `data/organizers.json` | кэш имён организаторов (ускоряет скрипт) |
| `scripts/config.mjs` | **все настройки отбора**: игры, поисковые слова, фильтры |
| `scripts/sync-faceit.mjs` + `api/filters/format/parse/dates.mjs` | сбор и обработка данных |
| `supabase/schema.sql` | база: аккаунты, роли, турниры администратора |
| `.github/workflows/` | автообновление и публикация |

## 1. Автоматический сбор FACEIT
GitHub: Settings → Secrets → Actions → секрет `FACEIT_API_KEY` (ключ типа Server side). Workflow «Sync FACEIT tournaments» запускается каждый час.
Локально: `set FACEIT_API_KEY=ключ` и `node scripts\sync-faceit.mjs`. С `set FACEIT_DEBUG=1` скрипт дополнительно создаёт `data/filter-report.json`: сколько турниров отсеяно по каждой причине и примеры названий. Так видно, не выпадает ли нужное.

## 2. Обратная связь на почту (Formspree, бесплатно)
1. formspree.io → зарегистрироваться (почта dezhenkov62@gmail.com) → New form.
2. Скопировать адрес формы вида `https://formspree.io/f/xxxxxxx`.
3. В `index.html` вписать его в `const FEEDBACK_ENDPOINT = "…"`. Письма будут приходить на почту, на которую зарегистрирована форма. Лимит бесплатного тарифа — несколько десятков сообщений в месяц.

## 3. Аккаунты, роли и админ-панель (Supabase, бесплатно)
1. supabase.com → New project (регион поближе, придумайте пароль БД).
2. SQL Editor → New query → вставить `supabase/schema.sql` → Run.
3. Project Settings → API: скопировать **Project URL** и ключ **anon public**. В `index.html` вписать в `SUPABASE_URL` и `SUPABASE_ANON_KEY`. Ключ `service_role` в сайт вставлять нельзя.
4. Authentication → URL Configuration: в Site URL указать адрес сайта (например `https://olohav.github.io/faceit-updater-tournaments/`).
5. Зарегистрироваться на сайте почтой администратора, подтвердить письмо, затем в SQL Editor выполнить:
   `update public.profiles set role = 'admin' where email = 'dezhenkov62@gmail.com';`
6. Выйти и войти заново: в шапке появится «Администратор» и «Админ-панель».

Безопасность: права проверяет сама база (политики RLS), а не страница. Обычный пользователь не может ни добавить турнир, ни изменить свою роль, даже если подправит код в браузере.

## Роли
- **Пользователь**: регистрация и вход, форма обратной связи с подставленной почтой.
- **Администратор**: всё то же + вкладка «Админ-панель»: добавление, редактирование, удаление турниров, дата автоудаления.
