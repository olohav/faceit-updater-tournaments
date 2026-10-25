<?php
// api/vk.php: сохранение решений модератора прямо на хостинге.
//
// Что делает: проверяет пароль, принимает решения и готовый список турниров от страницы moderation.html
// и атомарно записывает data/vk-decisions.json, data/vk-skip.json и data/vk.json. Сайт читает vk.json,
// поэтому одобренные турниры появляются сразу, без GitHub и без ожидания.
//
// Пароль хранится в api/config.php (хеш; файл создаёт GitHub Actions из секрета MODERATOR_PASSWORD).
// Совместимость: PHP 7.1+.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$ROOT = dirname(__DIR__);
$DATA = $ROOT . '/data';
$FILES = array(
    'decisions' => $DATA . '/vk-decisions.json',
    'skip'      => $DATA . '/vk-skip.json',
    'published' => $DATA . '/vk.json',
);
const COOKIE = 'tf_mod';
const SESSION_SECONDS = 28800; // 8 часов
const MAX_BODY = 4194304;      // 4 МБ

// Если на хостинге нет расширения mbstring, подрезаем строки по символам через регулярку
if (!function_exists('mb_substr')) {
    function mb_substr($s, $start, $len = null, $enc = null)
    {
        return preg_match('/^.{0,' . (int)$len . '}/us', $s, $m) ? $m[0] : '';
    }
}

function out($code, $payload)
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function config()
{
    $f = __DIR__ . '/config.php';
    if (!is_file($f)) return null;
    $c = include $f;
    return (is_array($c) && !empty($c['hash']) && !empty($c['salt'])) ? $c : null;
}

function is_https()
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
}

function sign($exp, $cfg)
{
    return hash_hmac('sha256', (string)$exp, $cfg['hash']);
}

function is_auth($cfg)
{
    if (!$cfg || empty($_COOKIE[COOKIE])) return false;
    $parts = explode('.', $_COOKIE[COOKIE], 2);
    if (count($parts) !== 2 || !ctype_digit($parts[0]) || (int)$parts[0] < time()) return false;
    return hash_equals(sign($parts[0], $cfg), $parts[1]);
}

function set_cookie($value, $expires)
{
    header('Set-Cookie: ' . COOKIE . '=' . $value . '; Expires=' . gmdate('D, d M Y H:i:s', $expires) . ' GMT; Path=/; HttpOnly; SameSite=Strict' . (is_https() ? '; Secure' : ''), false);
}

function read_json_file($path, $fallback)
{
    if (!is_file($path)) return $fallback;
    $v = json_decode((string)file_get_contents($path), true);
    return $v === null ? $fallback : $v;
}

function revision($files)
{
    $s = '';
    foreach (array($files['decisions'], $files['skip']) as $f) $s .= is_file($f) ? md5_file($f) : '-';
    return md5($s);
}

// Защита от подбора пароля: не больше 8 неудачных попыток с одного адреса за 15 минут
function throttle_state($DATA)
{
    $f = $DATA . '/.login-fail.json';
    $all = read_json_file($f, array());
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '?';
    $now = time();
    $mine = array();
    if (isset($all[$ip])) foreach ($all[$ip] as $t) if ($t > $now - 900) $mine[] = $t;
    return array($f, $all, $ip, $mine);
}

function post_body()
{
    if (!isset($_SERVER['HTTP_X_REQUESTED_WITH']) || $_SERVER['HTTP_X_REQUESTED_WITH'] !== 'tf-moderation') {
        out(403, array('error' => 'Запрос отклонён (нет заголовка защиты).'));
    }
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if ($raw === false || strlen($raw) > MAX_BODY) out(413, array('error' => 'Слишком большой запрос.'));
    $j = json_decode($raw, true);
    if (!is_array($j)) out(400, array('error' => 'Некорректный JSON.'));
    return $j;
}

function str($v, $max)
{
    return is_string($v) ? mb_substr(trim($v), 0, $max, 'UTF-8') : null;
}

// Решения: пропускаем только известные поля нужного вида
function clean_decisions($d)
{
    $games = array('CS2', 'Dota 2', 'Valorant', 'MLBB');
    $res = array('groups' => array(), 'posts' => array());
    $statuses = array('pending', 'approved', 'rejected');
    $groups = isset($d['groups']) && is_array($d['groups']) ? $d['groups'] : array();
    foreach ($groups as $key => $g) {
        if (!preg_match('/^g[0-9a-f]{16}$/', (string)$key) || !is_array($g)) continue;
        if (!isset($g['status']) || !in_array($g['status'], $statuses, true)) continue;
        $o = array('status' => $g['status']);
        foreach (array('title' => 160, 'prize' => 160, 'op' => 80, 'format' => 8) as $k => $max) {
            if (array_key_exists($k, $g) && ($v = str($g[$k], $max)) !== null) $o[$k] = $v;
        }
        if (isset($g['date']) && is_string($g['date']) && ($g['date'] === '' || preg_match('/^\d{4}-\d{2}-\d{2}$/', $g['date']))) $o['date'] = $g['date'];
        if (isset($g['time']) && is_string($g['time']) && ($g['time'] === '' || preg_match('/^\d{2}:\d{2}$/', $g['time']))) $o['time'] = $g['time'];
        if (isset($g['games']) && is_array($g['games'])) {
            $gm = array();
            foreach ($g['games'] as $x) if (in_array($x, $games, true) && !in_array($x, $gm, true)) $gm[] = $x;
            if ($gm) $o['games'] = $gm;
        }
        $res['groups'][$key] = $o;
    }
    $posts = isset($d['posts']) && is_array($d['posts']) ? $d['posts'] : array();
    foreach ($posts as $id => $p) {
        if (!preg_match('/^wall-?\d+_\d+$/', (string)$id) || !is_array($p)) continue;
        if (isset($p['status']) && in_array($p['status'], $statuses, true)) $res['posts'][$id] = array('status' => $p['status']);
    }
    return $res;
}

function clean_skip($s)
{
    $res = array();
    if (is_array($s)) foreach ($s as $d) if (is_string($d) && preg_match('/^[A-Za-z0-9_.]{1,64}$/', $d) && !in_array($d, $res, true)) $res[] = $d;
    return $res;
}

function clean_published($p)
{
    if (!is_array($p) || !isset($p['tournaments']) || !is_array($p['tournaments']) || count($p['tournaments']) > 1000) return null;
    $list = array();
    foreach ($p['tournaments'] as $t) {
        if (!is_array($t) || empty($t['id']) || empty($t['name']) || !is_string($t['id']) || !is_string($t['name'])) return null;
        if (!isset($t['start']) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$t['start'])) return null;
        $list[] = $t;
    }
    return array(
        'updatedAt' => gmdate('c'),
        'source'    => 'ВКонтакте (посты ПК-клубов, ручная проверка)',
        'count'     => count($list),
        'tournaments' => $list,
    );
}

function write_atomic($path, $data)
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) return false;
    $tmp = $path . '.tmp' . getmypid();
    if (file_put_contents($tmp, $json, LOCK_EX) === false) return false;
    if (!@rename($tmp, $path)) { // на некоторых хостингах rename поверх существующего файла не работает
        $ok = copy($tmp, $path);
        @unlink($tmp);
        return $ok;
    }
    return true;
}

// ---------- маршруты ----------

$action = isset($_GET['action']) ? (string)$_GET['action'] : '';
$cfg = config();

if ($action === 'ping') {
    out(200, array(
        'ok' => true,
        'php' => PHP_VERSION,
        'configured' => (bool)$cfg,
        'dataWritable' => is_dir($DATA) && is_writable($DATA),
        'hasCandidates' => is_file($DATA . '/vk-candidates.json'),
        'mbstring' => function_exists('mb_substr'),
    ));
}

if ($action === 'session') {
    out(200, array('configured' => (bool)$cfg, 'auth' => is_auth($cfg)));
}

if ($action === 'login') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, array('error' => 'Нужен POST.'));
    if (!$cfg) out(503, array('error' => 'Пароль модератора не настроен на сервере (нет api/config.php).'));
    $body = post_body();
    list($failFile, $all, $ip, $mine) = throttle_state($DATA);
    if (count($mine) >= 8) out(429, array('error' => 'Слишком много попыток. Подождите 15 минут.'));
    $pw = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
    $calc = hash_pbkdf2('sha256', $pw, $cfg['salt'], 100000, 64, false);
    if (!hash_equals($cfg['hash'], $calc)) {
        $mine[] = time();
        $all[$ip] = $mine;
        @file_put_contents($failFile, json_encode($all), LOCK_EX);
        sleep(1);
        out(401, array('error' => 'Неверный пароль.'));
    }
    unset($all[$ip]);
    @file_put_contents($failFile, json_encode($all), LOCK_EX);
    $exp = time() + SESSION_SECONDS;
    set_cookie($exp . '.' . sign($exp, $cfg), $exp);
    out(200, array('ok' => true));
}

if ($action === 'logout') {
    set_cookie('', time() - 3600);
    out(200, array('ok' => true));
}

// Дальше только для авторизованных
if (!is_auth($cfg)) out(401, array('error' => 'Нужен вход.'));

if ($action === 'load') {
    out(200, array(
        'decisions' => read_json_file($FILES['decisions'], array('groups' => new stdClass(), 'posts' => new stdClass())),
        'skip' => read_json_file($FILES['skip'], array()),
        'rev' => revision($FILES),
    ));
}

if ($action === 'save') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, array('error' => 'Нужен POST.'));
    $body = post_body();
    if (!is_dir($DATA) || !is_writable($DATA)) out(500, array('error' => 'Папка data на сервере недоступна для записи.'));
    if (!isset($body['baseRev']) || $body['baseRev'] !== revision($FILES)) {
        out(409, array('error' => 'Данные изменились в другой вкладке или у другого модератора. Страница перезагрузит свежие.'));
    }
    $decisions = clean_decisions(isset($body['decisions']) ? $body['decisions'] : array());
    $skip = clean_skip(isset($body['skip']) ? $body['skip'] : array());
    $published = clean_published(isset($body['published']) ? $body['published'] : null);
    if ($published === null) out(400, array('error' => 'Список турниров для сайта некорректен.'));

    // пустой массив в JSON должен остаться объектом
    $decisions['groups'] = (object)$decisions['groups'];
    $decisions['posts'] = (object)$decisions['posts'];

    if (!write_atomic($FILES['decisions'], $decisions) || !write_atomic($FILES['skip'], $skip) || !write_atomic($FILES['published'], $published)) {
        out(500, array('error' => 'Не удалось записать файлы на сервере.'));
    }
    out(200, array('ok' => true, 'rev' => revision($FILES), 'count' => $published['count']));
}

out(404, array('error' => 'Неизвестное действие.'));
