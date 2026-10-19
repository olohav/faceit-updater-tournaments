/* Настройки сбора турниров ПК-клубов из ВКонтакте. Список клубов — в data/vk-groups.json. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GROUPS_FILE = resolve(ROOT, "data/vk-groups.json");   // список клубов (редактируете вы)
export const OUT_FILE = resolve(ROOT, "data/vk.json");             // результат для сайта
export const REPORT_FILE = resolve(ROOT, "data/vk-report.json");   // отчёт: что и почему отсеяно

export const VK = {
  version: "5.199",          // версия API ВКонтакте
  postsPerGroup: 40,         // сколько последних постов читаем у каждого клуба (максимум 100)
  maxPostAgeDays: 60,        // посты старше этого срока пропускаем
  horizonDays: 200,          // турниры позже этого срока не берём
  pauseMs: 400,              // пауза между запросами (лимит ВК: ~3 запроса в секунду)
  // Пост считаем турниром, если в нём есть слово про турнир, название игры и дата.
  tournamentWords: /турнир|кубок|чемпионат|лига|открыт\S* квалификаци|квалификаци|cup|tournament|(?<![а-яё])лан(?![а-яё])|lan(?![a-z])/i,
  games: {
    "CS2": /(?<![a-z])cs\s?2(?![a-z\d])|cs:?\s?go|counter[\s-]?strike|(?<![а-яё])кс\s?2|контр\s?страйк/i,
    "Dota 2": /dota|(?<![а-яё])дота/i,
    "Valorant": /valorant|валорант/i,
    "MLBB": /mlbb|mobile\s+legends|мобайл\s+легенд/i,
  },
  // Посты с итогами и поздравлениями — не анонсы.
  skipWords: /итоги|результаты\s+турнира|победител|поздравля|прошёл\s|прошел\s|завершил|состоялся|отчёт|отчет\s/i,
};
