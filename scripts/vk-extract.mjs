/* Из поста клуба делает запись турнира (или объясняет, почему пост не подошёл). */
import { VK } from "./vk-config.mjs";
import { ymd, addDays } from "./dates.mjs";
import { parsePrize, parseStart, parseFirstDate, parseRegEnd } from "./parse.mjs";

/* Взнос: «вход бесплатный» → 0 ₽, «взнос 500 ₽» → 500 ₽, иначе null. */
export function parseFee(text = "") {
  if (/(вход|участи[ея]|регистраци[яи])[^.\n]{0,15}бесплатн|бесплатн[а-яё]*\s+(вход|участи|регистрац)|без\s+взноса|free\s+entry/i.test(text)) return { v: 0, c: "RUB" };
  const m = /(?:взнос|стоимость\s+участия|стоимость\s+входа|участие|вход)[^\d\n]{0,20}(\d[\d\s]*)\s*(?:₽|руб[а-яё]*|р(?![а-яё]))/i.exec(text);
  const v = m ? parseInt(m[1].replace(/\s/g, ""), 10) : 0;
  return v > 0 && v < 100000 ? { v, c: "RUB" } : null;
}

/* Формат матчей: «5x5», «5х5», «5 на 5», «2v2» → "5x5"; если не нашли — undefined (сайт покажет 5x5 по умолчанию). */
export function parseTeam(text = "") {
  const m = /(?<!\d)([1-5])\s?(?:x|х|v|vs|на|×)\s?([1-5])(?!\d)/i.exec(text);
  return m && m[1] === m[2] ? `${m[1]}x${m[1]}` : undefined;
}

/* Заголовок: первая осмысленная строка поста без смайликов, ссылок и хэштегов. */
function titleOf(text, club, disc) {
  const line = text.split("\n").map(s => s.replace(/https?:\/\/\S+|[#@][\p{L}\d_.]+/gu, "").replace(/[^\p{L}\p{N}\s.,:!?()«»"'&+\-–—/%№]/gu, " ").replace(/\s+/g, " ").trim()).find(s => s.length >= 8);
  if (!line) return `${club.name}: турнир по ${disc}`;
  return line.length > 90 ? line.slice(0, 90).replace(/\s+\S*$/, "") + "…" : line;
}

/* Возвращает { entries: [...] } или { skip: "причина" }. */
export function extract(post, club) {
  const text = String(post.text || post.copy_history?.[0]?.text || "").trim();
  const tz = club.tz || "+03:00";
  if (!text) return { skip: "пустой пост" };
  if (Date.now() / 1000 - post.date > VK.maxPostAgeDays * 86400) return { skip: "слишком старый пост" };
  if (VK.skipWords.test(text)) return { skip: "итоги/поздравления" };
  if (!VK.tournamentWords.test(text)) return { skip: "нет слов про турнир" };
  const games = Object.keys(VK.games).filter(g => VK.games[g].test(text));
  if (!games.length) return { skip: "не названа игра" };
  const when = parseStart(text, tz).date ? parseStart(text, tz) : parseFirstDate(text, tz);
  if (!when.date) return { skip: "нет даты" };
  const today = ymd(Date.now());
  if (when.date < today) return { skip: "дата уже прошла" };
  if (when.date > addDays(today, VK.horizonDays)) return { skip: "слишком далеко" };

  const reg = parseRegEnd(text, tz);
  const fee = parseFee(text), prize = parsePrize(text), team = parseTeam(text);
  const online = /онлайн|online/i.test(text) && !/офлайн|оффлайн|offline|(?<![а-яё])лан(?![а-яё])|lan(?![a-z])|в\s+клубе|в\s+зале/i.test(text);
  const owner = String(post.owner_id), pid = `${owner}_${post.id}`;
  const entries = games.slice(0, 4).map(disc => ({
    id: `vk${pid}${games.length > 1 ? "-" + disc.toLowerCase().replace(/\W+/g, "") : ""}`,
    name: titleOf(text, club, disc), kind: /квалиф|отбор/i.test(text) ? "qualifier" : "main",
    disc, ...(team ? { team } : {}), format: online ? "Online" : "LAN", city: online ? `${club.city} / онлайн` : club.city,
    start: when.date, end: when.date, ...(when.at ? { startsAt: when.at } : {}),
    ...(reg.date ? { regEnd: reg.at || reg.date } : {}),
    prize, fee, op: club.name, teams: null, platform: "ВКонтакте", group: club.domain,
    desc: text.replace(/\s*\n+\s*/g, " ").slice(0, 700),
    fee_note: fee ? (fee.v ? `Взнос по данным поста: ${fee.v} ₽.` : "Участие бесплатное (по данным поста).") : "Взнос в посте не указан — уточняйте в клубе.",
    contact: `Клуб «${club.name}», ${club.city}. Подробности и регистрация — в посте и в группе клуба во ВКонтакте.`,
    site: `https://vk.com/wall${pid}`, siteName: "Пост во ВКонтакте",
    social: [{ t: `Группа «${club.name}» во ВКонтакте`, u: `https://vk.com/${club.domain}` }],
  }));
  return { entries };
}
