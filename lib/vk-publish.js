// lib/vk-publish.js
// Общая логика ВК-турниров: группировка одинаковых анонсов, решения модератора, формат сайта.
// Файл не зависит от Node: его используют и тесты/скрипты, и страница moderation.html в браузере.
//
// Модель данных:
//   candidates (data/vk-candidates.json)  посты клубов, пишет только автосбор
//   decisions  (data/vk-decisions.json)   { groups: { gkey: {status, ...правки} }, posts: { id: {status} } }
//   skip       (data/vk-skip.json)        домены скрытых клубов
// Решение принимается по ГРУППЕ: одинаковые посты разных клубов сети (одно название, дата и игры)
// образуют одно событие. Одобрили группу один раз, и все посты (включая появившиеся позже) идут на сайт.

import { parsePrize } from './prize.js';

export const momentOf = (date, time, tz) => new Date(`${date}T${time ?? '23:59'}:00${tz}`).getTime();

// ---------- группировка ----------

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

// Название без слов из имени клуба и города: «Турнир CyberX Казань» и «Турнир CyberX Уфа» -> одно и то же
export function normTitle(c) {
  const drop = new Set([...words(c.club?.city), ...words(c.club?.name)].filter((w) => w.length >= 3));
  return words(c.title).filter((w) => !drop.has(w)).join(' ');
}

function hash(str) { // два FNV-1a по 32 бита: короткий стабильный ключ без crypto
  let a = 0x811c9dc5, b = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    a = Math.imul(a ^ str.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ str.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// Ключ группы считается ТОЛЬКО по исходным данным поста, поэтому не меняется, когда вы правите название или дату
export const groupKeyOf = (c) => 'g' + hash([normTitle(c), c.date ?? '', [...(c.games || [])].sort().join('+')].join('|'));

// ---------- решения ----------

export const EDITABLE = ['title', 'date', 'time', 'prize', 'format', 'games', 'op', 'venueType', 'venueCity', 'statusMode', 'soonDays', 'checkinDays', 'removeAfterDays', 'statusSetAt'];
export const STATUSES = ['pending', 'approved', 'rejected'];

export const emptyDecisions = () => ({ groups: {}, posts: {} });

// '' в правке означает «очистить поле», отсутствие ключа означает «оставить как в посте»
const pick = (base, edit) => (edit === undefined ? base : edit === '' ? null : edit);

// Кандидат с решением: итоговые поля, статус и ключ группы
export function decorate(c, decisions = emptyDecisions()) {
  const gkey = groupKeyOf(c);
  const g = decisions.groups?.[gkey] || {};
  const m = { ...c, raw: c, gkey, status: decisions.posts?.[c.id]?.status ?? g.status ?? 'pending' };
  for (const k of EDITABLE) m[k] = pick(c[k], g[k]);
  m.startsAt = m.date && m.time ? `${m.date}T${m.time}:00${m.tz}` : null;
  return m;
}

// Устарел: для автоматического статуса — по дате события; для одобренного
// ручного расписания «Скоро → Чек-ин → скрыть» — только по таймеру модератора.
// Иначе событие исчезает в день старта, даже если заданный срок показа ещё не истёк.
export function isStale(c, now = Date.now(), maxUndatedDays = 14) {
  if (c.status === 'approved' && c.statusMode === 'soon') {
    const parsed = Date.parse(c.statusSetAt || '');
    const since = Number.isFinite(parsed) ? parsed : now;
    const soonDays = Math.max(1, Number(c.soonDays) || 1);
    const checkinDays = Math.max(1, Number(c.checkinDays) || 1);
    const removeAfterDays = Math.max(soonDays + checkinDays, Number(c.removeAfterDays) || soonDays + checkinDays);
    return now >= since + removeAfterDays * 86400000;
  }
  if (c.date) return momentOf(c.date, c.time, c.tz) <= now;
  return (now - new Date(c.postedAt)) / 86400000 > maxUndatedDays;
}

// Группы для интерфейса и для публикации
export function groupAll(candidates, decisions = emptyDecisions(), skip = [], now = Date.now()) {
  const hidden = new Set(skip);
  const map = new Map();
  for (const raw of candidates) {
    const c = decorate(raw, decisions);
    if (c.status === 'pending' && hidden.has(c.club.domain)) continue;
    if (isStale(c, now)) continue;
    if (!map.has(c.gkey)) map.set(c.gkey, []);
    map.get(c.gkey).push(c);
  }
  return [...map].map(([key, members]) => {
    members.sort((a, b) => a.club.city.localeCompare(b.club.city, 'ru') || a.id.localeCompare(b.id));
    const st = new Set(members.map((m) => m.status));
    return {
      key,
      members,
      rep: members[0],
      status: st.size === 1 ? [...st][0] : 'mixed',
      cities: [...new Set(members.map((m) => m.club.city))],
      edited: Boolean(decisions.groups?.[key]),
    };
  });
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
const mostCommon = (arr) => {
  const n = new Map();
  for (const v of arr) if (v != null) n.set(v, (n.get(v) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// Группа одобренных постов -> записи для сайта (по одной на игру)
export function groupToSiteEntries(group, members = group.members) {
  const first = members[0];
  const text = String(first.text || '');
  const full = `${first.title}\n${text}`;
  const detectedOnline = /онлайн|online/i.test(full) && !OFFLINE.test(full);
  const venueType = first.venueType === 'Online' || first.venueType === 'LAN'
    ? first.venueType
    : detectedOnline ? 'Online' : 'LAN';
  const online = venueType === 'Online';
  const prize = first.prize ? parsePrize(first.prize) : null;
  const fee = parseFee(text);
  const games = (first.games || []).slice(0, 4);
  const clubCities = [...new Set(members.map((m) => m.club.city).filter(Boolean))];
  const customCities = String(first.venueCity || '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  const cities = online ? [] : (customCities.length ? [...new Set(customCities)] : clubCities);
  const multi = members.length > 1;
  const regEnd = first.regDeadline
    ? (first.regDeadline.time ? `${first.regDeadline.date}T${first.regDeadline.time}:00${first.tz}` : first.regDeadline.date)
    : null;
  const city = online ? (String(first.venueCity || '').trim() || 'Онлайн')
    : (cities.length <= 3 ? cities.join(', ') : `${cities.length} ${plural(cities.length, 'город', 'города', 'городов')}`);
  const op = first.op || (multi ? commonPrefix(members.map((m) => m.club.name)) || `${first.club.name.split('|')[0].trim()} и другие клубы` : first.club.name);
  const baseId = multi ? `vk-${group.key}` : 'vk' + first.id.replace(/^wall/, '');

  return games.map((disc) => ({
    id: games.length > 1 ? `${baseId}-${disc.toLowerCase().replace(/\W+/g, '')}` : baseId,
    name: first.title,
    kind: /квалиф|отбор/i.test(first.title) ? 'qualifier' : 'main',
    disc,
    ...(first.format ? { team: first.format } : {}),
    format: online ? 'Online' : 'LAN',
    venueType,
    city,
    cities,
    start: first.date,
    end: first.date,
    ...(first.startsAt ? { startsAt: first.startsAt } : {}),
    ...(regEnd ? { regEnd } : {}),
    prize,
    fee,
    op,
    teams: null,
    platform: 'ВКонтакте',
    statusMode: ['auto', 'soon', 'checkin'].includes(first.statusMode) ? first.statusMode : 'auto',
    ...(first.statusMode === 'soon' ? {
      soonDays: Number(first.soonDays) || 1,
      checkinDays: Number(first.checkinDays) || 1,
      removeAfterDays: Number(first.removeAfterDays) || ((Number(first.soonDays) || 1) + (Number(first.checkinDays) || 1)),
      statusSetAt: first.statusSetAt || new Date().toISOString(),
    } : {}),
    desc: text.replace(/\s*\n+\s*/g, ' ').slice(0, 700),
    fee_note: fee
      ? (fee.v ? `Взнос по данным поста: ${fee.v} ₽.` : 'Участие бесплатное (по данным поста).')
      : 'Взнос в посте не указан: уточняйте в клубе.',
    contact: multi
      ? `Турнир проходит в клубах (${members.length}): ${cities.slice(0, 15).join(', ')}${cities.length > 15 ? ` и ещё ${cities.length - 15}` : ''}. Регистрация и подробности: в посте клуба вашего города (ссылки ниже).`
      : `Клуб «${first.club.name}», ${first.club.city}. Подробности и регистрация: в посте и в группе клуба во ВКонтакте.`,
    site: first.url,
    siteName: 'Пост во ВКонтакте',
    social: multi
      ? members.slice(0, 80).map((m) => ({ t: `${m.club.city}: ${m.club.name}`, u: m.url }))
      : [{ t: `Группа «${first.club.name}» во ВКонтакте`, u: `https://vk.com/${first.club.domain}` }],
  }));
}

// Название сети клубов: самое частое «фирменное» слово в названиях («CyberX Казань», «Компьютерный клуб CyberX Уфа» -> «CyberX»)
const GENERIC = new Set(['компьютерный', 'компьютерные', 'клуб', 'клубы', 'клуба', 'игровой', 'игровые', 'гейминг', 'gaming', 'game', 'games', 'good', 'cyber', 'arena', 'арена', 'pc', 'пк', 'club', 'cafe', 'кафе', 'центр']);
export function commonPrefix(names) {
  const n = new Map();
  for (const name of names) {
    const seen = new Set();
    for (const w of String(name).split(/[\s|,:;—–-]+/)) {
      const k = w.toLowerCase();
      if (k.length < 3 || GENERIC.has(k) || seen.has(k)) continue;
      seen.add(k);
      n.set(k, { w: n.get(k)?.w ?? w, c: (n.get(k)?.c ?? 0) + 1 });
    }
  }
  const top = [...n.values()].sort((a, b) => b.c - a.c)[0];
  return top && top.c >= Math.ceil(names.length / 2) ? top.w : '';
}

const plural = (n, one, few, many) => {
  const m = n % 100, d = n % 10;
  return m >= 11 && m <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many;
};

// Итоговый файл data/vk.json: одобренные группы с датой, которые ещё не начались
export function buildPublished(candidates, decisions, skip = [], now = Date.now()) {
  const tournaments = groupAll(candidates, decisions, skip, now)
    .map((g) => ({ g, ok: g.members.filter((m) => m.status === 'approved' && m.date) }))
    .filter(({ ok }) => ok.length)
    .flatMap(({ g, ok }) => groupToSiteEntries(g, ok))
    .sort((a, b) => (a.startsAt || a.start).localeCompare(b.startsAt || b.start) || a.id.localeCompare(b.id));
  return {
    updatedAt: new Date(now).toISOString(),
    source: 'ВКонтакте (посты ПК-клубов, ручная проверка)',
    count: tournaments.length,
    tournaments,
  };
}
