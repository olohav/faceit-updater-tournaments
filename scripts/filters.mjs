/* Фильтры: страны (RU), регион, FACEIT Points, названия, организаторы, давно идущие турниры. */
import { CONFIG } from "./config.mjs";
import { ymd, addDays } from "./dates.mjs";
import { organizerName } from "./api.mjs";
import { parseDescription } from "./parse.mjs";

/* Ограничения по странам из join_checks (названия полей подтверждены реальным ответом FACEIT). */
function allowedForRussia(c) {
  const jc = c.join_checks || {};
  const up = a => (Array.isArray(a) ? a : []).map(x => String(x).toUpperCase());
  const wl = up(jc.whitelist_geo_countries), bl = up(jc.blacklist_geo_countries);
  if (wl.length && !wl.includes("RU")) return false;   // разрешены только другие страны
  if (bl.includes("RU")) return false;                 // Россия в списке запрещённых
  return true;
}

export function keep(c) {
  if (/^(finished|cancell?ed|closed)$/i.test(c.status || "")) return false;   // завершён или отменён
  if (CONFIG.excludeOrganizerIds.includes(c.organizer_id)) return false;
  if (CONFIG.excludeNameRegex.test(c.name || "")) return false;
  if (!regionOk(c)) return false;
  if (CONFIG.excludeFaceitPoints && hasFaceitPoints(c)) return false;
  if (CONFIG.requireRussiaIfCountryLimited && !allowedForRussia(c)) return false;
  return true;
}

const hasFaceitPoints = c => Array.isArray(c.prizes) && c.prizes.some(p => Number(p && p.faceit_points) > 0);
export const isRunning = c => !!c._ongoing || /^(ongoing|started|running|live)$/i.test(c.status || "");
const regionOk = c => !CONFIG.allowedRegions.length || !c.region || CONFIG.allowedRegions.includes(String(c.region).toUpperCase());

/* Счётчики причин отсева: видны в консоли, а в режиме FACEIT_DEBUG=1 попадают в data/filter-report.json. */
export const dropped = { counts: {}, samples: {} };
const drop = (why, c) => {
  dropped.counts[why] = (dropped.counts[why] || 0) + 1;
  (dropped.samples[why] ||= []).length < 12 && dropped.samples[why].push(`${c.name} [${c.region || "?"}, слотов ${c.slots ?? "?"}]`);
  return why;
};

/* Быстрая проверка по данным списка — без сети. Возвращает причину отсева или null. */
export function reject(c) {
  const today = ymd(Date.now());
  const horizon = addDays(today, CONFIG.horizonDays);
  const start = ymd(c.championship_start) || parseDescription(c.description).date, end = ymd(c.championship_end) || start;
  const always = CONFIG.alwaysIncludeRegex.test(c.name || "");
  const run = isRunning(c);
  if (/^(finished|cancell?ed|aborted|closed)$/i.test(c.status || "")) return drop("завершён/отменён", c);
  if (!run) {
    if (start && start < today) return drop("старт в прошлом", c);
    if (end && end < today) return drop("окончание в прошлом", c);
  }
  if (run && start && start < addDays(today, -CONFIG.maxRunningDays) && !always) return drop("идёт слишком давно", c);
  if (start && start > horizon) return drop("дальше горизонта", c);
  if (!start && !run && !always) {
    // Без даты старта, но регистрация ещё открыта — это живой турнир, который просто не назначил дату.
    const regOpen = Number(c.subscription_end) > Date.now();
    if (!regOpen) return drop("нет даты старта", c);
  }
  if (!regionOk(c)) return drop("регион " + c.region, c);
  if (CONFIG.excludeFaceitPoints && hasFaceitPoints(c)) return drop("FACEIT Points", c);
  if (CONFIG.requireRussiaIfCountryLimited && !allowedForRussia(c)) return drop("ограничение по странам", c);
  if (c.slots && Number(c.slots) < CONFIG.minSlots) return drop("мало мест", c);
  if (CONFIG.excludeNameRegex.test(c.name || "")) return drop("название (дуэль/тест/хаб)", c);
  if (CONFIG.excludeOrganizerIds.includes(c.organizer_id)) return drop("организатор FACEIT", c);
  return null;
}

/* Вторая проверка — по имени организатора (нужно знать имя, оно берётся из кэша/API). */
export const rejectOrg = (c, org) => (CONFIG.excludeOrganizerRegex.test(org) ? drop("организатор FACEIT", c) : null);

/* Признак российской направленности: кириллица, RU в whitelist, известный организатор или серия. */
export function ruSignal(c, org = "") {
  const wl = ((c.join_checks || {}).whitelist_geo_countries || []).map(x => String(x).toUpperCase());
  return wl.includes("RU") || /[а-яё]/i.test(`${c.name} ${c.description} ${org}`) || CONFIG.ruOrganizerRegex.test(`${c.name} ${org}`) || CONFIG.alwaysIncludeRegex.test(c.name || "");
}

const DONE = /^(finished|cancell?ed|aborted)$/i, LIVE = /^(ongoing|ready|configuring|voting|captain_pick)$/i;
const toMs = v => { const n = Number(v) || 0; return n && n < 1e12 ? n * 1000 : n; };

/* Завершена ли сетка: сыгран финал последнего раунда, либо сыграны все матчи и прошло время, либо давно нет игр. */
export function bracketFinished(matches, totalRounds) {
  if (!matches.length) return false;
  const fin = matches.filter(m => DONE.test(m.status || ""));
  const live = matches.some(m => LIVE.test(m.status || ""));
  const quiet = (Date.now() - Math.max(0, ...fin.map(m => toMs(m.finished_at)))) / 36e5;   // часов с последнего матча
  const top = Math.max(0, ...matches.map(m => Number(m.round) || 0));
  const finalDone = totalRounds > 0 && top >= totalRounds && matches.filter(m => Number(m.round) === top).every(m => DONE.test(m.status || ""));
  if (finalDone) return true;
  if (live || !fin.length) return false;
  return (fin.length === matches.length && quiet > CONFIG.finishGraceHours) || quiet > CONFIG.idleDays * 24;
}
