/* Собирает турниры ПК-клубов из ВКонтакте и пишет data/vk.json (+ data/vk-report.json с причинами отсева).
   Запуск: VK_TOKEN=... node scripts/sync-vk.mjs   (нужен Node 18+) */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GROUPS_FILE, OUT_FILE, REPORT_FILE } from "./vk-config.mjs";
import { wallPosts } from "./vk-api.mjs";
import { extract } from "./vk-extract.mjs";

const TOKEN = process.env.VK_TOKEN;
if (!TOKEN) { console.error("Не задана переменная окружения VK_TOKEN (сервисный ключ ВКонтакте)."); process.exit(1); }

const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return fallback; } };

/* Клубы из data/vk-groups.json; строки-заглушки (с «ВСТАВЬТЕ») пропускаем. */
const groups = (await readJson(GROUPS_FILE, [])).filter(g => g && g.domain && !/ВСТАВЬТЕ/i.test(g.domain));
if (!groups.length) { console.error("В data/vk-groups.json нет клубов. Впишите короткие имена групп (vk.com/ИМЯ)."); process.exit(1); }

const old = (await readJson(OUT_FILE, { tournaments: [] })).tournaments || [];
const found = new Map(), report = { updatedAt: new Date().toISOString(), groups: {}, skipped: {}, samples: [] };
let okGroups = 0;

for (const club of groups) {
  try {
    const posts = await wallPosts(club.domain, TOKEN);
    okGroups++;
    let kept = 0;
    for (const post of posts) {
      const r = extract(post, club);
      if (r.skip) { report.skipped[r.skip] = (report.skipped[r.skip] || 0) + 1; if (report.samples.length < 25 && post.text) report.samples.push({ club: club.domain, why: r.skip, text: post.text.slice(0, 120) }); continue; }
      r.entries.forEach(e => found.set(e.id, e));
      kept += r.entries.length;
    }
    report.groups[club.domain] = { posts: posts.length, tournaments: kept };
    console.log(`${club.name}: постов ${posts.length}, турниров ${kept}`);
  } catch (e) {
    // Клуб не ответил: оставляем его прежние записи, чтобы они не пропали из-за временной ошибки.
    console.warn(`${club.name}: ошибка ${e.message} — оставляю прежние данные`);
    old.filter(t => t.group === club.domain).forEach(t => found.set(t.id, t));
    report.groups[club.domain] = { error: e.message };
  }
}
if (!okGroups) { console.error("Ни одна группа не ответила — файл не обновлён."); process.exit(1); }

const list = [...found.values()].sort((a, b) => (a.startsAt || a.start).localeCompare(b.startsAt || b.start));
await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), count: list.length, tournaments: list }, null, 1));
await writeFile(REPORT_FILE, JSON.stringify(report, null, 1));
console.log(`Записано турниров: ${list.length} (${OUT_FILE})`);
