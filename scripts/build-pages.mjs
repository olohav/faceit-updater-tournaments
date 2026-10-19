/*
 * Генератор страниц для поисковиков: по одной статичной HTML-странице на каждый актуальный турнир.
 * Создаёт:  t/<id>/index.html  (страница турнира),  t/index.html  (каталог),  sitemap.xml,  robots.txt
 * Запуск:   node scripts/build-pages.mjs      (после scripts/sync-faceit.mjs)
 * Источники: data/faceit.json + ручные записи из index.html + турниры администратора из Supabase (если подключён).
 * Адрес сайта берётся из site.config.json (поле siteUrl) — при смене домена поправьте его там.
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await readFile(resolve(ROOT, "site.config.json"), "utf8").catch(() => "{}"));
const SITE = (cfg.siteUrl || "").replace(/\/+$/, "");
const NAME = cfg.siteName || "КиберРадар";
if (!SITE) console.warn("В site.config.json не указан siteUrl: ссылки будут относительными, а sitemap.xml не создастся.");

/* ---------- сбор данных ---------- */
const html = await readFile(resolve(ROOT, "index.html"), "utf8");
const USD_RUB = Number((html.match(/const USD_RUB = (\d+)/) || [])[1]) || 75;

/* Ручные записи лежат прямо в index.html (массив TOURNAMENTS): достаём и вычисляем его в песочнице. */
function staticTournaments() {
  const a = html.indexOf("const TOURNAMENTS = [");
  const b = html.indexOf("\n];", a);
  if (a < 0 || b < 0) return [];
  try { return vm.runInNewContext("(" + html.slice(a + "const TOURNAMENTS = ".length, b + 2) + ")", {}, { timeout: 2000 }); }
  catch (e) { console.warn("Не удалось прочитать TOURNAMENTS из index.html:", e.message); return []; }
}
async function remoteTournaments() {
  try { return JSON.parse(await readFile(resolve(ROOT, "data/faceit.json"), "utf8")).tournaments || []; }
  catch { console.warn("data/faceit.json не найден — страницы FACEIT пропущены."); return []; }
}
/* Турниры администратора: публичное чтение из Supabase (ключи берутся из index.html). */
async function manualTournaments() {
  const url = (html.match(/const SUPABASE_URL = "([^"]*)"/) || [])[1], key = (html.match(/const SUPABASE_ANON_KEY = "([^"]*)"/) || [])[1];
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url}/rest/v1/tournaments?select=id,data,expires_at`, { headers: { apikey: key, Authorization: "Bearer " + key } });
    if (!r.ok) throw new Error(r.status);
    const now = Date.now();
    return (await r.json()).filter(x => !x.expires_at || Date.parse(x.expires_at) > now).map(x => ({ ...x.data, id: "m-" + x.id }));
  } catch (e) { console.warn("Турниры администратора недоступны:", e.message); return []; }
}

const uuid = u => ((u || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [""])[0].toLowerCase();
const remote = await remoteTournaments(), manual = await manualTournaments();
const auto = new Set(remote.map(t => uuid(t.site)).filter(Boolean));
const seen = new Set();
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
const all = [...staticTournaments().filter(t => !auto.has(uuid(t.site))), ...remote, ...manual]
  .map(t => ({ team: "5x5", platform: "Не указана", ru: true, ...t }))
  .filter(t => t && t.id && t.name && !t.own && !t.fp && (t.tba || (t.end && t.end >= today)) && !seen.has(t.id) && seen.add(t.id))
  .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.name.localeCompare(b.name));
const slug = t => String(t.id).replace(/[^A-Za-z0-9_-]/g, "-");

/* ---------- форматирование ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fd = (d, y = true) => new Date(d + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" });
const money = m => (!m ? null : m.v === 0 ? "бесплатно" : m.c === "USD" ? "$" + m.v.toLocaleString("ru-RU") : m.v.toLocaleString("ru-RU") + " ₽");
const safeHref = u => (/^https?:\/\//i.test(u || "") ? u : "");
const when = t => t.tba ? "даты уточняются"
  : t.start === t.end ? fd(t.start) + (t.startsAt ? ", " + t.startsAt.slice(11, 16) + " МСК" : "")
  : t.endUnknown ? "с " + fd(t.start) + (t.startsAt ? ", " + t.startsAt.slice(11, 16) + " МСК" : "")
  : (t.start.slice(0, 4) === t.end.slice(0, 4) ? fd(t.start, false) : fd(t.start)) + " — " + fd(t.end);
const kindWord = t => (t.kind === "qualifier" || /qualif|квалиф/i.test(t.name) ? "Квалификация" : "Турнир");
const trim = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

const base = SITE || "../..";
const pageUrl = t => `${SITE}/t/${slug(t)}/`;
const homeUrl = SITE ? SITE + "/" : "../../";
const CSS = `:root{--bg:#f2f4f9;--panel:#fff;--ink:#141a2b;--mute:#5b6479;--line:#dde2ee;--acc:#2f4bff}
@media (prefers-color-scheme:dark){:root{--bg:#0c1019;--panel:#151b29;--ink:#e8ecf6;--mute:#93a0bb;--line:#26304a;--acc:#8a98ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,Arial,sans-serif}
a{color:var(--acc)}header,main,footer{max-width:900px;margin:auto;padding:1rem}header{display:flex;gap:1rem;flex-wrap:wrap;align-items:center;justify-content:space-between}
.logo{font-weight:800;font-size:1.15rem;text-decoration:none;color:var(--ink)}h1{font-size:clamp(1.4rem,4vw,2rem);line-height:1.25;margin:.3rem 0 .6rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.1rem;margin-bottom:1rem}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.8rem 1.2rem;margin:0}dt{color:var(--mute);font-size:.85rem}dd{margin:0;font-weight:600}
.btn{display:inline-block;background:var(--acc);color:var(--panel);padding:.65rem 1.1rem;border-radius:10px;font-weight:800;text-decoration:none}
ul{padding-left:1.2rem}.meta{color:var(--mute);font-size:.9rem}h2{font-size:1.15rem}footer{color:var(--mute);font-size:.9rem}`;

const layout = (title, desc, canonical, body, jsonld) => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(NAME)}"><meta property="og:locale" content="ru_RU">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ""}
<style>${CSS}</style>${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}</head>
<body><header><a class="logo" href="${homeUrl}">${esc(NAME)}</a><nav><a href="${base}/t/">Каталог турниров</a> · <a href="${homeUrl}">Поиск с фильтрами</a></nav></header>
<main>${body}</main>
<footer><p>${esc(NAME)}: турниры по CS2, Dota 2, Valorant и MLBB для игроков из России. Проверяйте даты, взнос и условия на странице организатора.</p></footer></body></html>`;

/* ---------- страницы турниров ---------- */
function tournamentPage(t) {
  const w = when(t), prize = money(t.prize), fee = money(t.fee);
  const online = !/lan/i.test(t.format || "");
  const sentence = `${kindWord(t)} по ${t.disc} «${t.name}»${t.tba ? " — даты уточняются" : " пройдёт " + w}${online ? " онлайн" : t.city ? " в городе " + t.city : ""}. Организатор: ${t.op}.`
    + (prize ? ` Призовой фонд: ${prize}.` : "") + (fee ? ` Взнос: ${fee}.` : "") + (t.regEnd ? ` Регистрация до ${fd(t.regEnd.slice(0, 10))}${t.regEnd.includes("T") ? ", " + t.regEnd.slice(11, 16) + " МСК" : ""}.` : "");
  const title = trim(`${t.name} — ${t.disc}${t.tba ? "" : ", " + (t.start === t.end ? fd(t.start) : fd(t.start, false))} | ${NAME}`, 70);
  const desc = trim(sentence, 158);
  const link = safeHref(t.site);
  const near = all.filter(x => x.id !== t.id && x.disc === t.disc).sort((a, b) => Math.abs(Date.parse((a.start || today) + "T00:00:00Z") - Date.parse((t.start || today) + "T00:00:00Z")) - Math.abs(Date.parse((b.start || today) + "T00:00:00Z") - Date.parse((t.start || today) + "T00:00:00Z"))).slice(0, 6);
  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : "");
  const body = `<p class="meta"><a href="${homeUrl}">${esc(NAME)}</a> › <a href="${base}/t/">Турниры</a> › ${esc(t.disc)}</p>
<h1>${esc(t.name)}</h1><p>${esc(sentence)}</p>
<div class="card"><dl>${row("Дисциплина", t.disc)}${row("Тип", kindWord(t))}${row("Даты", w)}${row("Формат матчей", t.team)}${row("Площадка", online ? "Онлайн" : "LAN (очно)")}${row("Место", t.city)}
${row("Призовой фонд", prize ? prize + (t.prize && t.prize.c === "USD" ? " (≈ " + Math.round(t.prize.v * USD_RUB).toLocaleString("ru-RU") + " ₽)" : "") : "")}${row("Взнос", fee)}${row("Организатор", t.op)}${row("Платформа", t.platform)}${row("Команд / мест", t.teams ? String(t.teams) : "")}</dl></div>
${t.desc ? `<div class="card"><h2>О турнире</h2><p>${esc(t.desc)}</p>${t.fee_note ? `<p class="meta">${esc(t.fee_note)}</p>` : ""}</div>` : ""}
<div class="card"><h2>Регистрация и контакты</h2>${t.contact ? `<p>${esc(t.contact)}</p>` : ""}${link ? `<p><a class="btn" href="${esc(link)}" rel="nofollow noopener" target="_blank">${esc(t.siteName || "Страница турнира")}</a></p>` : ""}</div>
${near.length ? `<div class="card"><h2>Другие турниры по ${esc(t.disc)}</h2><ul>${near.map(x => `<li><a href="${esc(pageUrl(x) || `../${slug(x)}/`)}">${esc(x.name)}</a> <span class="meta">— ${esc(when(x))}</span></li>`).join("")}</ul></div>` : ""}`;

  let ld = null;
  if (!t.tba) {
    const loc = online ? { "@type": "VirtualLocation", url: link || pageUrl(t) || homeUrl } : { "@type": "Place", name: t.city || "Россия", address: { "@type": "PostalAddress", addressLocality: t.city || "", addressCountry: "RU" } };
    ld = { "@context": "https://schema.org", "@type": "SportsEvent", name: t.name, description: sentence, startDate: t.startsAt || t.start, ...(t.endUnknown ? {} : { endDate: t.end }),
      eventStatus: "https://schema.org/EventScheduled", eventAttendanceMode: online ? "https://schema.org/OnlineEventAttendanceMode" : "https://schema.org/OfflineEventAttendanceMode",
      location: loc, organizer: { "@type": "Organization", name: t.op }, url: pageUrl(t) || undefined, sport: t.disc,
      ...(link ? { offers: { "@type": "Offer", url: link, price: t.fee ? String(t.fee.v) : "0", priceCurrency: t.fee && t.fee.c === "USD" ? "USD" : "RUB", availability: "https://schema.org/InStock" } } : {}) };
  }
  return layout(title, desc, SITE ? pageUrl(t) : "", body, ld);
}

/* ---------- каталог ---------- */
function catalogPage() {
  const discs = [...new Set(all.map(t => t.disc))];
  const body = `<h1>Каталог турниров по киберспорту в России</h1><p>${all.length} актуальных турниров и квалификаций по ${discs.join(", ")}. Фильтры по призовому фонду, платформе и дате — на <a href="${homeUrl}">главной странице</a>.</p>`
    + discs.map(d => `<div class="card"><h2>${esc(d)}</h2><ul>${all.filter(t => t.disc === d).map(t => `<li><a href="${esc(SITE ? pageUrl(t) : slug(t) + "/")}">${esc(t.name)}</a> <span class="meta">— ${esc(when(t))}, ${esc(t.op)}</span></li>`).join("")}</ul></div>`).join("");
  return layout(`Каталог турниров по киберспорту в России | ${NAME}`, trim(`Актуальные турниры и квалификации по ${discs.join(", ")} для игроков из России: даты, призовые фонды, организаторы, регистрация.`, 158), SITE ? SITE + "/t/" : "", body, null);
}

/* ---------- запись файлов ---------- */
await rm(resolve(ROOT, "t"), { recursive: true, force: true });   // старые страницы завершённых турниров удаляются
for (const t of all) {
  const dir = resolve(ROOT, "t", slug(t));
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "index.html"), tournamentPage(t));
}
await mkdir(resolve(ROOT, "t"), { recursive: true });
await writeFile(resolve(ROOT, "t/index.html"), catalogPage());

if (SITE) {
  const urls = [[SITE + "/", today, "daily", "1.0"], [SITE + "/t/", today, "daily", "0.9"], ...all.map(t => [pageUrl(t), today, "daily", "0.8"])];
  await writeFile(resolve(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d, f, p]) => `  <url><loc>${esc(u)}</loc><lastmod>${d}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join("\n")}\n</urlset>\n`);
  await writeFile(resolve(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
}
console.log(`Готово: ${all.length} страниц турниров (FACEIT: ${all.filter(t => String(t.id).startsWith("fc-")).length}, администратор: ${all.filter(t => String(t.id).startsWith("m-")).length}), каталог t/index.html${SITE ? ", sitemap.xml, robots.txt" : ""}.`);
