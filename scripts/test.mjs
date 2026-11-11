// Автотесты: node --test scripts/test.mjs  (запускаются и в GitHub Actions перед выкладкой)
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { parseDate, parseTime, pickDateTime, rejectReason, pickTitle, evaluate, detectGames } from './vk-tournaments.mjs';
import { parsePrize } from '../lib/prize.js';
import { groupKeyOf, decorate, groupAll, buildPublished, emptyDecisions, parseFee, commonPrefix, groupToSiteEntries } from '../lib/vk-publish.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const club = (name, city, domain = 'c1') => ({ domain, name, city });
const cand = (over = {}) => ({
  id: 'wall-1_1', club: club('CyberX Казань', 'Казань'), title: 'Кубок CyberX по CS2', games: ['CS2'], format: '5x5',
  date: '2026-11-07', time: '18:00', tz: '+03:00', prize: 'Призовой фонд 50 000 ₽', url: 'https://vk.com/wall-1_1',
  postedAt: '2026-10-20T10:00:00Z', text: 'Кубок CyberX по CS2. Регистрация открыта. Призовой фонд 50 000 ₽', regDeadline: null, ...over,
});

test('даты: «28 октября» и «28.10» дают один день, «до 20.10» не считается стартом', () => {
  const ts = Date.parse('2026-10-20T10:00:00Z') / 1000;
  assert.equal(parseDate('Старт 28 октября', ts), '2026-10-28');
  assert.equal(parseDate('Старт 28.10', ts), '2026-10-28');
  assert.equal(pickDateTime('Регистрация до 22.10 в 20:00\nСтарт: 28.10 в 17:00', ts).date, '2026-10-28');
  assert.equal(parseTime('начало в 17:30'), '17:30');
});
test('дата в январе после поста в октябре уходит на следующий год', () => {
  assert.equal(parseDate('3 января', Date.parse('2026-10-20T10:00:00Z') / 1000), '2027-01-03');
});
test('игры определяются, в том числе по-русски', () => {
  assert.deepEqual(detectGames('кс2 и Валорант, дота'), ['CS2', 'Dota 2', 'Valorant']);
});
test('призовой фонд: «120 тысяч рублей», «1.14 млн», доллары, взнос не считается', () => {
  assert.deepEqual(parsePrize('Призовой 120 тысяч рублей'), { v: 120000, c: 'RUB' });
  assert.deepEqual(parsePrize('фонд 1.14 млн ₽'), { v: 1140000, c: 'RUB' });
  assert.deepEqual(parsePrize('приз $250 000'), { v: 250000, c: 'USD' });
  assert.equal(parsePrize('Взнос 500 ₽'), null);
});
test('взнос: бесплатно и сумма', () => {
  assert.deepEqual(parseFee('Вход бесплатный'), { v: 0, c: 'RUB' });
  assert.deepEqual(parseFee('Взнос: 300 ₽ с команды'), { v: 300, c: 'RUB' });
});

test('фильтр: итоги, закрытая регистрация, про-сцена и новости об идущем турнире отбрасываются', () => {
  const base = { title: 't', date: null, time: null, tz: '+03:00', regDeadline: null };
  assert.equal(rejectReason({ ...base, text: 'Итоги турнира: победила команда' }, NOW), 'итоги турнира');
  assert.equal(rejectReason({ ...base, text: 'Турнир. Регистрация закрыта' }, NOW), 'регистрация закрыта');
  assert.equal(rejectReason({ ...base, text: 'Сегодня стартовал PARI Universe по Dota 2, регистрация' }, NOW), 'новость о профессиональной сцене');
  assert.equal(rejectReason({ ...base, text: 'Team Spirit сыграет с NAVI, участвуйте в прогнозах' }, NOW), 'новость о профессиональной сцене');
  assert.equal(rejectReason({ ...base, text: 'Сегодня стартовал турнир клуба, смотрите матчи' }, NOW), 'новость об идущем турнире');
  assert.equal(rejectReason({ ...base, text: 'Турнир стартовал, регистрация открыта, приходи' }, NOW), null);
  assert.equal(rejectReason({ ...base, text: 'Открыта регистрация на турнир, участвуйте' }, NOW), null);
});
test('заголовок: служебные строки пропускаются, без названия подставляется «Турнир по …»', () => {
  assert.equal(pickTitle('🔥 Кубок CyberX по CS2!\nУсловия: ...'), 'Кубок CyberX по CS2!');
  assert.equal(pickTitle('CS2 5X5\nГде будет проходить турнир: в клубах'), '');
  const post = { owner_id: -5, id: 7, date: Date.parse('2026-10-20T10:00:00Z') / 1000, text: 'CS2 5x5\nГде будет проходить турнир: в клубах\nРегистрация открыта, приходи' };
  assert.equal(evaluate(post, { ...club('A', 'B'), tz: '+03:00' }, NOW).cand.title, 'Турнир по CS2 5x5');
});
test('дата дальше 240 дней от поста считается ошибкой разбора', () => {
  const post = { owner_id: -5, id: 8, date: Date.parse('2026-01-10T10:00:00Z') / 1000, text: 'Турнир по CS2. Регистрация открыта. 1 декабря 2026' };
  assert.equal(evaluate(post, { ...club('A', 'B'), tz: '+03:00' }, Date.parse('2026-01-11T00:00:00Z')).cand.date, null);
});

test('группировка: тот же турнир в разных городах — одна группа; правка названия ключ не меняет', () => {
  const a = cand({ id: 'wall-1_1', club: club('CyberX Казань', 'Казань'), title: 'Кубок CyberX Казань по CS2' });
  const b = cand({ id: 'wall-2_2', club: club('CyberX Уфа', 'Уфа', 'c2'), title: 'Кубок CyberX Уфа по CS2' });
  assert.equal(groupKeyOf(a), groupKeyOf(b));
  assert.notEqual(groupKeyOf(a), groupKeyOf(cand({ date: '2026-11-08' })));
  const d = emptyDecisions(); d.groups[groupKeyOf(a)] = { status: 'approved', title: 'Новое название' };
  assert.equal(decorate(a, d).gkey, groupKeyOf(a)); // ключ считается по исходным данным, а не по правкам
  assert.equal(decorate(a, d).title, 'Новое название');
});
test('решения: пустая строка очищает поле, отсутствие ключа оставляет как в посте, пост можно исключить', () => {
  const a = cand();
  const d = emptyDecisions(); d.groups[groupKeyOf(a)] = { status: 'approved', prize: '', time: '19:00' };
  const m = decorate(a, d);
  assert.equal(m.prize, null); assert.equal(m.time, '19:00'); assert.equal(m.format, '5x5');
  d.posts[a.id] = { status: 'rejected' };
  assert.equal(decorate(a, d).status, 'rejected');
});
test('публикация: одобренная группа из N постов — одна запись на игру; без решения и без даты — ничего', () => {
  const posts = [1, 2, 3].map((i) => cand({ id: `wall-${i}_${i}`, club: club(`CyberX Город${i}`, `Город${i}`, `c${i}`), games: ['CS2', 'Valorant'] }));
  assert.equal(buildPublished(posts, emptyDecisions(), [], NOW).count, 0);
  const d = emptyDecisions(); d.groups[groupKeyOf(posts[0])] = { status: 'approved' };
  const pub = buildPublished(posts, d, [], NOW);
  assert.equal(pub.count, 2);
  assert.equal(pub.tournaments[0].city, 'Город1, Город2, Город3'); assert.equal(pub.tournaments[0].op, 'CyberX');
  assert.equal(pub.tournaments[0].social.length, 3);
  const undated = posts.map((p) => cand({ ...p, date: null, time: null }));
  const d2 = emptyDecisions(); d2.groups[groupKeyOf(undated[0])] = { status: 'approved' };
  assert.equal(buildPublished(undated, d2, [], NOW).count, 0);
  d2.groups[groupKeyOf(undated[0])].date = '2026-11-10';
  assert.equal(buildPublished(undated, d2, [], NOW).count, 2);
});
test('публикация: начавшиеся турниры уходят, исключённый пост не попадает в ссылки, скрытый клуб исчезает у ожидающих', () => {
  const a = cand({ id: 'wall-1_1' }), b = cand({ id: 'wall-2_2', club: club('CyberX Уфа', 'Уфа', 'c2') });
  const d = emptyDecisions(); d.groups[groupKeyOf(a)] = { status: 'approved' }; d.posts['wall-2_2'] = { status: 'rejected' };
  assert.equal(buildPublished([a, b], d, [], NOW).tournaments[0].social.length, 1);
  assert.equal(buildPublished([a, b], d, [], Date.parse('2026-11-08T00:00:00Z')).count, 0);
  assert.equal(groupAll([a], emptyDecisions(), ['c1'], NOW).length, 0);
});
test('сеть клубов определяется по самому частому фирменному слову', () => {
  assert.equal(commonPrefix(['CyberX Казань', 'Компьютерный клуб CyberX Уфа', 'Cyberx Омск']), 'CyberX');
  assert.equal(commonPrefix(['Альфа', 'Бета', 'Гамма']), '');
});


test('единый каталог: JSON доступен сайту и SEO, содержит корректные уникальные записи', async () => {
  const file = JSON.parse(await readFile(resolve('data/static-tournaments.json'), 'utf8'));
  assert.ok(Array.isArray(file.tournaments));
  assert.ok(file.tournaments.length > 0);
  const ids = file.tournaments.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'id ручных турниров должны быть уникальными');
  for (const item of file.tournaments) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.name, 'string');
    assert.ok(item.id && item.name);
    assert.ok(item.tba || (item.start && item.end));
  }
});

test('сборка и FTP-деплой используют общий каталог и сохраняют серверную блокировку', async () => {
  const build = await readFile(resolve('scripts/build-pages.mjs'), 'utf8');
  const workflow = await readFile(resolve('.github/workflows/update-data.yml'), 'utf8');
  const pagesWorkflow = await readFile(resolve('.github/workflows/static.yml'), 'utf8');
  const page = await readFile(resolve('index.html'), 'utf8');
  assert.match(build, /data\/static-tournaments\.json/);
  assert.match(page, /data\/static-tournaments\.json/);
  assert.doesNotMatch(build, /match\(\/const TOURNAMENTS/);
  assert.match(workflow, /data\/\.vk-save\.lock/);
  assert.match(workflow, /secrets\.MODERATOR_PASSWORD == '' && 'api\/config\.php'/);
  assert.match(workflow, /\.github\/workflows\/\*\*/);
  assert.match(pagesWorkflow, /data\/static-tournaments\.json/);
  assert.doesNotMatch(pagesWorkflow, /vk-candidates|moderation\.html|api\/vk\.php/);
});


test('ВК: модератор может задать LAN, несколько городов и ручной статус «Скоро» с расписанием', () => {
  const post = cand({ text: 'Кубок CyberX. Призовой фонд 50 000 ₽. Регистрация открыта.' });
  const d = emptyDecisions();
  d.groups[groupKeyOf(post)] = {
    status: 'approved', venueType: 'LAN', venueCity: 'Казань, Уфа', statusMode: 'soon',
    soonDays: 4, checkinDays: 2, removeAfterDays: 8, statusSetAt: '2026-10-25T12:00:00.000Z'
  };
  const group = groupAll([post], d, [], NOW)[0];
  const entries = groupToSiteEntries(group, group.members);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].format, 'LAN');
  assert.equal(entries[0].venueType, 'LAN');
  assert.deepEqual(entries[0].cities, ['Казань', 'Уфа']);
  assert.equal(entries[0].city, 'Казань, Уфа');
  assert.equal(entries[0].statusMode, 'soon');
  assert.equal(entries[0].soonDays, 4);
  assert.equal(entries[0].checkinDays, 2);
  assert.equal(entries[0].removeAfterDays, 8);
  assert.equal(entries[0].statusSetAt, '2026-10-25T12:00:00.000Z');
});

test('ВК: автоматический статус остаётся режимом по умолчанию; Online не получает LAN-города', () => {
  const post = cand({ text: 'Турнир онлайн. Регистрация открыта.' });
  const d = emptyDecisions(); d.groups[groupKeyOf(post)] = { status: 'approved', venueType: 'Online', venueCity: '' };
  const group = groupAll([post], d, [], NOW)[0];
  const [entry] = groupToSiteEntries(group, group.members);
  assert.equal(entry.format, 'Online');
  assert.deepEqual(entry.cities, []);
  assert.equal(entry.statusMode, 'auto');
});

test('API принимает план «Скоро» до одобрения и требует время старта только при одобрении', async () => {
  const api = await readFile(resolve('api/vk.php'), 'utf8');
  assert.match(api, /approvedWithoutStart = \(\(\$o\['status'\] \?\? 'pending'\) === 'approved'\) && empty\(\$o\['statusSetAt'\]\)/);
});

test('ВК-модерация: форма содержит площадку, режим статуса и все три параметра расписания', async () => {
  const html = await readFile(resolve('moderation.html'), 'utf8');
  assert.match(html, /name="venueType"/);
  assert.match(html, /name="venueCity"/);
  assert.match(html, /name="statusMode"/);
  assert.match(html, /name="soonDays"/);
  assert.match(html, /name="checkinDays"/);
  assert.match(html, /name="removeAfterDays"/);
});

test('главная: LAN-фильтр по городам и делегированные кнопки редактирования/корзины администратора', async () => {
  const html = await readFile(resolve('index.html'), 'utf8');
  assert.match(html, /id="lanCityFilter"/);
  assert.match(html, /data-admin-edit/);
  assert.match(html, /data-admin-trash/);
  assert.match(html, /openTournamentEditor\(tournament\)/);
  assert.match(html, /moveTournamentToTrash\(tournament\)/);
  assert.match(html, /restore_tournament/);
});

test('корзина: SQL гарантирует окно 7 дней и pg_cron удаляет просроченные снимки', async () => {
  const sql = await readFile(resolve('supabase/migrations/20261111_tournament_admin_trash.sql'), 'utf8');
  assert.match(sql, /now\(\) \+ interval '7 days'/);
  assert.match(sql, /create or replace function public\.restore_tournament/);
  assert.match(sql, /create or replace function public\.purge_expired_tournament_trash/);
  assert.match(sql, /cron\.schedule\('kiberradar-purge-tournament-trash', '\*\/5 \* \* \* \*'/);
  assert.match(sql, /permanently_hidden = true/);
});
