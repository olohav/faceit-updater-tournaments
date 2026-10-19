// vk-tournaments.mjs
// Собирает турниры (CS2, Dota 2, Valorant, MLBB) со стен ПК-клубов из data/clubs.json.
//
// Запуск (из любой папки):
//   node scripts/vk-tournaments.mjs                 обойти клубы, обновить кандидатов и data/vk.json
//   node scripts/vk-tournaments.mjs --publish-only  не ходить в ВК, только пересобрать data/vk.json
//
// Поток данных:
//   data/clubs.json -> data/vk-candidates.json (все найденные анонсы; файл пишет только этот скрипт)
//   review.mjs -> data/vk-decisions.json (ваши одобрения и правки)
//   кандидаты + решения -> data/vk.json (одобренные и будущие), его читает сайт

import { pathToFileURL } from 'node:url';
import { P, loadJSON, saveJSON, momentOf, applyDecision, mergeDecisions, writePublished } from './vk-store.mjs';

const TOKEN = process.env.VK_TOKEN;
const V = '5.199';


const POSTS_PER_CLUB = 40; // сколько последних постов читать у каждого клуба
const MAX_AGE_UNDATED_DAYS = 14; // анонсы без даты старше этого срока игнорируем
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

export { momentOf };

// Формат матчей: 1x1, 2x2, 3x3, 5x5 («5х5», «5 на 5», «5v5»)
export function detectFormat(text) {
  const m = text.match(/(?<!\d)([1-5])\s*(?:[xх×*]|vs|v|на)\s*([1-5])(?!\d)/iu);
  return m && m[1] === m[2] ? `${m[1]}x${m[2]}` : null;
}

// Причина, по которой пост не годится, или null, если это актуальный анонс
export function rejectReason(c, now = Date.now()) {
  if (RESULT.test(c.text)) return 'итоги турнира';
  if (/финал/i.test(`${c.title} ${c.text.split('\n')[0]}`)) return 'пост о финале';
  if (REG_CLOSED.test(c.text)) return 'регистрация закрыта';
  if (!REG_SIGNAL.test(c.text)) return 'нет призыва к участию';
  if (c.regDeadline && momentOf(c.regDeadline.date, c.regDeadline.time, c.tz) <= now) {
    return 'регистрация уже закончилась';
  }
  if (c.date && momentOf(c.date, c.time, c.tz) <= now) return 'турнир уже начался или прошёл';
  return null;
}

// Устаревшие записи: турнир уже начался, у ожидающих проверки закончилась регистрация,
// а анонс без даты слишком старый. Принимает кандидата с наложенным решением (status есть).
function isStale(c, now = Date.now()) {
  if ((c.status ?? 'pending') === 'pending' && c.regDeadline &&
      momentOf(c.regDeadline.date, c.regDeadline.time, c.tz) <= now) return true;
  if (c.date) return momentOf(c.date, c.time, c.tz) <= now;
  return (now - new Date(c.postedAt)) / 86400000 > MAX_AGE_UNDATED_DAYS;
}

export function buildCandidate(post, club) {
  const text = cleanText(post.text || post.copy_history?.[0]?.text || '');
  if (!TOURNAMENT.test(text)) return null;

  const games = detectGames(text);
  if (REQUIRE_GAME && !games.length) return null;

  const { date, time } = pickDateTime(text, post.date);
  const titleLine = lineWith(text, TOURNAMENT) ?? text.split('\n')[0];

  const cand = {
    id: `wall${post.owner_id}_${post.id}`,
    club: { domain: club.domain, name: club.name, city: club.city },
    title: titleLine.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 120),
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
  if (rejectReason({ ...cand, text })) return null; // проверяем по полному тексту
  return isStale({ ...cand, status: 'pending' }) ? null : cand;
}

const byDate = (a, b) =>
  (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title, 'ru');

async function main() {
  const publishOnly = process.argv.includes('--publish-only');
  const known = new Map((await loadJSON(P.candidates, [])).map((c) => [c.id, c]));
  const skip = await loadJSON(P.skip, []); // скрытые группы (пишет review.mjs)
  const hidden = new Set(skip);

  if (!publishOnly) {
    if (!TOKEN) { console.error('Задайте переменную окружения VK_TOKEN'); process.exit(1); }
    const clubs = (await loadJSON(P.clubs, [])).filter((c) => !hidden.has(c.domain));
    if (!clubs.length) { console.error('Нет data/clubs.json: сначала запустите vk-clubs.mjs'); process.exit(1); }

    let added = 0;
    let failed = 0;
    let i = 0;
    for (const club of clubs) {
      i++;
      try {
        const { items } = await vk('wall.get', { domain: club.domain, count: POSTS_PER_CLUB });
        let found = 0;
        for (const post of items) {
          const cand = buildCandidate(post, club);
          if (cand && !known.has(cand.id)) { known.set(cand.id, cand); found++; added++; }
        }
        if (found || i % 100 === 0) console.log(`[${i}/${clubs.length}] ${club.domain}: новых ${found}`);
      } catch (e) {
        if (e.code === 5) throw e; // проблема с токеном, дальше нет смысла
        failed++; // закрытая или удалённая группа: пропускаем
      }
    }
    console.log(`Новых кандидатов: ${added}, групп без ответа: ${failed}`);
    if (failed === clubs.length) { console.error('Ни одна группа не ответила: данные не обновлены.'); process.exit(1); }
  }

  // Решения читаем в самом конце: за время обхода вы могли что-то одобрить
  const decisions = await loadJSON(P.decisions, {});
  const now = Date.now();
  const list = [...known.values()]
    .filter((c) => !isStale(applyDecision(c, decisions[c.id]), now))
    .sort(byDate);
  await saveJSON(P.candidates, list);

  const merged = mergeDecisions(list, decisions, skip);
  const published = await writePublished(merged, now);
  const pending = merged.filter((c) => c.status === 'pending').length;
  console.log(`Кандидатов: ${list.length} (на проверке: ${pending}), на сайте (data/vk.json): ${published}`);
}

// Запускаем main только при прямом запуске файла (не при импорте)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
