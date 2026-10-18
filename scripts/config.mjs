/* Настройки скрипта. Здесь меняются игры, регионы, фильтры и поисковые слова — больше нигде. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ================= НАСТРОЙКИ ================= */
export const CONFIG = {
  // Игры FACEIT (game id в API). Valorant и MLBB на FACEIT не поддерживаются — для них нужны другие источники.
  games: { cs2: "CS2", dota2: "Dota 2" },
  // Статусы чемпионатов: upcoming — предстоящие, ongoing — идущие.
  types: ["upcoming", "ongoing"],
  // Регион FACEIT. Россия входит в EU. Пустая строка = без фильтра по региону.
  region: "EU",
  // Максимум чемпионатов на игру и статус (защита от бесконечной пагинации). Список идёт по возрастанию даты старта.
  maxPerQuery: 2000,
  // Не показывать турниры, стартующие позже чем через N дней (и прекращать листать список, дойдя до них).
  horizonDays: 150,
  // Анализ сетки: идущий турнир считается завершённым, если сыгран финал последнего раунда
  // или сыграны все матчи и после последнего прошло finishGraceHours часов.
  matchCheck: true,
  finishGraceHours: 6,
  // Если сыгранных матчей давно нет (idleDays дней) и ничего не идёт прямо сейчас — турнир заброшен.
  idleDays: 5,
  matchesMaxPages: 3,      // страниц матчей по 100 штук на турнир
  maxRunningDays: 45,
  // Минимум мест: отсекает тестовые и «дуэльные» турниры на 2–6 слотов.
  minSlots: 8,
  // Не включать организаторов по id (если знаете точный id — узнать можно через FACEIT_DEBUG=1).
  excludeOrganizerIds: ["faceit"],   // у турниров самой платформы organizer_id равен "faceit"
  // Регионы FACEIT, которые подходят (Россия входит в EU). Фильтр по полю region у самого турнира: параметр region в запросе API игнорирует. Пустой список = любые.
  allowedRegions: ["EU"],
  // Не включать турниры, где призы выдаются в FACEIT Points (поле prizes[].faceit_points).
  excludeFaceitPoints: true,
  // Организаторы-платформы: по имени организатора (турниры самого FACEIT не нужны).
  excludeOrganizerRegex: /^faceit$/i,
  // Не включать по названию: дуэли и мини-форматы (1v1, 2v2, wingman, aim, awp...), тесты, ежедневные кубки, FACEIT Points.
  excludeNameRegex: /\b(1v1|1x1|1vs1|1on1|2v2|2x2|3v3|duo|solo|wingman|aim|awp|pistol|duel|arena|showdown|daily|late night|test|тест)\b|faceit points|\bFP\b|\bhub\b/i,
  // Дополнительный поиск по названию (метод /search/championships): ловит нужные турниры, которых нет в первых страницах общего списка.
  // Если метод недоступен ключу — скрипт просто пропустит этот шаг.
  // Сколько результатов брать на один поисковый запрос.
  searchMaxPerQuery: 100,
  searchTerms: ["open qualifier", "qualifier", "квалификация", "CCT", "XPrime", "liga stavok", "лига ставок", "betboom", "winline", "russia", "россия", "снг", "cis"],
  // Серии, которые остаются в списке, даже если у турнира пока нет даты старта.
  alwaysIncludeRegex: /liga stavok|лига ставок|народная лига|\bCCT\b|russia|россия|\bCIS\b|СНГ/i,
  // Пропускать турниры, куда нельзя участвовать из России (whitelist_geo_countries без RU или blacklist_geo_countries с RU).
  requireRussiaIfCountryLimited: true,
  // Сколько запросов деталей чемпионата выполнять параллельно (бережём лимиты API).
  concurrency: 3,
};
/* ============================================= */


export const API = "https://open.faceit.com/data/v4";
export const KEY = process.env.FACEIT_API_KEY;
export const DEBUG = !!process.env.FACEIT_DEBUG;
export const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/faceit.json");
