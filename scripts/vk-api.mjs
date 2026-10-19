/* Запросы к API ВКонтакте (wall.get). Токен — только из переменной окружения VK_TOKEN. */
import { VK } from "./vk-config.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Последние посты сообщества по короткому имени (vk.com/ЭТО_ИМЯ). Ошибку API превращаем в понятное исключение. */
export async function wallPosts(domain, token) {
  const params = new URLSearchParams({ domain, count: String(VK.postsPerGroup), filter: "owner", access_token: token, v: VK.version });
  const res = await fetch("https://api.vk.com/method/wall.get?" + params);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(`VK ${j.error.error_code}: ${j.error.error_msg}`);
  await sleep(VK.pauseMs);
  return j.response.items || [];
}
