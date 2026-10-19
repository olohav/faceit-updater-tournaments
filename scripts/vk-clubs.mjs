/*
 * Сбор ПК-клубов России из ВКонтакте -> data/clubs.json
 * Запуск (cmd):         set VK_TOKEN=ваш_сервисный_ключ   затем   node vk-clubs.mjs
 * Запуск (PowerShell):  $env:VK_TOKEN="ваш_сервисный_ключ"; node vk-clubs.mjs
 * Нужен Node.js 18+. Файл положите в корень проекта (рядом с index.html).
 *
 * Как это работает (и чем отличается от прошлой версии):
 *   1. Ищем группы по тексту «компьютерный клуб Казань» и т.п. — справочник городов VK НЕ нужен.
 *   2. Для найденных групп запрашиваем профиль (groups.getById, поля city/country) и берём город из самой группы.
 *   3. Оставляем только Россию и только города из списка CITIES (по нему же определяется часовой пояс).
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

/* ================= НАСТРОЙКИ ================= */
const TOKEN = process.env.VK_TOKEN;
const V = "5.199";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = basename(HERE) === "scripts" ? resolve(HERE, "..") : HERE;   // скрипт можно держать и в корне, и в scripts/
const OUT = resolve(ROOT, "data/clubs.json");
const DEBUG = !!process.env.VK_DEBUG;          // VK_DEBUG=1 — печатать «сырые» ответы

// Город -> часовой пояс. Добавляйте свои города сюда (название как в ВК).
const CITIES = {
  "Москва": "+03:00", "Санкт-Петербург": "+03:00", "Казань": "+03:00", "Нижний Новгород": "+03:00", "Воронеж": "+03:00",
  "Ростов-на-Дону": "+03:00", "Краснодар": "+03:00", "Волгоград": "+03:00", "Ярославль": "+03:00", "Тула": "+03:00",
  "Рязань": "+03:00", "Липецк": "+03:00", "Сочи": "+03:00", "Калининград": "+02:00",
  "Самара": "+04:00", "Саратов": "+04:00", "Ульяновск": "+04:00", "Астрахань": "+04:00", "Ижевск": "+04:00",
  "Екатеринбург": "+05:00", "Челябинск": "+05:00", "Уфа": "+05:00", "Пермь": "+05:00", "Тюмень": "+05:00", "Оренбург": "+05:00",
  "Омск": "+06:00", "Новосибирск": "+07:00", "Красноярск": "+07:00", "Томск": "+07:00", "Кемерово": "+07:00", "Барнаул": "+07:00",
  "Иркутск": "+08:00", "Улан-Удэ": "+08:00", "Чита": "+09:00", "Якутск": "+09:00",
  "Владивосток": "+10:00", "Хабаровск": "+10:00", "Южно-Сахалинск": "+11:00", "Магадан": "+11:00", "Петропавловск-Камчатский": "+12:00",
};

// Соответствие номера города ВК (city.id) названию из CITIES. Работает, даже если ВК отдаёт названия городов искажёнными.
// Москва = 1, Санкт-Петербург = 2. Остальные номера появятся в data/vk-unknown-cities.txt: впишите их сюда, например 60: "Казань".
const CITY_IDS = {
  1: "Москва", 2: "Санкт-Петербург", 60: "Казань", 72: "Краснодар", 110: "Пермь", 119: "Ростов-на-Дону", 151: "Уфа",
  99: "Новосибирск", 49: "Екатеринбург", 42: "Воронеж", 73: "Красноярск", 123: "Самара", 158: "Челябинск", 125: "Саратов",
};

// Поисковые фразы. К каждой добавляется название города. Меньше фраз = быстрее.
const QUERIES = ["компьютерный клуб", "игровой клуб", "гейм клуб", "киберклуб", "пк клуб", "cyber club", "gaming club"];
const TYPES = ["group", "page"];               // обычные группы и публичные страницы
const ONLY_OPEN = true;                        // закрытые группы пропускаем: их стену всё равно не прочитать
const KEEP_UNKNOWN_CITIES = false;             // true — не выбрасывать клубы из городов, которых нет в CITIES (tz будет null)

// Двухуровневый отбор по названию (физический клуб, а не «сообщество про игры»):
//  1) сильное совпадение в названии — клуб сразу;
//  2) слабое совпадение (cyber, gaming, игров…) — клуб, только если это подтверждает описание группы.
const CLUB_NAME = /(компьютерн\S*\s+(игров\S*\s+)?клуб|игров\S*\s+(компьютерн\S*\s+)?клуб|гейм[\s-]?клуб|(game|gaming|gamer|games)[\s-]?club|пк[\s-]?клуб|pc[\s-]?club|компьютерн\S*\s+(зал|центр|холл)|кибер\S*[\s-]*(клуб|арена|зона|кафе|центр|зал)|cyber\S*[\s-]*(club|zone|arena|cafe|center|space|hall)|(gaming|game)[\s-]?(zone|space|lounge|center|arena)|игров\S*\s+(зона|зал|центр|пространство))/i;
const WEAK_NAME = /(cyber|кибер|gaming|game|игров|гейм|арена|arena|pc\b|пк\b|esport|киберспорт)/i;
const STRONG_DESC = /(компьютерный клуб|игровой клуб|гейм[\s-]?клуб|пк[\s-]?клуб|pc[\s-]?club|cyber[\s-]?club|gaming club|киберклуб|компьютерный зал|игровая зона)/i;
const EXCLUDE = /(вакансии|работа|продам|куплю|обмен|мемы|фитнес|fitness|ночной клуб|night ?club|стриптиз|караоке|бильярд|боулинг|йога|танц|стадион|хоккей|футбол|баскет|ледов|конкурс|розыгрыш|скидки|подслушано|форум|чат|сообщество игроков|читы|аккаунт)/i;
const CACHE = resolve(ROOT, "data/vk-search-cache.json");   // результаты поиска: повторный запуск не ищет заново
const USE_CACHE = !!process.env.VK_USE_CACHE;   // VK_USE_CACHE=1 — пропустить поиск и взять сохранённое
/* ============================================= */

if (!TOKEN) {
  console.error("Не задана переменная VK_TOKEN. В cmd:  set VK_TOKEN=ваш_ключ   (без кавычек и пробелов)");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Сравнение названий городов: убираем невидимые символы, HTML-коды, регистр и ё/е. */
const norm = s => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&")
  .normalize("NFKC").toLowerCase().replace(/ё/g, "е")
  .replace(/[^\p{L}\p{N}\- ]/gu, "").replace(/\s+/g, " ").trim();
const ascii = s => String(s).replace(/[^\x20-\x7e]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));   // для диагностики: показывает коды символов
const CITY_BY_NORM = new Map(Object.entries(CITIES).map(([c, tz]) => [norm(c), { city: c, tz }]));

/* Вызов метода VK с повторами при «слишком часто». */
async function vk(method, params = {}) {
  const body = new URLSearchParams({ lang: "0", ...params, access_token: TOKEN, v: V });   // lang=0: названия городов по-русски
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(350); // лимит ~3 запроса в секунду
    const res = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
    const data = await res.json();
    if (DEBUG) console.log(method, JSON.stringify(data).slice(0, 400));
    if (!data.error) return data.response;
    const { error_code: code, error_msg: msg } = data.error;
    if (code === 6 || code === 9) { await sleep(1500 * (attempt + 1)); continue; }   // слишком часто — подождать
    const hint = code === 5 ? " (неверный или просроченный ключ)" : [15, 27, 28, 3610].includes(code) ? " (этот метод недоступен для сервисного ключа — см. подсказку ниже)" : "";
    const err = new Error(`VK ${method}: [${code}] ${msg}${hint}`);
    err.code = code; throw err;
  }
  throw new Error(`VK ${method}: превышен лимит запросов`);
}

/* Профили групп: город и страна берутся отсюда. Метод принимает до 500 id за раз. */
async function groupProfiles(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const r = await vk("groups.getById", { group_ids: ids.slice(i, i + 400).join(","), fields: "city,country,members_count,activity,description,site" });
    out.push(...(Array.isArray(r) ? r : r.groups || []));   // у разных версий API формат ответа разный
  }
  return out;
}

async function main() {
  // Проверка ключа до долгой работы: если поиск недоступен, узнаем об этом сразу.
  try { await vk("groups.search", { q: "компьютерный клуб", type: "group", count: 1 }); console.log("Ключ работает, поиск групп доступен."); }
  catch (e) {
    console.error("\n" + e.message);
    console.error("Если ошибка про права или тип токена: сервисный ключ не открывает поиск групп. Нужен пользовательский токен (VK ID / implicit flow). Пришлите текст ошибки, подскажу шаги.");
    process.exit(1);
  }

  const found = new Map();   // id -> базовые данные из поиска
  const cities = Object.keys(CITIES);
  let cached = false;
  if (USE_CACHE) {
    try { for (const [id, name, sn, cl] of JSON.parse(await readFile(CACHE, "utf8"))) found.set(id, { id, name, screen_name: sn, is_closed: cl }); cached = found.size > 0; console.log(`Взято из кэша: ${found.size} групп (поиск пропущен).`); }
    catch { console.log("Кэша нет — выполняю поиск."); }
  }
  if (!cached) {
    let n = 0;
    for (const city of cities) {
      let added = 0;
      for (const q of QUERIES) for (const type of TYPES) {
        let items = [];
        try { items = (await vk("groups.search", { q: `${q} ${city}`, type, count: 1000 })).items || []; }
        catch (e) { console.warn(`  ${city} / «${q}»: ${e.message}`); continue; }
        for (const g of items) if (!found.has(g.id)) { found.set(g.id, g); added++; }
      }
      console.log(`[${++n}/${cities.length}] ${city}: новых групп ${added}, всего кандидатов ${found.size}`);
    }
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify([...found.values()].map(g => [g.id, g.name, g.screen_name, g.is_closed])), "utf8");
  }

  // Отбор по названию ДО запроса профилей: профили нужны только возможным клубам.
  const tier = new Map(), dropped = { notRussia: 0, noCity: 0, closed: 0, notClub: 0 };
  for (const g of found.values()) {
    const name = g.name || "";
    if (ONLY_OPEN && g.is_closed !== 0) { dropped.closed++; continue; }
    if (EXCLUDE.test(name)) { dropped.notClub++; continue; }
    if (CLUB_NAME.test(name)) tier.set(g.id, 1); else if (WEAK_NAME.test(name)) tier.set(g.id, 2); else dropped.notClub++;
  }
  console.log(`\nПо названию подходят: ${[...tier.values()].filter(t => t === 1).length} (точно) + ${[...tier.values()].filter(t => t === 2).length} (нужна проверка по описанию). Запрашиваю профили (там указан город)...`);
  const profiles = await groupProfiles([...tier.keys()]);

  // Автоопределение номеров городов: в названиях и описаниях групп встречаются названия городов («… клуб Уфа»).
  // Для каждого city.id считаем, какой город упоминается чаще всего; при уверенном перевесе запоминаем соответствие.
  const stemRe = c => {
    const t = norm(c).split(/[- ]/), cut = w => w.slice(0, Math.max(4, w.length - 2));
    const body = t.length > 1 && t[0].length >= 6 ? cut(t[0]) : t.map(cut).join("[- ]\\S*");
    return new RegExp("(^|[^\\p{L}])" + body, "u");
  };
  const cityRes = Object.keys(CITIES).map(c => ({ city: c, re: stemRe(c) }));
  const votes = new Map(), perId = new Map();
  for (const g of profiles) {
    const id = g.city && g.city.id;
    if (!id || CITY_IDS[id] || (g.country && g.country.id !== 1)) continue;
    perId.set(id, (perId.get(id) || 0) + 1);
    const text = norm(`${g.name || ""} ${(g.description || "").slice(0, 500)}`);
    for (const { city, re } of cityRes) if (re.test(text)) { const m = votes.get(id) || new Map(); m.set(city, (m.get(city) || 0) + 1); votes.set(id, m); }
  }
  const learned = {};
  for (const [id, m] of votes) {
    const [city, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    if (n >= 3 && n / perId.get(id) >= 0.2) learned[id] = city;
  }
  const learnedList = Object.entries(learned);
  if (learnedList.length) console.log(`\nГорода определены автоматически по названиям групп: ${learnedList.length}. Чтобы закрепить, добавьте в CITY_IDS:\n  ` + learnedList.map(([id, c]) => `${id}: "${c}"`).join(", "));

  const clubs = new Map(), unknown = new Map();
  let garbled = 0;
  for (const g of profiles) {
    const base = found.get(g.id) || g;
    if (g.country && g.country.id !== 1) { dropped.notRussia++; continue; }
    if (tier.get(g.id) === 2 && !STRONG_DESC.test(`${g.activity || ""} ${g.description || ""}`)) { dropped.notClub++; continue; }
    const cityTitle = g.city && g.city.title, cityId = g.city && g.city.id;
    if (!cityTitle && !cityId) { dropped.noCity++; continue; }
    if (/^[?\d\-\s]+$/.test(cityTitle || "")) garbled++;
    const byId = (CITY_IDS[cityId] || learned[cityId]) && CITY_BY_NORM.get(norm(CITY_IDS[cityId] || learned[cityId]));
    const known = byId || CITY_BY_NORM.get(norm(cityTitle));
    if (!known && !KEEP_UNKNOWN_CITIES) {
      const u = unknown.get(cityId) || { id: cityId, title: cityTitle, count: 0, examples: [] };
      u.count++; if (u.examples.length < 3) u.examples.push((g.name || base.name || "").trim());
      unknown.set(cityId, u); continue;
    }
    const domain = g.screen_name || base.screen_name || `club${g.id}`;
    if (!clubs.has(domain)) clubs.set(domain, { domain, name: (g.name || base.name || "").trim(), city: known ? known.city : cityTitle, tz: known ? known.tz : null, members: g.members_count ?? null, url: `https://vk.com/${domain}` });
  }
  if (garbled) console.log(`\nВнимание: у ${garbled} групп название города пришло искажённым («?4?…»). Такие города определяются только по номеру (CITY_IDS).`);

  const result = [...clubs.values()].sort((a, b) => a.city.localeCompare(b.city, "ru") || (b.members || 0) - (a.members || 0) || a.name.localeCompare(b.name, "ru"));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(result, null, 2), "utf8");

  const byCity = result.reduce((m, c) => ((m[c.city] = (m[c.city] || 0) + 1), m), {});
  console.log(`\nГотово: ${result.length} клубов -> ${OUT}`);
  console.log("По городам:", Object.entries(byCity).map(([c, k]) => `${c} ${k}`).join(", ") || "—");
  console.log("Отсеяно:", `не Россия ${dropped.notRussia}, закрытые ${dropped.closed}, не похожи на клуб ${dropped.notClub}, город не указан ${dropped.noCity}`);

  if (unknown.size) {
    const top = [...unknown.values()].sort((a, b) => b.count - a.count);
    const file = resolve(dirname(OUT), "vk-unknown-cities.txt");
    await writeFile(file, top.map(u => `${u.count}\tid=${u.id}\t${u.title}\t${u.examples.join(" | ")}`).join("\n"), "utf8");
    console.log(`\nКлубов из городов вне списка: ${top.reduce((n, u) => n + u.count, 0)}. Полный список: ${file}`);
    console.log("Самые частые города (номер, сколько клубов, примеры названий групп: по ним видно, какой это город):");
    for (const u of top.slice(0, 12)) console.log(`  id=${u.id}  клубов ${u.count}  | ${u.examples.join("  |  ")}`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
