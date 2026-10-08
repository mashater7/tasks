// node --test server.test.mjs — сервер против ненастоящего MAX, реальный MAX не трогается.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
const sent = [];
let maxFails = false;
const fakeMax = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    if (maxFails) { res.writeHead(200); return res.end('{"success":false}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"message":{"body":{"mid":"x"}}}');
  });
});

let server, base;
before(async () => {
  await new Promise(r => fakeMax.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'bot.env'), 'BOT_TOKEN=tok123\nPROMO_NOTIFY_CHANNEL_ID=-555\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    password: 'pw', meUserId: 777, botEnvFile: path.join(dir, 'bot.env'),
    dataFile: path.join(dir, 'data', 'tasks.json'),
    maxApi: 'http://127.0.0.1:' + fakeMax.address().port,
  }));
  process.env.TASKS_CONFIG = path.join(dir, 'config.json');
  process.env.TASKS_NO_LISTEN = '1';
  ({ server } = await import('./server.mjs'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fakeMax.close(); });

async function api(action, data = {}, password = 'pw') {
  const r = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', Origin: 'https://mashater7.github.io' },
    body: JSON.stringify({ action, password, ...data }),
  });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://mashater7.github.io');
  return r.json();
}

test('неверный пароль', async () => {
  assert.deepEqual(await api('list', {}, 'nope'), { ok: false, error: 'wrong_password' });
});

test('по умолчанию три бота, задачи добавляются и двигаются', async () => {
  const s = await api('list');
  assert.deepEqual(s.boards.map(b => b.name), ['Приз', 'Антибот', 'СтопСпам']);
  const board = s.boards[0].id;
  const c = await api('addCategory', { board, name: 'Тексты' });
  const cat = c.categories[0].id;
  const a = await api('addTask', { board, category: cat, text: 'Поменять кнопку', author: 'Маша' });
  const t = a.tasks[0];
  assert.equal(t.status, 'new');
  const u = await api('updateTask', { id: t.id, status: 'done' });
  assert.equal(u.tasks[0].status, 'done');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'tasks.json'), 'utf8'));
  assert.equal(saved.tasks[0].status, 'done', 'сохранено в файл');
});

test('отчёт «Мне» уходит в личку по user_id', async () => {
  const t = (await api('list')).tasks[0];
  const r = await api('sendReport', { id: t.id, comment: 'Поменяла', reporter: 'Маша', target: 'me' });
  assert.equal(r.ok, true);
  const m = sent.at(-1);
  assert.equal(m.url, '/messages?user_id=777');
  assert.equal(m.auth, 'tok123');
  assert.match(m.body.text, /Сделано — Приз · Тексты/);
  assert.match(m.body.text, /Задача: Поменять кнопку/);
  assert.match(m.body.text, /Что сделано: Поменяла/);
  assert.equal(r.tasks[0].sentTo, 'Мне');
});

test('отчёт в «БОТ РАБОЧИЙ» уходит в канал из .env бота', async () => {
  const t = (await api('list')).tasks[0];
  const r = await api('sendReport', { id: t.id, comment: 'Готово', target: 'work' });
  assert.equal(r.ok, true);
  assert.equal(sent.at(-1).url, '/messages?chat_id=-555');
  assert.equal(r.tasks[0].sentTo, 'БОТ РАБОЧИЙ');
});

test('MAX ответил без message — ошибка, но комментарий сохранён', async () => {
  maxFails = true;
  const t = (await api('list')).tasks[0];
  const r = await api('sendReport', { id: t.id, comment: 'Новый коммент', target: 'me' });
  maxFails = false;
  assert.equal(r.ok, false);
  assert.match(r.error, /MAX не принял/);
  assert.equal(r.tasks[0].comment, 'Новый коммент');
});

test('удаление темы оставляет задачу без темы', async () => {
  const s = await api('list');
  const r = await api('deleteCategory', { id: s.categories[0].id });
  assert.equal(r.tasks[0].category, '');
  const d = await api('deleteTask', { id: r.tasks[0].id });
  assert.equal(d.tasks.length, 0);
});
