/*
 * Синхронизация турниров FACEIT -> data/faceit.json
 * Запуск:  FACEIT_API_KEY=ваш_ключ node scripts/sync-faceit.mjs
 * Нужен Node.js 18+ (встроенный fetch). Ключ берётся ТОЛЬКО из переменной окружения.
 * Отладка: FACEIT_DEBUG=1 — печатает «сырой» ответ API, чтобы сверить названия полей.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONFIG, KEY, DEBUG, OUT } from "./config.mjs";
import { stats, api, listChampionships, searchChampionships, organizerName, loadMatches } from "./api.mjs";
import { keep, prefilter, isRunning, bracketFinished } from "./filters.mjs";
import { toSite } from "./format.mjs";

if (!KEY) {
  console.error("Не задана переменная окружения FACEIT_API_KEY.");
  process.exit(1);
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}


async function main() {
  const byId = new Map();
  const add = (items, discName) => { for (const c of items) if (c.championship_id && !byId.has(c.championship_id)) byId.set(c.championship_id, { c, discName }); };

  for (const [game, discName] of Object.entries(CONFIG.games)) {
    for (const type of CONFIG.types) {
      const items = await listChampionships(game, type);
      console.log(`${game}/${type}: ${items.length}`);
      if (DEBUG && items[0]) console.log("RAW:", JSON.stringify(items[0], null, 2));
      add(items, discName);
    }
  }
  if (stats.total > 0 && stats.notFound === stats.total) {
    throw new Error("FACEIT вернул 404 на все запросы списка — вероятно, неверный адрес API или у ключа нет доступа. Запустите с FACEIT_DEBUG=1 и сверьте с https://docs.faceit.com/");
  }

  // Поиск по ключевым словам (необязательный шаг). У результатов поиска может быть другая форма записи
  // (например, competition_id вместо championship_id) и неполные данные, поэтому для новых находок берём детали.
  const idOf = c => c.championship_id || c.competition_id || c.id;
  const found = new Map();
  let termNo = 0;
  for (const term of CONFIG.searchTerms) {
    console.log(`Поиск ${++termNo}/${CONFIG.searchTerms.length}: «${term}»...`);
    for (const [game, discName] of Object.entries(CONFIG.games)) {
      for (const type of CONFIG.types) {
        const items = await searchChampionships(game, type, term);
        if (DEBUG && items[0] && !found.size) console.log("RAW search item:", JSON.stringify(items[0], null, 2));
        let fresh = 0;
        for (const it of items) {
          const id = idOf(it);
          if (!id || byId.has(id) || found.has(id)) continue;
          found.set(id, { it, id, discName });
          fresh++;
        }
        if (items.length) console.log(`  «${term}» ${game}/${type}: найдено ${items.length}, новых ${fresh}`);
      }
    }
  }
  if (found.size) {
    console.log(`Загружаю детали ${found.size} найденных поиском турниров...`);
    await pool([...found.values()], CONFIG.concurrency, async ({ it, id, discName }) => {
      try {
        const det = await api("/championships/" + id);
        byId.set(id, { c: { ...it, ...det, championship_id: id }, discName });
      } catch (e) { console.warn("Поиск: без деталей", id, e.message); }
    });
  }

  // Отладка: сохраняем «сырые» детали одного турнира FACEIT и одного стороннего — чтобы найти поле про FACEIT Points.
  if (DEBUG) {
    const sample = {};
    for (const { c } of byId.values()) {
      const org = await organizerName(c.organizer_id, c.organizer_name);
      const key = /^faceit$/i.test(org) ? "faceit_own" : "third_party";
      if (sample[key]) continue;
      try { sample[key] = { list_item: c, details: await api("/championships/" + c.championship_id) }; } catch (e) { sample[key] = { error: e.message }; }
      if (sample.faceit_own && sample.third_party) break;
    }
    const f = resolve(dirname(OUT), "raw-sample.json");
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(sample, null, 2));
    console.log("Отладочный образец записан:", f);
  }

  // Предварительные фильтры -> детали только для оставшихся -> финальные фильтры.
  const pre = [];
  console.log("Проверяю организаторов и применяю фильтры (это может занять пару минут)...");
  let n = 0;
  for (const e of byId.values()) {
    if (await prefilter(e.c)) pre.push(e);
    if (++n % 100 === 0) console.log(`  проверено ${n} из ${byId.size}`);
  }
  console.log(`Всего получено: ${byId.size}, после предварительных фильтров: ${pre.length}`);

  console.log(`Загружаю детали ${pre.length} турниров...`);
  const detailed = await pool(pre, CONFIG.concurrency, async ({ c, discName }) => {
    try { c = { ...c, ...(await api("/championships/" + c.championship_id)) }; } catch (e) { console.warn("Без деталей:", c.championship_id, e.message); }
    return { c, discName };
  });

  // Глубокая проверка идущих турниров по сетке: финал сыгран (или все матчи) -> турнир завершён.
  let finished = 0, shown = false;
  const checked = await pool(detailed, CONFIG.concurrency, async e => {
    if (!CONFIG.matchCheck || !isRunning(e.c)) return e;
    const m = await loadMatches(e.c.championship_id);
    if (DEBUG && m && m[0] && !shown) { shown = true; console.log("RAW match:", JSON.stringify(m[0], null, 2)); }
    if (m && bracketFinished(m, Number(e.c.total_rounds) || 0)) { finished++; return { ...e, done: true }; }
    return e;
  });
  console.log(`Завершены по сетке: ${finished}`);
  const kept = checked.filter(e => !e.done && keep(e.c));
  const tournaments = [];
  for (const { c, discName } of kept) tournaments.push(await toSite(c, discName));
  tournaments.sort((a, b) => (a.startsAt || "9999").localeCompare(b.startsAt || "9999") || a.name.localeCompare(b.name));
  console.log(`После финальных фильтров: ${tournaments.length}`);

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
}

main().catch(e => { console.error(e.message); process.exit(1); });
