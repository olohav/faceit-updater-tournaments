// Создаёт api/config.php с хешем пароля модератора (сам пароль на сервер не попадает).
// Запуск в GitHub Actions: MODERATOR_PASSWORD=... node scripts/make-moderator-config.mjs
// Хеш PBKDF2-SHA256 (100 000 итераций); api/vk.php проверяет его через hash_pbkdf2.
import { pbkdf2Sync, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const password = process.env.MODERATOR_PASSWORD || '';
if (password.length < 10) {
  console.error('MODERATOR_PASSWORD не задан или короче 10 символов: страница модерации работать не будет.');
  process.exit(1);
}
// Соль постоянная для репозитория: так файл не меняется между запусками и не перезаливается по FTP зря
const salt = createHash('sha256').update(`tournament-finder:${process.env.GITHUB_REPOSITORY || 'local'}`).digest('hex').slice(0, 32);
const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../api/config.php');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `<?php\n// Создан автоматически (scripts/make-moderator-config.mjs). Не редактировать и не публиковать.\nreturn array('salt' => '${salt}', 'hash' => '${hash}');\n`, 'utf8');
console.log('api/config.php создан.');
