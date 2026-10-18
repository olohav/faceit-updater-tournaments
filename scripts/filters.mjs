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

/* Дешёвая предварительная фильтрация по данным списка — до запроса деталей. */
export async function prefilter(c) {
  const today = ymd(Date.now());
  const horizon = addDays(today, CONFIG.horizonDays);
  const start = ymd(c.championship_start) || parseDescription(c.description).date, end = ymd(c.championship_end) || start;
  if (!isRunning(c)) {
    if (start && start < today) return false;     // «предстоящий», но старт давно прошёл — заброшенный
    if (end && end < today) return false;
  }
  if (isRunning(c) && start && start < addDays(today, -CONFIG.maxRunningDays) && !CONFIG.alwaysIncludeRegex.test(c.name || "")) return false;
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
