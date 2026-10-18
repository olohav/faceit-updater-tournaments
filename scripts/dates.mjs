/* Работа с датами (время по Москве). */
/* Дата YYYY-MM-DD по Москве из миллисекунд/секунд/ISO. */
export function ymd(v) {
  if (!v) return null;
  let ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1e12) ms *= 1000; // секунды -> миллисекунды
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}
export function startsAt(v) {
  if (!v) return null;
  let ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1e12) ms *= 1000;
  return new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Moscow" }).replace(" ", "T") + "+03:00";
}
export const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
