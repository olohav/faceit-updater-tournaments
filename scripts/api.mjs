/* Запросы к FACEIT Data API: постраничная загрузка, поиск, организаторы. */
import { CONFIG, API, KEY } from "./config.mjs";
import { ymd, addDays } from "./dates.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const stats = { notFound: 0, total: 0 };   // счётчики 404 для проверки адреса API

export async function api(path, params = {}, attempt = 0) {
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
        if (offset === 0) { stats.notFound++; console.warn(`${tag}: 404 — ${e2.message}`); }
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

export async function listChampionships(game, type) {
  stats.total++;
  const items = await pagedFetch("/championships", { game, type }, `${game}/${type}`);
  if (type === "ongoing") for (const it of items) it._ongoing = true;
  return items;
}

export async function searchChampionships(game, type, name) {
  try { return await pagedFetch("/search/championships", { name, game, type }, `поиск «${name}»`); }
  catch (e) { console.warn(`Поиск «${name}» пропущен: ${e.message}`); return []; }
}


const orgCache = new Map();
/* Матчи чемпионата (до matchesMaxPages страниц). При ошибке null: тогда решаем по остальным данным. */
export async function loadMatches(id) {
  const out = [];
  try {
    for (let p = 0; p < CONFIG.matchesMaxPages; p++) {
      const items = (await api(`/championships/${id}/matches`, { type: "all", offset: p * 100, limit: 100 })).items || [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  } catch (e) { return null; }
}

export async function organizerName(id, fallback) {
  if (fallback) return fallback;
  if (!id) return "Не указан";
  if (!orgCache.has(id)) {
    try { orgCache.set(id, (await api("/organizers/" + id)).name || "Не указан"); }
    catch { orgCache.set(id, "Не указан"); }
  }
  return orgCache.get(id);
}
