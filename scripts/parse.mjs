/* Разбор описания турнира: призовой фонд (₽/$) и дата/время старта (МСК). Что не нашлось — null/undefined. */
const MONTHS = { января:1, февраля:2, марта:3, апреля:4, мая:5, июня:6, июля:7, августа:8, сентября:9, октября:10, ноября:11, декабря:12 };
const MON = Object.keys(MONTHS).join("|");

/* Число из текста: «1 000 000», «1.000.000», «2,500», «2.5». */
const num = s => {
  s = s.trim();
  return /[.,]\d{1,2}$/.test(s) && !/[.,]\d{3}/.test(s) ? parseFloat(s.replace(/\s/g, "").replace(",", ".")) : parseInt(s.replace(/[\s.,]/g, ""), 10);
};
const mult = w => (/^(тыс|k|к)/i.test(w || "") ? 1e3 : /^(млн|m)/i.test(w || "") ? 1e6 : 1);

/* Призовой фонд: берём наибольшую сумму в ₽ или $, пропуская суммы рядом со словом «взнос». */
export function parsePrize(text = "") {
  const t = String(text), found = [];
  const add = (m, v, c) => {
    if (/взнос|стоимость участия|entry|fee/i.test(t.slice(Math.max(0, m.index - 25), m.index))) return;
    if (v >= 100) found.push({ v, c });
  };
  for (const m of t.matchAll(/(\d[\d\s.,]*\d|\d)\s*(тыс\.?|к|k|млн|m)?\s*(rub|руб[а-я]*\.?|₽|usd|\$|долл[а-я]*)/gi))
    add(m, num(m[1]) * mult(m[2]), /rub|руб|₽/i.test(m[3]) ? "RUB" : "USD");
  for (const m of t.matchAll(/\$\s*(\d[\d\s.,]*\d|\d)\s*(тыс\.?|к|k|млн|m)?/gi))
    add(m, num(m[1]) * mult(m[2]), "USD");
  return found.length ? found.reduce((a, b) => (b.v * (b.c === "USD" ? 75 : 1) > a.v * (a.c === "USD" ? 75 : 1) ? b : a)) : null;
}

const DATE = new RegExp(`(\\d{1,2})(?:[./](\\d{1,2})(?:[./](\\d{2,4}))?|\\s+(${MON})(?:\\s+(\\d{4}))?)`, "i");
const KEY_START = /(дата\s+(?:начала|старта|проведения)|начало|старт[а-яёa-z]*|start[а-яёa-z]*)[^\d]{0,25}/i;

/* Дата старта после слов «начало/старт/дата начала»; время берём только если указано МСК/MSK/GMT+3. */
function parseAfter(text, KEY) {
  const t = String(text).replace(/\s+/g, " ");
  const k = KEY.exec(t);
  if (!k) return {};
  const rest = t.slice(k.index + k[0].length);
  const m = DATE.exec(rest);
  if (!m || m.index > 0) return {};
  const [, d, mo, y, mon, y2] = m;
  const day = +d, month = mon ? MONTHS[mon.toLowerCase()] : +mo;
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return {};
  let year = +(y2 || y || 0);
  if (year && year < 100) year += 2000;
  if (!year) { year = new Date().getUTCFullYear(); if (Date.UTC(year, month - 1, day) < Date.now() - 30 * 864e5) year++; }
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const tm = /^[,\s]*(?:в\s*|at\s*)?(\d{1,2})[:.](\d{2})\s*(?:по\s*)?(?:мск|msk|gmt\s*\+\s*3|utc\s*\+\s*3)/i.exec(rest.slice(m[0].length));
  return { date, at: tm ? `${date}T${tm[1].padStart(2, "0")}:${tm[2]}:00+03:00` : null };
}

export const parseDescription = text => ({ prize: parsePrize(text), ...parseStart(text) });

const KEY_REG = /(регистрац[а-яёa-z]*(?:\s+(?:закрывается|заканчивается)|\s+(?:открыта\s+)?(?:до|по))|registration\s+(?:ends|closes|until|deadline)|дедлайн\s+регистрации)[^\d]{0,25}/i;
export const parseStart = text => parseAfter(text, KEY_START);
export const parseRegEnd = text => parseAfter(text, KEY_REG);   // конец регистрации из описания
