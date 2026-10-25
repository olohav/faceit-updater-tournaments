// vk-tournaments.mjs
// Собирает анонсы турниров (CS2, Dota 2, Valorant, MLBB) со стен ПК-клубов из data/clubs.json.
//
// Запуск (из любой папки):  VK_TOKEN=... node scripts/vk-tournaments.mjs
//
// Результат:
//   data/vk-candidates.json  все найденные анонсы (кандидаты). На сайт они НЕ попадают.
//   data/vk-stats.json       статистика прогона: сколько постов просмотрено и почему отброшено
// Одобрение и публикация делаются на сайте, на странице moderation.html (см. README).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { momentOf } from '../lib/vk-publish.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  clubs: resolve(ROOT, 'data/clubs.json'),
  candidates: resolve(ROOT, 'data/vk-candidates.json'),
  stats: resolve(ROOT, 'data/vk-stats.json'),
};

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function saveJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path); // через временный файл: при обрыве не останется битого JSON
}

const TOKEN = process.env.VK_TOKEN;
const V = '5.199';


const POSTS_PER_CLUB = 40; // сколько последних постов читать у каждого клуба
const MAX_AGE_UNDATED_DAYS = 14; // анонсы без даты старше этого срока игнорируем
const KEEP_AFTER_START_DAYS = 3; // сколько дней после старта кандидат ещё хранится (вдруг дату поправят позже)
const MAX_DAYS_AHEAD = 240; // дата дальше этого срока от поста почти наверняка ошибка разбора
const REQUIRE_GAME = true; // брать только посты, где упомянута одна из игр ниже

const TOURNAMENT = /турнир|кубок|чемпионат|tournament|\bcup\b/i;

// Итоги и новости о прошедших турнирах: это не анонс
const RESULT = /(?<!\p{L})(?:итог[иа]|подошёл к концу|подошел к концу|завершил(?:ся|ась|ись)|состоялся|прошёл|прошел|прошла|прошли|стал[аи]? чемпион|чемпион(?:ами|ом)|забрал[аи]?|выиграл[аи]?|победил[аи]?|одержал[аи]?|поздравля|камбэк|вышли в|выход в|вылетел[аи]?|заняли|занял[аи]?)/iu;
// Регистрация уже закрыта
const REG_CLOSED = /регистрация\s+(?:уже\s+)?(?:закрыта|завершена|завершёна)|набор\s+(?:закрыт|завершён|завершен)|мест\s+(?:больше\s+)?нет|слотов\s+нет/iu;
// Призыв к участию: признак анонса, а не новости
const REG_SIGNAL = /регистрац|заявк|запис(?:аться|ывайтесь|ывайся|ь на|ь открыта)|участв|участи[ея]|взнос|приглаша|приходи|сбор команд|набор|слот/iu;


// Название игры -> регулярка. Новые игры добавляются строкой сюда.
const GAMES = [
  [/(?<!\p{L})(?:cs|кс)[\s:-]?(?:2|go|го)(?!\p{L})|counter[\s-]?strike|контр[\s-]?страйк/iu, 'CS2'],
  [/dota|(?<!\p{L})дот[аеуы](?!\p{L})/iu, 'Dota 2'],
  [/valorant|валорант/iu, 'Valorant'],
  [/mlbb|mobile\s?legends|bang\s?bang|мобайл\s?легендс|мобильные\s?легенды|млбб/iu, 'MLBB'],
];

// Строки с такими словами проверяем на дату/время в первую очередь
const DATE_HINT = /дата|старт|начал|когда|состоится|проходит|пройд[её]т/i;

const MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

async function vk(method, params = {}) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  url.search = new URLSearchParams({ ...params, access_token: TOKEN, v: V });
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(350); // лимит ВК ~3 запроса/сек
    let data;
    try {
      data = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
    } catch {
      await sleep(1000); // сеть или таймаут, пробуем ещё раз
      continue;
    }
    if (!data.error) return data.response;
    if (data.error.error_code === 6) { await sleep(1500); continue; } // слишком часто
    const err = new Error(`VK ${method}: ${data.error.error_msg}`);
    err.code = data.error.error_code;
    throw err;
  }
  throw new Error(`VK ${method}: не удалось получить ответ`);
}

function cleanText(t) {
  return t
    .replace(/\[(?:club|public|id)\d+\|([^\]]+)\]/g, '$1') // [club123|Название] -> Название
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const lineWith = (text, re) =>
  text.split('\n').map((s) => s.trim()).find((s) => re.test(s)) ?? null;

export function detectGames(text) {
  return GAMES.filter(([re]) => re.test(text)).map(([, name]) => name);
}

// 'YYYY-MM-DD' или null. Если года нет, берём год поста (или следующий, если дата уже прошла).
export function parseDate(text, postTs) {
  const post = new Date(postTs * 1000);
  let day, month, year = null;

  let m = text.match(
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/i
  );
  if (m) {
    day = +m[1]; month = MONTHS[m[2].toLowerCase()]; year = m[3] ? +m[3] : null;
  } else {
    m = text.match(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?![\d:])/);
    if (m && +m[2] >= 1 && +m[2] <= 12) {
      day = +m[1]; month = +m[2];
      year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    }
  }
  if (!day || day < 1 || day > 31) return null;

  if (!year) {
    year = post.getFullYear();
    if (new Date(year, month - 1, day) < new Date(post.getTime() - 2 * 86400000)) year++;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseTime(text) {
  const m = text.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  return m ? `${pad(+m[1])}:${m[2]}` : null;
}

// «до 18.10», «до 18 октября в 20:00»: такие дедлайны не должны попадать в дату старта
const UNTIL = /(?<!\p{L})до\s+\d{1,2}(?:[./]\d{1,2}(?:[./]\d{2,4})?|\s+\p{L}+)(?:\s*(?:в|к)?\s*\d{1,2}:\d{2})?/giu;
const REG_LINE = /регистрац|заявк|запис|набор/i;

// Сначала ищем дату и время в строках вида «Старт: ...», «Дата: ...», потом по всему тексту.
export function pickDateTime(text, postTs) {
  const body = text.replace(UNTIL, ' ');
  const hinted = body.split('\n').filter((l) => DATE_HINT.test(l)).join('\n');
  const date = (hinted && parseDate(hinted, postTs)) || parseDate(body, postTs);
  if (!date) return { date: null, time: null };
  const time = (hinted && parseTime(hinted)) || parseTime(body);
  return { date, time };
}

// Дедлайн регистрации: «Регистрация до 18.10 в 20:00» -> { date, time } или null
export function parseRegDeadline(text, postTs) {
  for (const line of text.split('\n')) {
    if (!REG_LINE.test(line)) continue;
    const m = line.match(/(?<!\p{L})до\s+(.+)/iu);
    const date = m && parseDate(m[1], postTs);
    if (date) return { date, time: parseTime(m[1]) };
  }
  return null;
}

// Формат матчей: 1x1, 2x2, 3x3, 5x5 («5х5», «5 на 5», «5v5»)
export function detectFormat(text) {
  const m = text.match(/(?<!\d)([1-5])\s*(?:[xх×*]|vs|v|на)\s*([1-5])(?!\d)/iu);
  return m && m[1] === m[2] ? `${m[1]}x${m[2]}` : null;
}

// Новость о профессиональной сцене, а не анонс любительского турнира
const PRO_EVENT = /(?<![\p{L}\d])(?:pari\s+universe|blast|esl|pgl|iem|the\s+international|dreamleague|betboom\s+dacha|fissure|riyadh\s+masters|esports\s+world\s+cup|vct|valorant\s+champions|major\s+20\d\d)(?![\p{L}\d])/iu;
const PRO_TEAMS = /(?<![\p{L}\d])(?:team\s+spirit|navi|natus\s+vincere|g2|team\s+liquid|vitality|faze|falcons|parivision|betboom\s+team|virtus\.pro|furia|mouz|astralis|gaimin\s+gladiators)(?![\p{L}\d])/giu;
// «Сегодня стартовал...», «продолжается...»: новость об уже идущем турнире (если регистрация не открыта)
const NEWS_PAST = /(?<!\p{L})(?:стартовал[аи]?|продолжается|начался|начались|идут\s+матчи|первый\s+день)(?!\p{L})/iu;
const REG_OPEN = /регистраци[яи]\s+(?:открыта|открыт|идёт|идет)|открыта\s+регистрация|открываем\s+регистрацию|идёт\s+набор|идет\s+набор/iu;

// Причина, по которой пост не годится, или null, если это актуальный анонс
export function rejectReason(c, now = Date.now()) {
  if (RESULT.test(c.text)) return 'итоги турнира';
  if (/финал/i.test(`${c.title} ${c.text.split('\n')[0]}`)) return 'пост о финале';
  if (REG_CLOSED.test(c.text)) return 'регистрация закрыта';
  if (PRO_EVENT.test(c.text) || (c.text.match(PRO_TEAMS) || []).length >= 2) return 'новость о профессиональной сцене';
  if (NEWS_PAST.test(c.text) && !REG_OPEN.test(c.text)) return 'новость об идущем турнире';
  if (!REG_SIGNAL.test(c.text)) return 'нет призыва к участию';
  if (c.regDeadline && momentOf(c.regDeadline.date, c.regDeadline.time, c.tz) <= now) {
    return 'регистрация уже закончилась';
  }
  if (c.date && momentOf(c.date, c.time, c.tz) <= now) return 'турнир уже начался или прошёл';
  return null;
}

// Заголовок: первая «содержательная» строка с названием турнира; служебные («Где будет проходить:») пропускаем.
// Если подходящей строки нет, возвращает '' (вызывающий подставит «Турнир по <игра>»).
const SERVICE_LINE = /^(?:где|как|когда|условия|регламент|призы?|время|формат|подробности|важно|что)(?!\p{L})|:\s*$/iu;
export function pickTitle(text) {
  const lines = text.split('\n').map((l) => l.trim().replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  const best = lines.slice(0, 6).find((l) => TOURNAMENT.test(l) && !SERVICE_LINE.test(l))
    ?? lines.find((l) => TOURNAMENT.test(l) && !SERVICE_LINE.test(l))
    ?? '';
  return best.replace(/[^\p{L}\p{N})»"!?.]+$/u, '').slice(0, 120);
}

// Кандидат устарел: турнир начался больше KEEP_AFTER_START_DAYS назад или анонс без даты слишком старый
function isExpired(c, now = Date.now()) {
  if (c.date) return momentOf(c.date, c.time, c.tz) + KEEP_AFTER_START_DAYS * 86400000 <= now;
  return (now - new Date(c.postedAt)) / 86400000 > MAX_AGE_UNDATED_DAYS;
}

// Текст поста целиком: сам пост, репост и подписи ссылок-вложений («Регистрация на турнир»)
function postText(post) {
  const parts = [post.text, post.copy_history?.[0]?.text];
  for (const a of post.attachments || []) if (a.type === 'link') parts.push(a.link?.title, a.link?.description);
  return cleanText(parts.filter(Boolean).join('\n\n'));
}

// Разбор одного поста: { cand } для анонса или { reason } для отброшенного. reason нужен для статистики.
export function evaluate(post, club, now = Date.now()) {
  const text = postText(post);
  if (!TOURNAMENT.test(text)) return { reason: 'нет слова «турнир»' };

  const games = detectGames(text);
  if (REQUIRE_GAME && !games.length) return { reason: 'нет нужной игры' };

  let { date, time } = pickDateTime(text, post.date);
  if (date && (new Date(date) - post.date * 1000) / 86400000 > MAX_DAYS_AHEAD) { date = null; time = null; }

  const cand = {
    id: `wall${post.owner_id}_${post.id}`,
    club: { domain: club.domain, name: club.name, city: club.city },
    title: pickTitle(text) || `Турнир по ${games.join(', ')}${detectFormat(text) ? ' ' + detectFormat(text) : ''}`,
    games,
    format: detectFormat(text),
    date,
    time,
    startsAt: date && time ? `${date}T${time}:00${club.tz}` : null,
    tz: club.tz,
    regDeadline: parseRegDeadline(text, post.date),
    prize: lineWith(text, /приз|фонд|наград|₽|руб/i)?.slice(0, 120) ?? null,
    url: `https://vk.com/wall${post.owner_id}_${post.id}`,
    postedAt: new Date(post.date * 1000).toISOString(),
    text: text.slice(0, 1500),
  };
  const reason = rejectReason({ ...cand, text }, now); // проверяем по полному тексту
  if (reason) return { reason };
  return isExpired(cand, now) ? { reason: 'устарел' } : { cand };
}

export const buildCandidate = (post, club, now) => evaluate(post, club, now).cand ?? null;

const byDate = (a, b) =>
  (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title, 'ru');

export async function main() {
  if (!TOKEN) { console.error('Задайте переменную окружения VK_TOKEN'); process.exit(1); }
  const started = Date.now();
  const known = new Map((await loadJSON(P.candidates, [])).map((c) => [c.id, c]));
  const clubs = await loadJSON(P.clubs, []);
  if (!clubs.length) { console.error('Нет data/clubs.json: сначала запустите vk-clubs.mjs'); process.exit(1); }

  const stats = { posts: 0, rejected: {}, clubsOk: 0, clubsFailed: 0, errors: {}, newCandidates: 0 };
  let i = 0;
  for (const club of clubs) {
    i++;
    try {
      const { items } = await vk('wall.get', { domain: club.domain, count: POSTS_PER_CLUB });
      stats.clubsOk++;
      let found = 0;
      for (const post of items) {
        stats.posts++;
        const { cand, reason } = evaluate(post, club);
        if (reason) { stats.rejected[reason] = (stats.rejected[reason] || 0) + 1; continue; }
        if (!known.has(cand.id)) { known.set(cand.id, cand); found++; stats.newCandidates++; }
      }
      if (found || i % 100 === 0) console.log(`[${i}/${clubs.length}] ${club.domain}: новых ${found}`);
    } catch (e) {
      if (e.code === 5) throw e; // проблема с токеном, дальше нет смысла
      stats.clubsFailed++; // закрытая или удалённая группа: пропускаем
      const k = e.code ?? 'network';
      stats.errors[k] = (stats.errors[k] || 0) + 1;
    }
  }
  if (!stats.clubsOk) { console.error('Ни одна группа не ответила: данные не обновлены.'); process.exit(1); }

  const now = Date.now();
  const list = [...known.values()].filter((c) => !isExpired(c, now)).sort(byDate);
  await saveJSON(P.candidates, list);
  await saveJSON(P.stats, {
    runAt: new Date(now).toISOString(),
    minutes: Math.round((now - started) / 60000),
    clubsTotal: clubs.length,
    ...stats,
    candidatesTotal: list.length,
    candidatesUndated: list.filter((c) => !c.date).length,
    candidatesNoPrize: list.filter((c) => !c.prize).length,
    clubsWithCandidates: new Set(list.map((c) => c.club.domain)).size,
  });
  console.log(`Просмотрено постов: ${stats.posts}, новых кандидатов: ${stats.newCandidates}, всего кандидатов: ${list.length}, групп без ответа: ${stats.clubsFailed}`);
}

// Запускаем main только при прямом запуске файла (не при импорте)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
