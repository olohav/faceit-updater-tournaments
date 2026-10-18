/* Превращает чемпионат FACEIT в запись для сайта. */
import { ymd, addDays, startsAt } from "./dates.mjs";
import { organizerName } from "./api.mjs";
import { isRunning, ruSignal } from "./filters.mjs";
import { parseDescription, parseRegEnd } from "./parse.mjs";

export async function toSite(c, discName) {
  const today = ymd(Date.now());
  const info = parseDescription(c.description);   // дата и призы из описания
  const start = ymd(c.championship_start) || info.date;
  let end = ymd(c.championship_end);
  const tba = !start;
  if (!tba && (!end || end < start)) end = start;
  // Идущий турнир без даты окончания: держим в списке, пока API отдаёт его как ongoing.
  if (!tba && isRunning(c) && end < today) end = addDays(today, 7);

  const at = startsAt(c.championship_start) || info.at;
  const endUnknown = !!start && isRunning(c) && !c.championship_end;   // у идущего турнира API не даёт дату окончания
  const name = c.name || "Без названия";
  const isQual = /qualif|квалиф/i.test(name);
  const slots = Number(c.slots) || null;
  const op = await organizerName(c.organizer_id, c.organizer_name);
  const url = (c.faceit_url || `https://www.faceit.com/{lang}/championship/${c.championship_id}`).replace("{lang}", "ru");
  // Конец регистрации: поле subscription_end из API, иначе дата из описания.
  const reg = parseRegEnd(c.description);
  const regEndAt = startsAt(c.subscription_end) || startsAt(c.registration_end) || reg.at || reg.date || null;
  const bits = [
    `${isQual ? "Открытая квалификация" : "Турнир"} на FACEIT (${discName}).`,
    slots ? `Мест: ${slots}${c.subscriptions_count != null ? `, заявок: ${c.subscriptions_count}` : ""}.` : "",
    at ? `Старт в ${at.slice(11, 16)} по МСК.` : "",
    c.description ? String(c.description).replace(/\s+/g, " ").slice(0, 400) : "",
  ].filter(Boolean);

  return {
    id: "fc-" + c.championship_id,
    name,
    kind: isQual ? "qualifier" : "main",
    disc: discName,
    format: "Online",
    city: "Онлайн (FACEIT)",
    ...(tba ? { tba: true } : { start, end, startsAt: at, ...(endUnknown ? { endUnknown: true } : {}) }),
    prize: info.prize,   // из описания; в API надёжного поля с валютой нет
    fee: null,
    ...(regEndAt ? { regEnd: regEndAt } : {}),
    op,
    teams: slots,
    platform: "FACEIT",
    ru: ruSignal(c, op),   // российская направленность: на сайте есть фильтр «С российским фокусом»
    desc: bits.join(" "),
    fee_note: "Условия участия и взнос — на странице турнира на FACEIT.",
    contact: "Регистрация — на странице турнира на FACEIT.",
    site: url,
    siteName: "Страница на FACEIT",
    social: [],
  };
}
