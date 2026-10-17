/*
 * Синхронизация турниров FACEIT -> data/faceit.json
 * Запуск:  FACEIT_API_KEY=ваш_ключ node scripts/sync-faceit.mjs
 * Нужен Node.js 18+ (встроенный fetch). Ключ берётся ТОЛЬКО из переменной окружения.
 * Отладка: FACEIT_DEBUG=1 — печатает «сырой» ответ API, чтобы сверить названия полей.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ================= НАСТРОЙКИ ================= */
const CONFIG = {
  // Игры FACEIT (game id в API). Valorant и MLBB на FACEIT не поддерживаются — для них нужны другие источники.
  games: { cs2: "CS2", dota2: "Dota 2" },
  // Статусы чемпионатов: upcoming — предстоящие, ongoing — идущие.
  types: ["upcoming", "ongoing"],
  // Регион FACEIT. Россия входит в EU. Пустая строка = без фильтра по региону.
  region: "EU",
  // Максимум чемпионатов на игру и статус (защита от бесконечной пагинации). Список идёт по возрастанию даты старта.
  maxPerQuery: 2000,
  // Не показывать турниры, стартующие позже чем через N дней (и прекращать листать список, дойдя до них).
  horizonDays: 150,
  // Минимум мест: отсекает тестовые и «дуэльные» турниры на 2–6 слотов.
  minSlots: 8,
  // Не включать организаторов по id (если знаете точный id — узнать можно через FACEIT_DEBUG=1).
  excludeOrganizerIds: ["faceit"],   // у турниров самой платформы organizer_id равен "faceit"
  // Регионы FACEIT, которые подходят (Россия входит в EU). Фильтр по полю region у самого турнира: параметр region в запросе API игнорирует. Пустой список = любые.
  allowedRegions: ["EU"],
  // Не включать турниры, где призы выдаются в FACEIT Points (поле prizes[].faceit_points).
  excludeFaceitPoints: true,
  // Организаторы-платформы: по имени организатора (турниры самого FACEIT не нужны).
  excludeOrganizerRegex: /^faceit$/i,
  // Не включать по названию: дуэли и мини-форматы (1v1, 2v2, wingman, aim, awp...), тесты, ежедневные кубки, FACEIT Points.
  excludeNameRegex: /\b(1v1|1x1|1vs1|1on1|2v2|2x2|3v3|duo|solo|wingman|aim|awp|pistol|duel|arena|showdown|daily|late night|test|тест)\b|faceit points|\bFP\b|\bhub\b/i,
  // Дополнительный поиск по названию (метод /search/championships): ловит нужные турниры, которых нет в первых страницах общего списка.
  // Если метод недоступен ключу — скрипт просто пропустит этот шаг.
  // Сколько результатов брать на один поисковый запрос.
  searchMaxPerQuery: 100,
  searchTerms: ["open qualifier", "qualifier", "квалификация", "CCT", "XPrime", "liga stavok", "лига ставок", "betboom", "winline", "russia", "россия", "снг", "cis"],
  // Серии, которые остаются в списке, даже если у турнира пока нет даты старта.
  alwaysIncludeRegex: /liga stavok|лига ставок|народная лига|\bCCT\b|russia|россия|\bCIS\b|СНГ/i,
  // Пропускать турниры, куда нельзя участвовать из России (whitelist_geo_countries без RU или blacklist_geo_countries с RU).
  requireRussiaIfCountryLimited: true,
  // Сколько запросов деталей чемпионата выполнять параллельно (бережём лимиты API).
  concurrency: 3,
};
/* ============================================= */

const API = "https://open.faceit.com/data/v4";
const KEY = process.env.FACEIT_API_KEY;
const DEBUG = !!process.env.FACEIT_DEBUG;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/faceit.json");

if (!KEY) {
  console.error("Не задана переменная окружения FACEIT_API_KEY.");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let notFoundQueries = 0, totalQueries = 0;

async function api(path, params = {}, attempt = 0) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + KEY, Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`FACEIT ответил ${res.status}: ключ неверный или это не «Server side API key». Создайте ключ типа Server side на https://developers.faceit.com/`);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(1500 * (attempt + 1));
    return api(path, params, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`FACEIT ${res.status} на ${url.pathname}${url.search}: ${(await res.text()).slice(0, 300) || "(пустой ответ)"}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function pagedFetch(path, base, tag, max = CONFIG.maxPerQuery) {
  const out = [];
  const limit = 10; // максимум, который отдают эти методы
  const horizon = addDays(ymd(Date.now()), CONFIG.horizonDays);
  for (let offset = 0; offset < max; offset += limit) {
    let page;
    try {
      page = await api(path, { ...base, region: CONFIG.region, offset, limit });
    } catch (e) {
      if (e.status !== 404) throw e;
      try {
        page = await api(path, { ...base, offset, limit });
      } catch (e2) {
        if (e2.status !== 404) throw e2;
        if (offset === 0) { notFoundQueries++; console.warn(`${tag}: 404 — ${e2.message}`); }
        break;
      }
    }
    const items = page.items || [];
    out.push(...items);
    if (items.length < limit) break;
    // Список отсортирован по дате старта: если вся страница уже за горизонтом — дальше листать незачем.
    const starts = items.map(c => ymd(c.championship_start)).filter(Boolean);
    if (starts.length === items.length && starts.every(d => d > horizon)) break;
    await sleep(120);
  }
  return out;
}

async function listChampionships(game, type) {
  totalQueries++;
  const items = await pagedFetch("/championships", { game, type }, `${game}/${type}`);
  if (type === "ongoing") for (const it of items) it._ongoing = true;
  return items;
}

async function searchChampionships(game, type, name) {
  try { return await pagedFetch("/search/championships", { name, game, type }, `поиск «${name}»`); }
  catch (e) { console.warn(`Поиск «${name}» пропущен: ${e.message}`); return []; }
}

/* Дата YYYY-MM-DD по Москве из миллисекунд/секунд/ISO. */
function ymd(v) {
  if (!v) return null;
  let ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1e12) ms *= 1000; // секунды -> миллисекунды
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

const orgCache = new Map();
async function organizerName(id, fallback) {
  if (fallback) return fallback;
  if (!id) return "Не указан";
  if (!orgCache.has(id)) {
    try { orgCache.set(id, (await api("/organizers/" + id)).name || "Не указан"); }
    catch { orgCache.set(id, "Не указан"); }
  }
  return orgCache.get(id);
}

/* Ограничения по странам из join_checks (названия полей подтверждены реальным ответом FACEIT). */
function allowedForRussia(c) {
  const jc = c.join_checks || {};
  const up = a => (Array.isArray(a) ? a : []).map(x => String(x).toUpperCase());
  const wl = up(jc.whitelist_geo_countries), bl = up(jc.blacklist_geo_countries);
  if (wl.length && !wl.includes("RU")) return false;   // разрешены только другие страны
  if (bl.includes("RU")) return false;                 // Россия в списке запрещённых
  return true;
}

function keep(c) {
  if (CONFIG.excludeOrganizerIds.includes(c.organizer_id)) return false;
  if (CONFIG.excludeNameRegex.test(c.name || "")) return false;
  if (!regionOk(c)) return false;
  if (CONFIG.excludeFaceitPoints && hasFaceitPoints(c)) return false;
  if (CONFIG.requireRussiaIfCountryLimited && !allowedForRussia(c)) return false;
  return true;
}

async function toSite(c, discName) {
  const today = ymd(Date.now());
  const start = ymd(c.championship_start);
  let end = ymd(c.championship_end);
  const tba = !start;
  if (!tba && (!end || end < start)) end = start;
  // Идущий турнир без даты окончания: держим в списке, пока API отдаёт его как ongoing.
  if (!tba && isRunning(c) && end < today) end = addDays(today, 7);

  const name = c.name || "Без названия";
  const isQual = /qualif|квалиф/i.test(name);
  const slots = Number(c.slots) || null;
  const op = await organizerName(c.organizer_id, c.organizer_name);
  const url = (c.faceit_url || `https://www.faceit.com/{lang}/championship/${c.championship_id}`).replace("{lang}", "ru");
  const regEnd = ymd(c.registration_end);
  const bits = [
    `${isQual ? "Открытая квалификация" : "Турнир"} на FACEIT (${discName}).`,
    slots ? `Мест: ${slots}${c.subscriptions_count != null ? `, заявок: ${c.subscriptions_count}` : ""}.` : "",
    regEnd ? `Регистрация до ${regEnd.split("-").reverse().join(".")}.` : "",
    c.description ? String(c.description).replace(/\s+/g, " ").slice(0, 400) : "",
  ].filter(Boolean);

  return {
    id: "fc-" + c.championship_id,
    name,
    kind: isQual ? "qualifier" : "main",
    disc: discName,
    format: "Online",
    city: "Онлайн (FACEIT)",
    ...(tba ? { tba: true } : { start, end }),
    prize: null,   // в API нет надёжного поля с валютой — при необходимости задайте вручную
    fee: null,
    op,
    teams: slots,
    platform: "FACEIT",
    desc: bits.join(" "),
    fee_note: "Условия участия и взнос — на странице турнира на FACEIT.",
    contact: "Регистрация — на странице турнира на FACEIT.",
    site: url,
    siteName: "Страница на FACEIT",
    social: [],
  };
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

const hasFaceitPoints = c => Array.isArray(c.prizes) && c.prizes.some(p => Number(p && p.faceit_points) > 0);
const isRunning = c => !!c._ongoing || /^(ongoing|started|running|live)$/i.test(c.status || "");
const regionOk = c => !CONFIG.allowedRegions.length || !c.region || CONFIG.allowedRegions.includes(String(c.region).toUpperCase());

/* Дешёвая предварительная фильтрация по данным списка — до запроса деталей. */
async function prefilter(c) {
  const today = ymd(Date.now());
  const horizon = addDays(today, CONFIG.horizonDays);
  const start = ymd(c.championship_start), end = ymd(c.championship_end) || start;
  if (!isRunning(c)) {
    if (start && start < today) return false;     // «предстоящий», но старт давно прошёл — заброшенный
    if (end && end < today) return false;
  }
  if (start && start > horizon) return false;
  if (!start && !isRunning(c) && !CONFIG.alwaysIncludeRegex.test(c.name || "")) return false; // без даты старта — заброшенные, кроме нужных серий
  if (!regionOk(c)) return false;
  if (CONFIG.excludeFaceitPoints && hasFaceitPoints(c)) return false;
  if (CONFIG.requireRussiaIfCountryLimited && !allowedForRussia(c)) return false;
  if (c.slots && Number(c.slots) < CONFIG.minSlots) return false;
  if (CONFIG.excludeNameRegex.test(c.name || "")) return false;
  if (CONFIG.excludeOrganizerIds.includes(c.organizer_id)) return false;
  const org = await organizerName(c.organizer_id, c.organizer_name);
  if (CONFIG.excludeOrganizerRegex.test(org)) return false;
  return true;
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
  if (totalQueries > 0 && notFoundQueries === totalQueries) {
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

  const kept = detailed.filter(({ c }) => keep(c));
  const tournaments = [];
  for (const { c, discName } of kept) tournaments.push(await toSite(c, discName));
  tournaments.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"));
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
