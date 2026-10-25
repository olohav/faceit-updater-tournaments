/* Разбор призового фонда из текста. Файл общий: его используют и Node-скрипты, и страница модерации в браузере. */
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
  for (const m of t.matchAll(/(\d[\d\s.,]*\d|\d)\s*(тыс[а-я]*\.?|к|k|млн[а-я]*|m)?\s*(rub|руб[а-я]*\.?|₽|usd|\$|долл[а-я]*)/gi))
    add(m, num(m[1]) * mult(m[2]), /rub|руб|₽/i.test(m[3]) ? "RUB" : "USD");
  for (const m of t.matchAll(/\$\s*(\d[\d\s.,]*\d|\d)\s*(тыс\.?|к|k|млн|m)?/gi))
    add(m, num(m[1]) * mult(m[2]), "USD");
  return found.length ? found.reduce((a, b) => (b.v * (b.c === "USD" ? 75 : 1) > a.v * (a.c === "USD" ? 75 : 1) ? b : a)) : null;
}

