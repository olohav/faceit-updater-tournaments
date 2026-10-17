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
  // Максимум чемпионатов на игру и статус (защита от бесконечной пагинации).
  maxPerQuery: 300,
  // Не включать турниры самой платформы (по id организатора). FACEIT-овский id организатора
  // узнайте через FACEIT_DEBUG=1 и впишите сюда.
  excludeOrganizerIds: [],
  // Не включать по названию (турниры с FACEIT Points, собственные лиги платформы и т.п.).
  excludeNameRegex: /faceit points|\bFP\b|^FACEIT (league|cup|premium)|\bhub\b/i,
  // Явно включать (даже если сработает фильтр стран) — по подстроке в названии.
  alwaysIncludeRegex: /liga stavok|лига ставок|народная лига|\bCCT\b|russia|россия|\bCIS\b|СНГ/i,
  // Если у турнира указан список разрешённых стран и в нём нет RU — пропускаем.
  requireRussiaIfCountryLimited: true,
  // Сколько запросов деталей чемпионата выполнять параллельно (бережём лимиты API).
  concurrency: 3,
};
/* ============================================= */

const API = "https://open.faceit.com/api/data/v4";
const KEY = process.env.FACEIT_API_KEY;
const DEBUG = !!process.env.FACEIT_DEBUG;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/faceit.json");

if (!KEY) {
  console.error("Не задана переменная окружения FACEIT_API_KEY.");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (!res.ok) throw new Error(`FACEIT ${res.status} на ${url.pathname}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function listChampionships(game, type) {
  const out = [];
  const limit = 10; // максимум, который отдаёт этот метод
  for (let offset = 0; offset < CONFIG.maxPerQuery; offset += limit) {
    const page = await api("/championships", { game, type, region: CONFIG.region, offset, limit });
    const items = page.items || [];
    out.push(...items);
    if (items.length < limit) break;
    await sleep(150);
  }
  return out;
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

function countryLimit(c) {
  const jc = c.join_checks || {};
  const list = jc.allowed_team_countries || jc.allowed_countries || c.allowed_team_countries || [];
  return Array.isArray(list) ? list.map(x => String(x).toUpperCase()) : [];
}

function keep(c) {
  const name = c.name || "";
  if (CONFIG.excludeOrganizerIds.includes(c.organizer_id)) return false;
  if (CONFIG.excludeNameRegex.test(name)) return false;
  if (CONFIG.requireRussiaIfCountryLimited) {
    const lim = countryLimit(c);
    if (lim.length && !lim.includes("RU") && !CONFIG.alwaysIncludeRegex.test(name)) return false;
  }
  return true;
}

async function toSite(c, discName) {
  const today = ymd(Date.now());
  const start = ymd(c.championship_start);
  let end = ymd(c.championship_end);
  const tba = !start;
  if (!tba && (!end || end < start)) end = start;
  // Идущий турнир без даты окончания: держим в списке, пока API отдаёт его как ongoing.
  if (!tba && c.status === "ongoing" && end < today) end = addDays(today, 7);

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

async function main() {
  const byId = new Map();
  for (const [game, discName] of Object.entries(CONFIG.games)) {
    for (const type of CONFIG.types) {
      const items = await listChampionships(game, type);
      console.log(`${game}/${type}: ${items.length}`);
      if (DEBUG && items[0]) console.log("RAW:", JSON.stringify(items[0], null, 2));
      for (const c of items) byId.set(c.championship_id, { c, discName });
    }
  }

  // Детали каждого чемпионата (join_checks, описание), затем фильтры.
  const detailed = await pool([...byId.values()], CONFIG.concurrency, async ({ c, discName }) => {
    try { c = { ...c, ...(await api("/championships/" + c.championship_id)) }; } catch (e) { console.warn("Без деталей:", c.championship_id, e.message); }
    return { c, discName };
  });

  const kept = detailed.filter(({ c }) => keep(c));
  const tournaments = [];
  for (const { c, discName } of kept) tournaments.push(await toSite(c, discName));
  tournaments.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"));
  console.log(`Всего получено: ${byId.size}, после фильтров: ${tournaments.length}`);

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
