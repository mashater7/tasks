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

// Ключ бота и id «БОТ РАБОЧИЙ» берём из .env бота «Приз» (только чтение).
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
const BOT_TOKEN = process.env.TASKS_BOT_TOKEN || botEnv.BOT_TOKEN || '';
const TARGETS = {
  me: { label: 'Мне', param: 'user_id', id: String(config.meUserId || '') },
  work: { label: 'БОТ РАБОЧИЙ', param: 'chat_id', id: String(config.workChatId || botEnv.PROMO_NOTIFY_CHANNEL_ID || '') },
};

// ---------- Хранилище ----------
const DEFAULT_BOARDS = ['Приз', 'Антибот', 'СтопСпам'];
const STATUSES = ['new', 'seen', 'in_progress', 'done', 'tested'];

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

// ---------- Отправка в MAX ----------
function reportText(t, comment, reporter) {
  const board = state.boards.find(b => b.id === t.board);
  const cat = state.categories.find(c => c.id === t.category);
  const where = [board && board.name, cat && cat.name].filter(Boolean).join(' · ');
  return '✅ Сделано' + (where ? ' — ' + where : '') + '\n\n' +
    'Задача: ' + t.text + '\n\n' +
    'Что сделано: ' + comment +
    (reporter ? '\n\n— ' + reporter : '');
}

async function sendToMax(target, text) {
  const tg = TARGETS[target];
  if (!tg) return 'Неизвестно, куда отправлять';
  if (!BOT_TOKEN || !tg.id) return 'Сервер не настроен для отправки «' + tg.label + '»';
  try {
    const url = MAX_API + '/messages?' + tg.param + '=' + encodeURIComponent(tg.id);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 3900) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    let j = null;
    try { j = JSON.parse(body); } catch (_) { /* не JSON */ }
    // MAX бывает отвечает 200 без сообщения — считаем успехом только наличие message.
    if (res.ok && j && j.message) return null;
    console.error('[tasks] MAX ' + res.status + ': ' + body.slice(0, 200));
    return 'MAX не принял сообщение (' + res.status + ')';
  } catch (e) {
    console.error('[tasks] MAX error:', e.message);
    return 'Нет связи с MAX';
  }
}

// ---------- Действия ----------
const actions = {
  list() {},

  addBoard(d) {
    const name = str(d.name, 40);
    if (!name) return 'Пустое название';
    state.boards.push({ id: newId(), name });
  },

  addTask(d) {
    const text = str(d.text, 4000);
    if (!text) return 'Пустая задача';
    if (!state.boards.some(b => b.id === d.board)) return 'Нет такого бота';
    state.tasks.push({
      id: newId(), board: d.board, category: str(d.category, 40), text,
      author: str(d.author, 60), status: 'new', comment: '', sent: 0, sentTo: '', created: Date.now(),
    });
  },

  updateTask(d) {
    const t = findTask(d.id);
    if (!t) return 'Задача не найдена';
    if (d.text !== undefined) { const text = str(d.text, 4000); if (text) t.text = text; }
    if (d.status !== undefined && STATUSES.includes(d.status)) t.status = d.status;
    if (d.category !== undefined) t.category = str(d.category, 40);
    if (d.comment !== undefined) t.comment = str(d.comment, 4000);
  },

  deleteTask(d) {
    state.tasks = state.tasks.filter(t => t.id !== d.id);
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
    if (!comment) return 'Напиши, что сделано';
    t.comment = comment;               // комментарий сохраняем, даже если отправка не удалась
    saveState();
    const err = await sendToMax(d.target, reportText(t, comment, str(d.reporter, 60)));
    if (err) return err;
    t.sent = Date.now();
    t.sentTo = TARGETS[d.target].label;
  },
};

// ---------- HTTP ----------
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
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 100000) req.destroy(); });
  req.on('end', async () => {
    let d;
    try { d = JSON.parse(raw); } catch (_) { return reply(res, origin, { ok: false, error: 'Плохой запрос' }); }
    if (!samePassword(d.password)) return reply(res, origin, { ok: false, error: 'wrong_password' });
    const fn = actions[d.action];
    if (!fn) return reply(res, origin, { ok: false, error: 'Неизвестное действие' });
    try {
      const err = await fn(d);
      if (d.action !== 'list') saveState();
      if (err) return reply(res, origin, { ok: false, error: err, ...state });
      reply(res, origin, { ok: true, ...state });
    } catch (e) {
      console.error('[tasks]', d.action, e);
      reply(res, origin, { ok: false, error: 'Ошибка сервера' });
    }
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log('[tasks] слушаю ' + HOST + ':' + PORT + ', данные: ' + DATA_FILE +
      ', отправка: ' + (BOT_TOKEN ? 'ключ есть' : 'КЛЮЧА НЕТ') + ', work=' + (TARGETS.work.id || '—'));
  });
}
