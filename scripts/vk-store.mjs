// vk-store.mjs
// Общие пути и функции для ВК-конвейера (vk-tournaments.mjs, review.mjs).
//
// Кто какой файл пишет (так git никогда не получает конфликтов):
//   data/vk-candidates.json  только vk-tournaments.mjs (автосбор, GitHub Actions)
//   data/vk-decisions.json   только review.mjs (ваши одобрения и правки, на вашем компьютере)
//   data/vk-skip.json        только review.mjs (скрытые группы)
//   data/vk.json             только vk-tournaments.mjs: итог для сайта (одобренные и ещё не начавшиеся)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrize } from './parse.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const P = {
  clubs: resolve(ROOT, 'data/clubs.json'),
  candidates: resolve(ROOT, 'data/vk-candidates.json'),
  decisions: resolve(ROOT, 'data/vk-decisions.json'),
  skip: resolve(ROOT, 'data/vk-skip.json'),
  published: resolve(ROOT, 'data/vk.json'),
};

export async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

export async function saveJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path); // через временный файл, чтобы не получить битый JSON
}

// Момент в мс. Если времени нет, считаем концом дня, чтобы не отбросить турнир, который ещё впереди.
export const momentOf = (date, time, tz) => new Date(`${date}T${time ?? '23:59'}:00${tz}`).getTime();

// ---------- решения модератора ----------

// Поля, которые review.mjs может менять; в vk-decisions.json хранится только это.
export const EDITABLE = ['status', 'title', 'date', 'time', 'prize', 'format', 'games'];
export const pickEditable = (c) => Object.fromEntries(EDITABLE.map((k) => [k, c[k] ?? null]));

// Кандидат с наложенным решением. Без решения статус pending.
export function applyDecision(cand, decision) {
  const m = { ...cand, status: 'pending', ...(decision || {}) };
  m.startsAt = m.date && m.time ? `${m.date}T${m.time}:00${m.tz}` : null;
  return m;
}

// Итоговый список: кандидаты + решения; ожидающие проверки из скрытых групп убираем.
export function mergeDecisions(candidates, decisions = {}, skip = []) {
  const hidden = new Set(skip);
  return candidates
    .map((c) => applyDecision(c, decisions[c.id]))
    .filter((c) => !(c.status === 'pending' && hidden.has(c.club.domain)));
}

// Одобренные и ещё не начавшиеся
export function selectPublished(merged, now = Date.now()) {
  return merged.filter((c) => c.status === 'approved' && c.date && momentOf(c.date, c.time, c.tz) > now);
}

// ---------- формат сайта (как в data/faceit.json) ----------

// «вход бесплатный» -> 0 ₽, «взнос 500 ₽» -> 500 ₽, иначе null
export function parseFee(text = '') {
  if (/(вход|участи[ея]|регистраци[яи])[^.\n]{0,15}бесплатн|бесплатн[а-яё]*\s+(вход|участи|регистрац)|без\s+взноса|free\s+entry/i.test(text)) return { v: 0, c: 'RUB' };
  const m = /(?:взнос|стоимость\s+участия|стоимость\s+входа|участие|вход)[^\d\n]{0,20}(\d[\d\s]*)\s*(?:₽|руб[а-яё]*|р(?![а-яё]))/i.exec(text);
  const v = m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
  return v > 0 && v < 100000 ? { v, c: 'RUB' } : null;
}

const OFFLINE = /офлайн|оффлайн|offline|(?<![а-яё])лан(?![а-яё])|lan(?![a-z])|в\s+клубе|в\s+зале/i;

// Один одобренный кандидат -> записи для сайта (по одной на игру)
export function toSiteEntries(c) {
  const text = String(c.text || '');
  const full = `${c.title}\n${text}`;
  const online = /онлайн|online/i.test(full) && !OFFLINE.test(full);
  const prize = c.prize ? parsePrize(c.prize) : null;
  const fee = parseFee(text);
  const games = (c.games || []).slice(0, 4);
  const regEnd = c.regDeadline
    ? (c.regDeadline.time ? `${c.regDeadline.date}T${c.regDeadline.time}:00${c.tz}` : c.regDeadline.date)
    : null;
  const baseId = 'vk' + c.id.replace(/^wall/, ''); // wall-123_45 -> vk-123_45

  return games.map((disc) => ({
    id: games.length > 1 ? `${baseId}-${disc.toLowerCase().replace(/\W+/g, '')}` : baseId,
    name: c.title,
    kind: /квалиф|отбор/i.test(c.title) ? 'qualifier' : 'main',
    disc,
    ...(c.format ? { team: c.format } : {}),
    format: online ? 'Online' : 'LAN',
    city: online ? `${c.club.city} / онлайн` : c.club.city,
    start: c.date,
    end: c.date,
    ...(c.startsAt ? { startsAt: c.startsAt } : {}),
    ...(regEnd ? { regEnd } : {}),
    prize,
    fee,
    op: c.club.name,
    teams: null,
    platform: 'ВКонтакте',
    desc: text.replace(/\s*\n+\s*/g, ' ').slice(0, 700),
    fee_note: fee
      ? (fee.v ? `Взнос по данным поста: ${fee.v} ₽.` : 'Участие бесплатное (по данным поста).')
      : 'Взнос в посте не указан: уточняйте в клубе.',
    contact: `Клуб «${c.club.name}», ${c.club.city}. Подробности и регистрация: в посте и в группе клуба во ВКонтакте.`,
    site: c.url,
    siteName: 'Пост во ВКонтакте',
    social: [{ t: `Группа «${c.club.name}» во ВКонтакте`, u: `https://vk.com/${c.club.domain}` }],
  }));
}
// ---------- одинаковые турниры из разных клубов сети -> одна запись ----------

// Ключ «того же события»: название, дата, время и игры совпадают
const groupKey = (c) => [
  String(c.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
  c.date, c.time ?? '', [...(c.games || [])].sort().join('+'),
].join('|');

// Общее начало названий клубов: «CyberX Казань», «CyberX Уфа» -> «CyberX»
function commonPrefix(names) {
  const parts = names.map((n) => n.trim().split(/\s+/));
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    const w = parts[0][i].toLowerCase();
    if (!parts.every((p) => p[i] && p[i].toLowerCase() === w)) break;
    out.push(parts[0][i]);
  }
  return out.join(' ').replace(/[\s|,:;—–-]+$/u, '');
}

// Одна запись на событие, которое проходит сразу в нескольких клубах
function toGroupEntries(key, members) {
  members.sort((a, b) => a.club.city.localeCompare(b.club.city, 'ru') || a.id.localeCompare(b.id));
  const first = members[0];
  const cities = [...new Set(members.map((c) => c.club.city))];
  const base = toSiteEntries(first);
  const suffix = base[0]?.format === 'Online' ? ' / онлайн' : '';
  const city = (cities.length <= 3 ? cities.join(', ') : `${cities.length} городов`) + suffix;
  const op = commonPrefix(members.map((c) => c.club.name)) || `${first.club.name} и другие клубы`;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return base.map((e) => ({
    ...e,
    id: base.length > 1 ? `vk-grp-${hash}-${e.disc.toLowerCase().replace(/\W+/g, '')}` : `vk-grp-${hash}`,
    city,
    op,
    contact: `Турнир проходит в клубах (${members.length}): ${cities.join(', ')}. Подробности и регистрация: в посте клуба вашего города (ссылки ниже).`,
    social: members.slice(0, 40).map((c) => ({ t: `${c.club.city}: ${c.club.name}`, u: c.url })),
  }));
}

// Записи для сайта: одобренные и не начавшиеся; одинаковые события разных клубов склеиваются
export function siteEntries(merged, now = Date.now()) {
  const groups = new Map();
  for (const c of selectPublished(merged, now)) {
    const k = groupKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups].flatMap(([k, ms]) => (ms.length === 1 ? toSiteEntries(ms[0]) : toGroupEntries(k, ms)));
}
// Пишет data/vk.json для сайта. Если список не изменился, файл не трогаем (нет лишних коммитов).
export async function writePublished(merged, now = Date.now()) {
  const tournaments = siteEntries(merged, now)
    .sort((a, b) => (a.startsAt || a.start).localeCompare(b.startsAt || b.start) || a.id.localeCompare(b.id));
  const prev = await loadJSON(P.published, null);
  if (prev && JSON.stringify(prev.tournaments) === JSON.stringify(tournaments)) return tournaments.length;
  await saveJSON(P.published, {
    updatedAt: new Date(now).toISOString(),
    source: 'ВКонтакте (посты ПК-клубов, ручная проверка)',
    count: tournaments.length,
    tournaments,
  });
  return tournaments.length;
}
