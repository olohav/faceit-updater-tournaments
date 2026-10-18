/*
 * Синхронизация турниров FACEIT -> data/faceit.json
 * Запуск:  FACEIT_API_KEY=ваш_ключ node scripts/sync-faceit.mjs
 * Нужен Node.js 18+ (встроенный fetch). Ключ берётся ТОЛЬКО из переменной окружения.
 * Отладка: FACEIT_DEBUG=1 — «сырой» ответ API и отчёт об отсеве (data/filter-report.json).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONFIG, KEY, DEBUG, OUT } from "./config.mjs";
import { stats, api, pool, listChampionships, searchChampionships, organizerName, loadOrgCache, saveOrgCache, loadMatches } from "./api.mjs";
import { keep, reject, rejectOrg, isRunning, bracketFinished, dropped } from "./filters.mjs";
import { toSite } from "./format.mjs";

if (!KEY) {
  console.error("Не задана переменная окружения FACEIT_API_KEY.");
  process.exit(1);
}

const t0 = Date.now();
const lap = label => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} с] ${label}`);
const idOf = c => c.championship_id || c.competition_id || c.id;

async function main() {
  await loadOrgCache();
  const byId = new Map();
  const games = Object.entries(CONFIG.games);

  // 1. Общие списки: все пары игра × статус одновременно.
  const combos = games.flatMap(([game, disc]) => CONFIG.types.map(type => ({ game, disc, type })));
  const lists = await pool(combos, combos.length, async ({ game, disc, type }) => ({ game, disc, type, items: await listChampionships(game, type) }));
  for (const { game, disc, type, items } of lists) {
    console.log(`${game}/${type}: ${items.length}`);
    if (DEBUG && items[0]) console.log("RAW:", JSON.stringify(items[0], null, 2));
    for (const c of items) if (c.championship_id && !byId.has(c.championship_id)) byId.set(c.championship_id, { c, discName: disc });
  }
  if (stats.total > 0 && stats.notFound === stats.total) {
    throw new Error("FACEIT вернул 404 на все запросы списка — вероятно, неверный адрес API или у ключа нет доступа. Запустите с FACEIT_DEBUG=1.");
  }
  lap("общие списки загружены");

    // 2. Поиск по ключевым словам — с защитой от зависания и выводом проблемных слов
  const jobs = CONFIG.searchTerms.flatMap(term => combos.map(k => ({ term, ...k })));
  const found = new Map();
  let done = 0;
  
  await pool(jobs, CONFIG.concurrency, async ({ term, game, disc, type }) => {
    // Создаем защитный таймаут на 5 секунд для каждого поискового запроса
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Превышено время ожидания для слова "${term}"`)), 5000)
    );

    try {
      // Запускаем гонку: либо поиск сработает быстрее 5 секунд, либо сработает таймаут
      const items = await Promise.race([
        searchChampionships(game, type, term),
        timeoutPromise
      ]);

      if (DEBUG && items[0] && !found.size) console.log("RAW search item:", JSON.stringify(items[0], null, 2));
      for (const it of items) { 
        const id = idOf(it); 
        if (id && !byId.has(id) && !found.has(id)) {
          found.set(id, { it, id, discName: disc, running: type === "ongoing" }); 
        }
      }
    } catch (e) {
      // Если запрос завис или выдал ошибку, просто пишем об этом в консоль и НЕ ломаем скрипт
      console.warn(`\n[Внимание] Запрос пропущен (${game}/${type}): ${e.message}`);
    }
    
    // Выводим лог чаще (каждые 4 запроса вместо 40), чтобы видеть точный прогресс в конце
    done++;
    if (done % 4 === 0 || done > 200) {
      lap(`поиск: ${done} из ${jobs.length} запросов, новых находок ${found.size}`);
    }
  });

  // У находок поиска детали нужны, только если в записи нет данных о странах/датах.
  const needDetails = [...found.values()].filter(({ it }) => !it.join_checks || it.championship_start === undefined);
  for (const { it, id, discName, running } of found.values()) if (!needDetails.some(x => x.id === id)) byId.set(id, { c: { ...it, championship_id: id, _ongoing: running || undefined }, discName });
  await pool(needDetails, CONFIG.concurrency, async ({ it, id, discName, running }) => {
    try { byId.set(id, { c: { ...it, ...(await api("/championships/" + id)), championship_id: id, _ongoing: running || undefined }, discName }); }
    catch (e) { console.warn("Поиск: без деталей", id, e.message); }
  });
  lap(`поиск завершён: новых ${found.size} (деталей запрошено ${needDetails.length})`);

  // 3. Быстрые фильтры без сети.
  let pre = [...byId.values()].filter(e => !reject(e.c));
  console.log(`Всего получено: ${byId.size}, после быстрых фильтров: ${pre.length}`);

  // 4. Имена организаторов — только для оставшихся и параллельно (плюс кэш на диске).
  const orgIds = [...new Set(pre.map(e => e.c.organizer_id).filter(Boolean))];
  await pool(orgIds, CONFIG.concurrency, id => organizerName(id));
  const orgOf = async c => organizerName(c.organizer_id, c.organizer_name);
  const withOrg = [];
  for (const e of pre) { const org = await orgOf(e.c); if (!rejectOrg(e.c, org)) withOrg.push(e); }
  pre = withOrg;
  await saveOrgCache();
  lap(`организаторы проверены, осталось ${pre.length}`);

  // 5. Детали и сетка — только для идущих турниров (в списке есть почти всё, кроме total_rounds и расписания).
  let finished = 0, shown = false;
  const checked = await pool(pre, CONFIG.concurrency, async e => {
    if (!isRunning(e.c)) return e;
    try { e = { ...e, c: { ...e.c, ...(await api("/championships/" + e.c.championship_id)) } }; } catch {}
    if (!CONFIG.matchCheck) return e;
    const m = await loadMatches(e.c.championship_id);
    if (DEBUG && m && m[0] && !shown) { shown = true; console.log("RAW match:", JSON.stringify(m[0], null, 2)); }
    if (m && bracketFinished(m, Number(e.c.total_rounds) || 0)) { finished++; return { ...e, done: true }; }
    return e;
  });
  console.log(`Завершены по сетке: ${finished}`);
  lap("идущие турниры проверены");

  const kept = checked.filter(e => !e.done && keep(e.c));
  const tournaments = [];
  for (const { c, discName } of kept) tournaments.push(await toSite(c, discName));
  tournaments.sort((a, b) => (a.startsAt || a.start || "9999").localeCompare(b.startsAt || b.start || "9999") || a.name.localeCompare(b.name));
  console.log(`После финальных фильтров: ${tournaments.length}, из них с российским фокусом: ${tournaments.filter(t => t.ru).length}`);
  console.log("Отсев по причинам:", JSON.stringify(dropped.counts));

  if (DEBUG) {
    const f = resolve(dirname(OUT), "filter-report.json");
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(dropped, null, 2));
    console.log("Отчёт об отсеве:", f);
  }

  // Если содержимое не изменилось — файл не трогаем (чтобы не плодить коммиты).
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  if (prev && JSON.stringify(prev.tournaments) === JSON.stringify(tournaments)) {
    console.log("Изменений нет.");
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: "FACEIT Data API v4", count: tournaments.length, tournaments }, null, 2) + "\n");
  console.log("Записано:", OUT);
  lap("готово");
}

main().catch(e => { console.error(e.message); process.exit(1); });
