// Органайзер задач: крошечный сервер для страницы на GitHub Pages.
// Хранит задачи в data/tasks.json и отправляет отчёты «что сделано» в MAX
// от бота «Приз»: либо владелице в личку («Мне»), либо в канал «БОТ РАБОЧИЙ».
// Бот «Приз» не трогает: только ЧИТАЕТ его .env ради ключа и id канала.
// Без зависимостей — нужен только Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.TASKS_CONFIG || path.join(HERE, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = Number(process.env.TASKS_PORT || config.port || 3087);
const HOST = config.host || '127.0.0.1';
const DATA_FILE = process.env.TASKS_DATA || config.dataFile || path.join(HERE, 'data', 'tasks.json');
const MAX_API = process.env.TASKS_MAX_API || config.maxApi || 'https://platform-api2.max.ru';
const ALLOWED_ORIGINS = config.allowedOrigins || ['https://mashater7.github.io'];

// Ключи ботов и id «БОТ РАБОЧИЙ» берём из .env самих ботов (только чтение).
function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const botEnv = readEnvFile(config.botEnvFile);

// Каждая доска пишет от своего бота: задачи по Антиботу присылает Антибот и т.д.
// Бот выбирается по названию доски; всё остальное — от ПризКитбота.
const BOTS = {
  priz: { label: 'ПризКитбот', envFile: config.botEnvFile },
  antibot: { label: 'Антибот_КитБот', envFile: (config.bots || {}).antibot },
  stopspam: { label: 'СтопСпам_КитБот', envFile: (config.bots || {}).stopspam },
};
for (const b of Object.values(BOTS)) b.token = readEnvFile(b.envFile).BOT_TOKEN || '';

function botKeyForBoard(name) {
  if (/антибот/i.test(name || '')) return 'antibot';
  if (/стоп\s*спам/i.test(name || '')) return 'stopspam';
  return 'priz';
}
function botForTask(t) {
  const board = state.boards.find(b => b.id === t.board);
  return BOTS[botKeyForBoard(board && board.name)];
}

const TARGETS = {
  me: { label: 'Мне', param: 'user_id', id: String(config.meUserId || '') },
  work: { label: 'БОТ РАБОЧИЙ', param: 'chat_id', id: String(config.workChatId || botEnv.PROMO_NOTIFY_CHANNEL_ID || '') },
};

// ---------- Хранилище ----------
const DEFAULT_BOARDS = ['ПризКитбот', 'Антибот_КитБот', 'СтопСпам_КитБот'];
const STATUSES = ['new', 'seen', 'in_progress', 'done', 'tested'];
const STATUS_TITLES = {
  new: '🆕 Новая задача', seen: '👀 Просмотрено', in_progress: '🔧 В работе',
  done: '✅ Сделано', tested: '🧪 Протестировано',
};
const PHOTO_DIR = path.join(path.dirname(DATA_FILE), 'photos');
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function newId() { return crypto.randomBytes(6).toString('hex'); }

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { boards: s.boards || [], categories: s.categories || [], tasks: s.tasks || [] };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { boards: DEFAULT_BOARDS.map(name => ({ id: newId(), name })), categories: [], tasks: [] };
  }
}

let state = loadState();

// Пишем во временный файл и переименовываем — файл не бывает «наполовину записан».
function saveState() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const findTask = id => state.tasks.find(t => t.id === id);

// ---------- Фото ----------
// Страница присылает фото как data:image/...;base64. Кладём файлом со случайным
// именем — по нему же страница показывает картинку (GET /photo/<имя>).
function savePhotos(list) {
  const names = [];
  for (const src of (Array.isArray(list) ? list : []).slice(0, MAX_PHOTOS)) {
    const m = String(src).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_PHOTO_BYTES) continue;
    const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    names.push(name);
  }
  return names;
}

function deletePhotoFile(name) {
  if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) return;
  fs.rmSync(path.join(PHOTO_DIR, name), { force: true });
}

// ---------- Отправка в MAX ----------
function reportText(t, comment, reporter) {
  const board = state.boards.find(b => b.id === t.board);
  const cat = state.categories.find(c => c.id === t.category);
  const where = [board && board.name, cat && cat.name].filter(Boolean).join(' · ');
  return (STATUS_TITLES[t.status] || '📌 Задача') + (where ? ' — ' + where : '') + '\n\n' +
    'Задача: ' + t.text +
    (comment ? '\n\nКомментарий: ' + comment : '') +
    (reporter ? '\n\n— ' + reporter : '');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function maxCall(token, method, pathAndQuery, body) {
  const res = await fetch(MAX_API + pathAndQuery, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (_) { /* не JSON */ }
  return { status: res.status, ok: res.ok, j, txt };
}

// Поток MAX: POST /uploads?type=image → url, туда multipart-поле "data" → token.
async function uploadPhoto(token, name) {
  const up = await maxCall(token, 'POST', '/uploads?type=image');
  if (!up.j || !up.j.url) throw new Error('uploads без url: ' + up.txt.slice(0, 120));
  const form = new FormData();
  form.append('data', new Blob([fs.readFileSync(path.join(PHOTO_DIR, name))]), name);
  const res = await fetch(up.j.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => null);
  const photoToken = j && (j.token || (j.photos && (Object.values(j.photos)[0] || {}).token));
  if (!photoToken) throw new Error('загрузка фото без token (' + res.status + ')');
  return photoToken;
}

function maxError(r, bot) {
  const s = (r.j && (r.j.message || r.j.code)) || r.txt || '';
  if (/dialog\.(suspended|not\.found)|chat\.not\.found/.test(s)) {
    return 'У получателя нет переписки с ботом ' + bot.label + '. Нужно открыть этого бота в MAX и нажать «Начать».';
  }
  return 'MAX не принял сообщение (' + r.status + ')';
}

async function sendToMax(bot, target, text, photos = []) {
  const tg = TARGETS[target];
  if (!tg) return 'Неизвестно, куда отправлять';
  if (!bot.token || !tg.id) return 'Сервер не настроен: нет ключа бота ' + bot.label + ' или адреса «' + tg.label + '»';
  try {
    const attachments = [];
    for (const name of photos) attachments.push({ type: 'image', payload: { token: await uploadPhoto(bot.token, name) } });
    const body = { text: text.slice(0, 3900) };
    if (attachments.length) body.attachments = attachments;
    const q = '/messages?' + tg.param + '=' + encodeURIComponent(tg.id);
    // MAX отдаёт token фото сразу, а обрабатывает его ещё пару секунд и до тех пор
    // отвергает сообщение (attachment.not.ready) — повторяем.
    for (let attempt = 0; ; attempt++) {
      const r = await maxCall(bot.token, 'POST', q, body);
      // MAX бывает отвечает 200 без сообщения — успех только при наличии message.
      if (r.ok && r.j && r.j.message) return null;
      if (/not\.ready|not\.processed/.test(r.txt) && attempt < 6) { await sleep(1500); continue; }
      console.error('[tasks] MAX ' + bot.label + ' ' + r.status + ': ' + r.txt.slice(0, 200));
      return maxError(r, bot);
    }
  } catch (e) {
    console.error('[tasks] MAX error:', e.message);
    return 'Нет связи с MAX';
  }
}

async function sendTask(t, target, comment, reporter) {
  const bot = botForTask(t);
  const err = await sendToMax(bot, target, reportText(t, comment, reporter), t.photos || []);
  if (err) return err;
  t.sent = Date.now();
  t.sentTo = TARGETS[target].label;
  t.sentBy = bot.label;
}

// ---------- Действия ----------
const actions = {
  list() {},

  addBoard(d) {
    const name = str(d.name, 40);
    if (!name) return 'Пустое название';
    state.boards.push({ id: newId(), name });
  },

  renameBoard(d) {
    const b = state.boards.find(x => x.id === d.id);
    const name = str(d.name, 40);
    if (b && name) b.name = name;
  },

  async addTask(d) {
    const text = str(d.text, 4000);
    if (!text) return 'Пустая задача';
    if (!state.boards.some(b => b.id === d.board)) return 'Нет такого бота';
    const t = {
      id: newId(), board: d.board, category: str(d.category, 40), text,
      author: str(d.author, 60), status: 'new', comment: '', photos: savePhotos(d.photos),
      sent: 0, sentTo: '', created: Date.now(),
    };
    state.tasks.push(t);
    saveState();
    // «Сразу отправить» из окна новой задачи: задача сохраняется в любом случае.
    if (TARGETS[d.sendTo]) {
      const err = await sendTask(t, d.sendTo, '', t.author);
      if (err) return 'Задача сохранена, но не отправилась: ' + err;
    }
  },

  updateTask(d) {
    const t = findTask(d.id);
    if (!t) return 'Задача не найдена';
    if (d.text !== undefined) { const text = str(d.text, 4000); if (text) t.text = text; }
    if (d.status !== undefined && STATUSES.includes(d.status)) t.status = d.status;
    if (d.category !== undefined) t.category = str(d.category, 40);
    if (d.comment !== undefined) t.comment = str(d.comment, 4000);
    if (!t.photos) t.photos = [];
    if (Array.isArray(d.removePhotos)) {
      d.removePhotos.forEach(deletePhotoFile);
      t.photos = t.photos.filter(p => !d.removePhotos.includes(p));
    }
    if (d.addPhotos) t.photos = t.photos.concat(savePhotos(d.addPhotos)).slice(0, MAX_PHOTOS);
  },

  deleteTask(d) {
    const t = findTask(d.id);
    if (t) (t.photos || []).forEach(deletePhotoFile);
    state.tasks = state.tasks.filter(x => x.id !== d.id);
  },

  addCategory(d) {
    const name = str(d.name, 40);
    if (!name) return 'Пустое название';
    if (!state.boards.some(b => b.id === d.board)) return 'Нет такого бота';
    state.categories.push({ id: newId(), board: d.board, name });
  },

  renameCategory(d) {
    const c = state.categories.find(x => x.id === d.id);
    const name = str(d.name, 40);
    if (c && name) c.name = name;
  },

  deleteCategory(d) {
    state.categories = state.categories.filter(c => c.id !== d.id);
    state.tasks.forEach(t => { if (t.category === d.id) t.category = ''; });
  },

  async sendReport(d) {
    const t = findTask(d.id);
    if (!t) return 'Задача не найдена';
    const comment = str(d.comment, 3000);
    t.comment = comment;               // комментарий сохраняем, даже если отправка не удалась
    saveState();
    return sendTask(t, d.target, comment, str(d.reporter, 60));
  },
};

// ---------- HTTP ----------
// Страница показывает, от какого бота уйдёт сообщение с каждой доски.
function senders() {
  const out = {};
  state.boards.forEach(b => { out[b.id] = BOTS[botKeyForBoard(b.name)].label; });
  return out;
}

function reply(res, origin, obj) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(obj));
}

function samePassword(a) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(config.password || ''));
  return y.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  const photo = req.method === 'GET' && (req.url || '').match(/^\/photo\/([a-f0-9]{24}\.(jpg|png|webp))$/);
  if (photo) {
    const file = path.join(PHOTO_DIR, photo[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': photo[2] === 'jpg' ? 'image/jpeg' : 'image/' + photo[2],
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 12 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    let d;
    try { d = JSON.parse(raw); } catch (_) { return reply(res, origin, { ok: false, error: 'Плохой запрос' }); }
    if (!samePassword(d.password)) return reply(res, origin, { ok: false, error: 'wrong_password' });
    const fn = actions[d.action];
    if (!fn) return reply(res, origin, { ok: false, error: 'Неизвестное действие' });
    try {
      const err = await fn(d);
      if (d.action !== 'list') saveState();
      if (err) return reply(res, origin, { ok: false, error: err, ...state, senders: senders() });
      reply(res, origin, { ok: true, ...state, senders: senders() });
    } catch (e) {
      console.error('[tasks]', d.action, e);
      reply(res, origin, { ok: false, error: 'Ошибка сервера' });
    }
  });
});

// Под PM2 process.argv[1] — его обёртка, поэтому «запущен ли напрямую» не проверяем:
// слушаем всегда, кроме тестов (они ставят TASKS_NO_LISTEN и слушают сами).
if (!process.env.TASKS_NO_LISTEN) {
  server.listen(PORT, HOST, () => {
    console.log('[tasks] слушаю ' + HOST + ':' + PORT + ', данные: ' + DATA_FILE +
      ', ключи: ' + Object.values(BOTS).map(b => b.label + (b.token ? ' ключ есть' : ' КЛЮЧА НЕТ')).join(', ') +
      ', work=' + (TARGETS.work.id || '—'));
  });
}
