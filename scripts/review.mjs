// review.mjs
// Локальный инструмент проверки турниров из data/vk-candidates.json.
//
//   node scripts/review.mjs        (или review.bat: он сам скачает свежие данные и отправит ваши решения)
//
// Открывает страницу http://localhost:3000, где можно одобрять и отклонять кандидатов
// и править название, дату, время, приз и игры. Ваши решения пишутся только в
// data/vk-decisions.json (и data/vk-skip.json для скрытых групп). Сам список кандидатов
// не меняется: его обновляет автосбор на GitHub. Поэтому конфликтов при git push не бывает.
// После отправки решений на GitHub workflow сам пересоберёт data/vk.json и выложит сайт.
//
// Другой порт: $env:PORT=3001; node scripts/review.mjs

import http from 'node:http';
import { P, loadJSON, saveJSON, mergeDecisions, selectPublished, pickEditable } from './vk-store.mjs';
import { exec } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3000;
const GAME_LIST = ['CS2', 'Dota 2', 'Valorant', 'MLBB'];
const STATUSES = ['pending', 'approved', 'rejected'];
const JSON_TYPE = 'application/json; charset=utf-8';

// ---------- данные ----------

// Кандидаты с наложенными решениями: именно это видно в интерфейсе
async function loadCandidates() {
  const [cands, decisions, skip] = await Promise.all([
    loadJSON(P.candidates, []), loadJSON(P.decisions, {}), loadJSON(P.skip, []),
  ]);
  return mergeDecisions(cands, decisions, skip);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Применяет правки к кандидату. Возвращает текст ошибки или null.
function applyPatch(c, p) {
  if ('status' in p) {
    if (!STATUSES.includes(p.status)) return 'Неверный статус';
    c.status = p.status;
  }
  if ('title' in p) {
    const t = String(p.title).trim().slice(0, 120);
    if (!t) return 'Название не может быть пустым';
    c.title = t;
  }
  if ('date' in p) {
    if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'Неверная дата';
    c.date = p.date || null;
  }
  if ('time' in p) {
    if (p.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) return 'Неверное время';
    c.time = p.time || null;
  }
  if ('prize' in p) c.prize = String(p.prize).trim().slice(0, 120) || null;
  if ('format' in p) {
    if (p.format && !/^[1-5]x[1-5]$/.test(p.format)) return 'Неверный формат';
    c.format = p.format || null;
  }
  if ('games' in p) {
    if (!Array.isArray(p.games) || p.games.some((g) => !GAME_LIST.includes(g))) return 'Неверная игра';
    c.games = p.games;
  }
  if (c.status === 'approved' && !c.date) return 'Для одобрения нужна дата турнира';
  c.startsAt = c.date && c.time ? `${c.date}T${c.time}:00${c.tz}` : null;
  return null;
}

// Запросы на запись идут по очереди, чтобы быстрые правки не затирали друг друга
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};

// ---------- сервер ----------

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 100_000) { reject(httpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  // Принимаем только запросы к localhost (защита от чужих сайтов в браузере)
  const host = req.headers.host;
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) throw httpError(403, 'Forbidden');
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/') {
    return send(res, 200, PAGE, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/candidates') {
    const items = await loadCandidates();
    return send(res, 200, JSON.stringify({ items, published: selectPublished(items).length }), JSON_TYPE);
  }

  if (req.method === 'POST' && pathname === '/api/update') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw httpError(403, 'Forbidden');

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      throw e.status ? e : httpError(400, 'Некорректный запрос');
    }
    const result = await enqueue(async () => {
      const list = await loadCandidates();
      const c = list.find((x) => x.id === body.id);
      if (!c) throw httpError(404, 'Кандидат не найден, обнови страницу');
      const copy = structuredClone(c);
      const err = applyPatch(copy, body.patch ?? {});
      if (err) throw httpError(400, err);
      Object.assign(c, copy);
      // Пишем только решение. Заодно убираем решения для постов, которых больше нет среди кандидатов.
      const decisions = await loadJSON(P.decisions, {});
      decisions[c.id] = pickEditable(copy);
      const alive = new Set((await loadJSON(P.candidates, [])).map((x) => x.id));
      for (const id of Object.keys(decisions)) if (!alive.has(id)) delete decisions[id];
      await saveJSON(P.decisions, decisions);
      return { candidate: c, published: selectPublished(list).length };
    });
    return send(res, 200, JSON.stringify(result), JSON_TYPE);
  }

  if (req.method === 'POST' && pathname === '/api/skip') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw httpError(403, 'Forbidden');
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      throw e.status ? e : httpError(400, 'Некорректный запрос');
    }
    if (typeof body.domain !== 'string' || !/^[\w.]{1,64}$/.test(body.domain)) {
      throw httpError(400, 'Неверная группа');
    }
    const result = await enqueue(async () => {
      const before = (await loadCandidates()).length;
      const skip = await loadJSON(P.skip, []);
      if (!skip.includes(body.domain)) skip.push(body.domain);
      await saveJSON(P.skip, skip);
      const list = await loadCandidates();
      return { removed: before - list.length, published: selectPublished(list).length };
    });
    return send(res, 200, JSON.stringify(result), JSON_TYPE);
  }

  throw httpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) =>
    send(res, e.status || 500, JSON.stringify({ error: e.message }), JSON_TYPE)
  );
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Запусти на другом: $env:PORT=3001; node review.mjs`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Проверка турниров: ${url} (остановить: Ctrl+C)`);
  if (process.platform === 'win32') exec(`start "" "${url}"`);
});

// ---------- страница ----------

const PAGE = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проверка турниров</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--text:#1b1f24;--muted:#6b7280;--line:#dfe3e8;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2127;--text:#e6e8eb;--muted:#9aa3af;--line:#2f353d;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
h1{margin:0 0 4px;font-size:18px}
.stats{color:var(--muted);margin-bottom:8px}
.tabs,.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
.tab{border:1px solid var(--line);background:var(--card);color:var(--text);padding:5px 12px;border-radius:999px;cursor:pointer;font:inherit}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
input,select,button{font:inherit;color:var(--text)}
input[type=text],input[type=date],input[type=time],input[type=search],select{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 8px;min-width:0}
input[type=search]{width:280px;max-width:100%}
main{max-width:860px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.card.approved{border-left:4px solid var(--ok)}
.card.rejected{border-left:4px solid var(--bad);opacity:.8}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--muted);margin-bottom:8px}
.meta b{color:var(--text)}
a{color:var(--accent)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
.f{display:flex;flex-direction:column;gap:2px;flex:1 1 140px}
.f.wide{flex-basis:100%}
.f span{font-size:12px;color:var(--muted)}
.f input,.f select{width:100%}
.games{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;gap:5px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 10px;cursor:pointer}
.note{min-height:18px;margin-top:6px;font-size:12px;color:var(--warn)}
details{margin-top:6px}
summary{cursor:pointer;color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:inherit;background:var(--bg);border-radius:6px;padding:8px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.actions button,.more{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:6px 14px;cursor:pointer}
.actions .ok{background:var(--ok);border-color:var(--ok);color:#fff}
.actions .bad{color:var(--bad);border-color:var(--bad)}
.more{display:block;margin:0 auto}
.empty{text-align:center;color:var(--muted);padding:40px 0}
</style>
</head>
<body>
<header>
  <h1>Проверка турниров</h1>
  <div class="stats"><span id="pub"></span> · <span id="count"></span></div>
  <div id="tabs" class="tabs"></div>
  <div class="filters">
    <input id="q" type="search" placeholder="Поиск по названию, клубу, тексту">
    <select id="game"><option value="">Все игры</option></select>
    <select id="city"><option value="">Все города</option></select>
    <label><input id="dated" type="checkbox"> только с датой</label>
  </div>
</header>
<main id="list"></main>
<script>
const GAME_LIST = ['CS2', 'Dota 2', 'Valorant', 'MLBB'];
const STATUS_LABELS = { pending: 'На проверке', approved: 'Одобрено', rejected: 'Отклонено', all: 'Все' };
const PAGE_SIZE = 60;
const view = { status: 'pending', q: '', game: '', city: '', onlyDated: false, limit: PAGE_SIZE };
let all = [];
let published = 0;
const $ = (id) => document.getElementById(id);

// Все данные из ВК вставляются как текст (не как HTML), поэтому чужой текст безопасен
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function send(c, patch) {
  try {
    const r = await api('/api/update', { id: c.id, patch: patch });
    Object.assign(c, r.candidate);
    published = r.published;
    return true;
  } catch (e) {
    alert(e.message);
    await load();
    return false;
  }
}

function noteText(c) {
  if (c.status === 'approved' && c.date && new Date(c.date + 'T' + (c.time || '23:59') + ':00' + c.tz) <= new Date()) {
    return 'Турнир уже начался: в публикацию не попадёт';
  }
  if (!c.date) return 'Даты нет: укажи её, иначе турнир нельзя одобрить';
  if (!c.time) return 'Время не указано (поле time в публикации будет пустым)';
  return '';
}

async function saveField(c, patch, note) {
  if (await send(c, patch)) {
    note.textContent = noteText(c);
    renderTabs();
  }
}

async function setStatus(c, status) {
  if (status === 'approved' && !c.date) { alert('Сначала укажи дату турнира'); return; }
  if (await send(c, { status: status })) render();
}

async function skipClub(c) {
  const msg = 'Скрыть группу «' + c.club.name + '»? Её посты больше не будут собираться, '
    + 'а кандидаты на проверке из этой группы удалятся.';
  if (!confirm(msg)) return;
  try {
    await api('/api/skip', { domain: c.club.domain });
    await load();
  } catch (e) { alert(e.message); }
}

function card(c) {
  const note = h('div', { class: 'note' }, noteText(c));
  const field = (label, input, wide) => h('label', { class: 'f' + (wide ? ' wide' : '') }, h('span', {}, label), input);

  const gamesBox = h('div', { class: 'games' }, GAME_LIST.map((g) =>
    h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox', 'data-g': g, checked: (c.games || []).includes(g),
        onchange: () => saveField(c, {
          games: [...gamesBox.querySelectorAll('input:checked')].map((i) => i.dataset.g),
        }, note),
      }),
      g)));

  const buttons = [];
  if (c.status !== 'approved') buttons.push(h('button', { class: 'ok', onclick: () => setStatus(c, 'approved') }, 'Одобрить'));
  if (c.status !== 'rejected') buttons.push(h('button', { class: 'bad', onclick: () => setStatus(c, 'rejected') }, 'Отклонить'));
  if (c.status !== 'pending') buttons.push(h('button', { onclick: () => setStatus(c, 'pending') }, 'Вернуть на проверку'));
  buttons.push(h('button', { onclick: () => skipClub(c) }, 'Скрыть группу'));

  return h('div', { class: 'card ' + c.status },
    h('div', { class: 'meta' },
      h('b', {}, c.club.name),
      h('span', {}, c.club.city),
      h('a', { href: 'https://vk.com/' + c.club.domain, target: '_blank', rel: 'noopener' }, 'группа'),
      h('a', { href: c.url, target: '_blank', rel: 'noopener' }, 'открыть пост'),
      h('span', {}, 'пост от ' + (c.postedAt || '').slice(0, 10)),
      c.regDeadline ? h('span', {}, 'регистрация до ' + c.regDeadline.date + (c.regDeadline.time ? ' ' + c.regDeadline.time : '')) : null),
    field('Название', h('input', { type: 'text', value: c.title, maxlength: 120,
      onchange: (e) => saveField(c, { title: e.target.value }, note) }), true),
    h('div', { class: 'row' },
      field('Дата', h('input', { type: 'date', value: c.date || '',
        onchange: (e) => saveField(c, { date: e.target.value }, note) })),
      field('Время (' + c.tz + ')', h('input', { type: 'time', value: c.time || '',
        onchange: (e) => saveField(c, { time: e.target.value }, note) })),
      field('Формат', h('select', { onchange: (e) => saveField(c, { format: e.target.value }, note) },
        ['', '1x1', '2x2', '3x3', '4x4', '5x5'].map((v) =>
          h('option', { value: v, selected: c.format === v || (!c.format && v === '') }, v || 'не указан')))),
      field('Приз', h('input', { type: 'text', value: c.prize || '', maxlength: 120,
        onchange: (e) => saveField(c, { prize: e.target.value }, note) }))),
    gamesBox,
    note,
    h('details', {}, h('summary', {}, 'Текст поста'), h('pre', {}, c.text || '')),
    h('div', { class: 'actions' }, buttons));
}

function visible() {
  const q = view.q.trim().toLowerCase();
  return all.filter((c) =>
    (view.status === 'all' || c.status === view.status) &&
    (!view.game || (c.games || []).includes(view.game)) &&
    (!view.city || c.club.city === view.city) &&
    (!view.onlyDated || c.date) &&
    (!q || (c.title + ' ' + c.club.name + ' ' + (c.text || '')).toLowerCase().includes(q)));
}

function renderTabs() {
  const counts = { all: all.length, pending: 0, approved: 0, rejected: 0 };
  for (const c of all) if (counts[c.status] != null) counts[c.status]++;
  $('tabs').replaceChildren(...['pending', 'approved', 'rejected', 'all'].map((s) =>
    h('button', {
      class: 'tab' + (view.status === s ? ' on' : ''),
      onclick: () => { view.status = s; view.limit = PAGE_SIZE; render(); },
    }, STATUS_LABELS[s] + ' ' + counts[s])));
  $('pub').textContent = 'Опубликовано на сайте: ' + published;
}

function render() {
  renderTabs();
  const list = visible();
  const shown = list.slice(0, view.limit);
  $('count').textContent = 'Показано ' + shown.length + ' из ' + list.length;
  const nodes = shown.map(card);
  if (!shown.length) nodes.push(h('p', { class: 'empty' }, 'Здесь пусто'));
  if (list.length > shown.length) {
    nodes.push(h('button', { class: 'more', onclick: () => { view.limit += PAGE_SIZE; render(); } }, 'Показать ещё'));
  }
  $('list').replaceChildren(...nodes);
}

function fillFilters() {
  const gameSel = $('game');
  if (gameSel.options.length === 1) for (const g of GAME_LIST) gameSel.append(new Option(g, g));
  const cities = [...new Set(all.map((c) => c.club.city))].sort((a, b) => a.localeCompare(b, 'ru'));
  const citySel = $('city');
  citySel.replaceChildren(new Option('Все города', ''), ...cities.map((x) => new Option(x, x)));
  citySel.value = cities.includes(view.city) ? view.city : '';
}

async function load() {
  const r = await api('/api/candidates');
  all = r.items;
  published = r.published;
  fillFilters();
  render();
}

$('q').addEventListener('input', (e) => { view.q = e.target.value; view.limit = PAGE_SIZE; render(); });
$('game').addEventListener('change', (e) => { view.game = e.target.value; view.limit = PAGE_SIZE; render(); });
$('city').addEventListener('change', (e) => { view.city = e.target.value; view.limit = PAGE_SIZE; render(); });
$('dated').addEventListener('change', (e) => { view.onlyDated = e.target.checked; view.limit = PAGE_SIZE; render(); });

load().catch((e) => { $('list').textContent = 'Ошибка загрузки: ' + e.message; });
</script>
</body>
</html>`;
