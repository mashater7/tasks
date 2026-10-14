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
let maxReply = null;
let failUrl = '';          // отказ только для одного адреса — проверка «Всем»
const uploads = [];
const fakeMax = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/uploads?type=image') uploads.push(req.headers.authorization);
    if (req.url === '/uploads?type=image') return json({ url: 'http://127.0.0.1:' + fakeMax.address().port + '/upload' });
    if (req.url === '/upload') return json({ photos: { a: { token: 'imgtok' } } });
    sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    if (maxReply) { res.writeHead(maxReply.status); return res.end(maxReply.body); }
    if (failUrl && req.url === failUrl) { res.writeHead(200); return res.end('{"success":false}'); }
    if (maxFails) { res.writeHead(200); return res.end('{"success":false}'); }
    json({ message: { body: { mid: 'x' } } });
  });
});

let server, base, migrateState, reportText;
before(async () => {
  await new Promise(r => fakeMax.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'bot.env'), 'BOT_TOKEN=tok123\nPROMO_NOTIFY_CHANNEL_ID=-555\n');
  fs.writeFileSync(path.join(dir, 'antibot.env'), 'BOT_TOKEN=tokAnti\n');
  fs.writeFileSync(path.join(dir, 'stopspam.env'), 'BOT_TOKEN="tokStop"\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    password: 'pw', meUserId: 777, botEnvFile: path.join(dir, 'bot.env'),
    bots: { antibot: path.join(dir, 'antibot.env'), stopspam: path.join(dir, 'stopspam.env') },
    dataFile: path.join(dir, 'data', 'tasks.json'),
    maxApi: 'http://127.0.0.1:' + fakeMax.address().port,
  }));
  process.env.TASKS_CONFIG = path.join(dir, 'config.json');
  process.env.TASKS_NO_LISTEN = '1';
  ({ server, migrateState, reportText } = await import('./server.mjs'));
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
  assert.deepEqual(s.boards.map(b => b.name), ['ПризКитбот', 'Антибот_КитБот', 'СтопСпам_КитБот']);
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
  assert.match(m.body.text, /^✅ Сделано — ПризКитбот · Тексты/);
  assert.match(m.body.text, /Задача: Поменять кнопку/);
  assert.match(m.body.text, /Комментарий: Поменяла/);
  assert.equal(r.tasks[0].sentTo, 'Маше');
});

test('отчёт «В администрацию бота» уходит в канал из .env бота', async () => {
  const t = (await api('list')).tasks[0];
  const r = await api('sendReport', { id: t.id, comment: 'Готово', target: 'work' });
  assert.equal(r.ok, true);
  assert.equal(sent.at(-1).url, '/messages?chat_id=-555');
  assert.equal(r.tasks[0].sentTo, 'Администрации бота');
});

test('«Всем» — одно и то же сообщение уходит и Маше, и в администрацию бота', async () => {
  const t = (await api('list')).tasks[0];
  const n = sent.length;
  const r = await api('sendReport', { id: t.id, comment: 'Для всех', target: 'all' });
  assert.equal(r.ok, true);
  const two = sent.slice(n);
  assert.deepEqual(two.map(m => m.url), ['/messages?user_id=777', '/messages?chat_id=-555']);
  assert.equal(two[0].body.text, two[1].body.text);
  assert.match(two[0].body.text, /Комментарий: Для всех/);
  assert.equal(r.tasks[0].sentTo, 'Маше и администрации бота');
});

test('«Всем»: если одно место не приняло — ошибка называет его, отметка только про дошедшее', async () => {
  const t = (await api('list')).tasks[0];
  failUrl = '/messages?chat_id=-555';
  const r = await api('sendReport', { id: t.id, comment: 'Половина', target: 'all' });
  failUrl = '';
  assert.equal(r.ok, false);
  assert.match(r.error, /Администрации бота: MAX не принял/);
  assert.match(r.error, /Маше — отправлено/);
  assert.equal(r.tasks[0].sentTo, 'Маше');
});

test('отчёт из «Протестировано» подписан как проверка', async () => {
  const t = (await api('list')).tasks[0];
  await api('updateTask', { id: t.id, status: 'tested' });
  const r = await api('sendReport', { id: t.id, comment: 'Нажала на телефоне — работает', reporter: 'Наташа', target: 'me' });
  assert.equal(r.ok, true);
  const text = sent.at(-1).body.text;
  assert.match(text, /^🧪 Протестировано/);
  assert.match(text, /Что проверено: Нажала на телефоне — работает/);
  assert.match(text, /— Наташа$/);
  await api('updateTask', { id: t.id, status: 'done' });
});

test('новая задача «Сохранить и отправить → Всем» уходит в оба места', async () => {
  const s = await api('list');
  const n = sent.length;
  const r = await api('addTask', { board: s.boards[0].id, text: 'Всем сразу', author: 'Наташа', sendTo: 'all' });
  assert.equal(r.ok, true);
  assert.deepEqual(sent.slice(n).map(m => m.url), ['/messages?user_id=777', '/messages?chat_id=-555']);
  const t = r.tasks.find(x => x.text === 'Всем сразу');
  assert.equal(t.sentTo, 'Маше и администрации бота');
  await api('deleteTask', { id: t.id });
});

test('неизвестный получатель — задача сохраняется без отправки', async () => {
  const s = await api('list');
  const n = sent.length;
  const r = await api('addTask', { board: s.boards[0].id, text: 'Куда-то', sendTo: 'nobody' });
  assert.equal(r.ok, true);
  assert.equal(sent.length, n);
  await api('deleteTask', { id: r.tasks.find(x => x.text === 'Куда-то').id });
});

test('старые отметки «БОТ РАБОЧИЙ» и «Мне» переименовываются при загрузке', () => {
  const s = migrateState({ tasks: [
    { sentTo: 'БОТ РАБОЧИЙ' }, { sentTo: 'Мне' }, { sentTo: 'Маше' }, { sentTo: '' },
  ] });
  assert.deepEqual(s.tasks.map(t => t.sentTo), ['Администрации бота', 'Маше', 'Маше', '']);
  assert.deepEqual(s.boards, []);
  assert.deepEqual(s.categories, []);
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

test('dialog.suspended — понятная подсказка вместо 403', async () => {
  maxReply = { status: 403, body: '{"code":"chat.denied","message":"Key: error.dialog.suspended, args: [777,]."}' };
  const t = (await api('list')).tasks[0];
  const r = await api('sendReport', { id: t.id, comment: '', target: 'me' });
  maxReply = null;
  assert.equal(r.ok, false);
  assert.match(r.error, /нет переписки с ботом ПризКитбот/);
});

test('отправка из любой колонки: заголовок по статусу, комментарий необязателен', async () => {
  const t = (await api('list')).tasks[0];
  await api('updateTask', { id: t.id, status: 'in_progress' });
  const r = await api('sendReport', { id: t.id, comment: '', target: 'me' });
  assert.equal(r.ok, true);
  assert.match(sent.at(-1).body.text, /^🔧 В работе/);
  assert.doesNotMatch(sent.at(-1).body.text, /Комментарий/);
});

test('задачу можно перенести на другую доску: раздел чужой доски сбрасывается, пишет новый бот', async () => {
  const s = await api('list');
  const [priz, anti, stop] = s.boards;
  const catPriz = (await api('addCategory', { board: priz.id, name: 'Раздел Приза' })).categories.find(c => c.name === 'Раздел Приза').id;
  const a = await api('addTask', { board: priz.id, category: catPriz, text: 'Про СтопСпам, но не туда' });
  const t = a.tasks.find(x => x.text === 'Про СтопСпам, но не туда');
  assert.equal(t.category, catPriz);
  const u = await api('updateTask', { id: t.id, board: stop.id });
  assert.equal(u.ok, true);
  const moved = u.tasks.find(x => x.id === t.id);
  assert.equal(moved.board, stop.id);
  assert.equal(moved.category, '', 'раздел ПризКитбота у задачи СтопСпама не остаётся');
  const r = await api('sendReport', { id: t.id, comment: '', target: 'me' });
  assert.equal(r.ok, true);
  assert.equal(sent.at(-1).auth, 'tokStop', 'после переноса отправляет СтопСпам');
  assert.match(sent.at(-1).body.text, /— СтопСпам_КитБот/);
  const v = await api('updateTask', { id: t.id, board: anti.id, category: catPriz });
  assert.equal(v.tasks.find(x => x.id === t.id).board, anti.id);
  assert.equal(v.tasks.find(x => x.id === t.id).category, '', 'раздел чужой доски в том же запросе не прилипает');
  const w = await api('updateTask', { id: t.id, board: priz.id, category: catPriz });
  assert.equal(w.tasks.find(x => x.id === t.id).category, catPriz, 'свой раздел ставится');
  await api('deleteTask', { id: t.id });
  await api('deleteCategory', { id: catPriz });
});

test('перенос на несуществующую доску — ошибка, задача не меняется', async () => {
  const s = await api('list');
  const a = await api('addTask', { board: s.boards[0].id, text: 'Никуда' });
  const t = a.tasks.find(x => x.text === 'Никуда');
  const u = await api('updateTask', { id: t.id, board: 'nope', text: 'Изменённый текст' });
  assert.equal(u.ok, false);
  assert.match(u.error, /Нет такого бота/);
  const same = u.tasks.find(x => x.id === t.id);
  assert.equal(same.board, s.boards[0].id);
  assert.equal(same.text, 'Никуда', 'при ошибке ничего не сохраняется');
  await api('deleteTask', { id: t.id });
});

test('новая задача с разделом другой доски — раздел не ставится', async () => {
  const s = await api('list');
  const [priz, anti] = s.boards;
  const cat = (await api('addCategory', { board: priz.id, name: 'Только Приз' })).categories.find(c => c.name === 'Только Приз').id;
  const a = await api('addTask', { board: anti.id, category: cat, text: 'На Антибот' });
  const t = a.tasks.find(x => x.text === 'На Антибот');
  assert.equal(t.board, anti.id);
  assert.equal(t.category, '');
  await api('deleteTask', { id: t.id });
  await api('deleteCategory', { id: cat });
});

test('новая задача с фото и «сразу отправить» — фото загружается в MAX и уходит вложением', async () => {
  const s = await api('list');
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  const r = await api('addTask', { board: s.boards[1].id, text: 'С фото', author: 'Оля', photos: [png], sendTo: 'work' });
  assert.equal(r.ok, true);
  const t = r.tasks.find(x => x.text === 'С фото');
  assert.equal(t.photos.length, 1);
  assert.equal(t.sentTo, 'Администрации бота');
  const m = sent.at(-1);
  assert.equal(m.url, '/messages?chat_id=-555');
  assert.match(m.body.text, /^🆕 Новая задача — Антибот_КитБот/);
  assert.deepEqual(m.body.attachments, [{ type: 'image', payload: { token: 'imgtok' } }]);
  const img = await fetch(base + '/photo/' + t.photos[0]);
  assert.equal(img.status, 200);
  assert.equal(await img.text(), 'fakepng');
  const cors = await fetch(base + '/photo/' + t.photos[0], { headers: { Origin: 'https://mashater7.github.io' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://mashater7.github.io',
    'фото можно открыть для рисования и со страницы на GitHub Pages');
  const d = await api('deleteTask', { id: t.id });
  assert.equal(d.ok, true);
  assert.equal((await fetch(base + '/photo/' + t.photos[0])).status, 404, 'файл фото удалён вместе с задачей');
});

test('каждая доска пишет от своего бота (ключ, загрузка фото, подпись на карточке)', async () => {
  const s = await api('list');
  const [priz, anti, stop] = s.boards;
  assert.deepEqual(Object.values(s.senders), ['ПризКитбот', 'Антибот_КитБот', 'СтопСпам_КитБот']);
  const png = 'data:image/png;base64,' + Buffer.from('p').toString('base64');
  const cases = [[priz, 'tok123', 'ПризКитбот'], [anti, 'tokAnti', 'Антибот_КитБот'], [stop, 'tokStop', 'СтопСпам_КитБот']];
  for (const [board, tok, label] of cases) {
    for (const target of ['me', 'work']) {
      uploads.length = 0;
      const text = 'Бот ' + label + ' ' + target;
      const r = await api('addTask', { board: board.id, text, photos: [png], sendTo: target });
      assert.equal(r.ok, true, text);
      assert.equal(sent.at(-1).auth, tok, 'сообщение ' + text);
      assert.deepEqual(uploads, [tok], 'фото загружено ключом ' + label);
      const t = r.tasks.find(x => x.text === text);
      assert.equal(t.sentBy, label);
      await api('deleteTask', { id: t.id });
    }
  }
});

test('нет переписки с ботом — подсказка называет нужного бота', async () => {
  const s = await api('list');
  maxReply = { status: 404, body: '{"code":"chat.not.found","message":"dialog.not.found"}' };
  const r = await api('addTask', { board: s.boards[2].id, text: 'x', sendTo: 'me' });
  maxReply = null;
  assert.match(r.error, /нет переписки с ботом СтопСпам_КитБот/);
  await api('deleteTask', { id: r.tasks.find(t => t.text === 'x').id });
});

test('страница отдаётся с запретом индексации', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(await r.text(), /<title>Задачи<\/title>/);
});

test('10 неверных паролей с одного адреса — пауза, другой адрес не страдает', async () => {
  const post = (password, ip) => fetch(base, {
    method: 'POST', headers: { 'X-Real-IP': ip },
    body: JSON.stringify({ action: 'list', password }),
  }).then(r => r.json());
  for (let i = 0; i < 10; i++) assert.equal((await post('bad', '9.9.9.9')).error, 'wrong_password');
  assert.match((await post('pw', '9.9.9.9')).error, /Подождите 15 минут/, 'даже верный пароль ждёт');
  assert.equal((await post('pw', '8.8.8.8')).ok, true);
});

test('служебные свойства объекта не считаются действиями', async () => {
  assert.equal((await api('constructor')).error, 'Неизвестное действие');
});

test('срочность: сохраняется, меняется, снимается, строка в отчёте', async () => {
  const s = await api('list');
  const a = await api('addTask', { board: s.boards[0].id, text: 'Срочная', urgency: 'urgent' });
  const t = a.tasks.find(x => x.text === 'Срочная');
  assert.equal(t.urgency, 'urgent');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'tasks.json'), 'utf8'));
  assert.equal(saved.tasks.find(x => x.id === t.id).urgency, 'urgent', 'сохранено в файл');
  let r = await api('sendReport', { id: t.id, comment: '', target: 'me' });
  assert.equal(r.ok, true);
  assert.match(sent.at(-1).body.text, /^🆕 Новая задача — [^\n]+\nСрочность: 🔴 Срочно\n\nЗадача: Срочная$/);
  const u = await api('updateTask', { id: t.id, urgency: 'later' });
  assert.equal(u.tasks.find(x => x.id === t.id).urgency, 'later');
  r = await api('sendReport', { id: t.id, comment: 'ок', target: 'me' });
  assert.match(sent.at(-1).body.text, /Срочность: 🟢 На будущее/);
  const m = await api('updateTask', { id: t.id, urgency: 'medium' });
  assert.equal(m.tasks.find(x => x.id === t.id).urgency, 'medium');
  const keep = await api('updateTask', { id: t.id, text: 'Срочная 2' });
  assert.equal(keep.tasks.find(x => x.id === t.id).urgency, 'medium', 'без поля срочность не трогается');
  const c = await api('updateTask', { id: t.id, urgency: '' });
  assert.equal(c.tasks.find(x => x.id === t.id).urgency, '', 'отметку можно снять');
  await api('sendReport', { id: t.id, comment: '', target: 'me' });
  assert.doesNotMatch(sent.at(-1).body.text, /Срочность/);
  await api('deleteTask', { id: t.id });
});

test('срочность: недопустимое значение не принимается', async () => {
  const s = await api('list');
  const a = await api('addTask', { board: s.boards[0].id, text: 'Странная', urgency: 'вчера' });
  const t = a.tasks.find(x => x.text === 'Странная');
  assert.equal(t.urgency, '');
  await api('updateTask', { id: t.id, urgency: 'medium' });
  for (const bad of ['вчера', 'constructor', '__proto__', 5, null, { a: 1 }]) {
    const u = await api('updateTask', { id: t.id, urgency: bad });
    assert.equal(u.ok, true);
    assert.equal(u.tasks.find(x => x.id === t.id).urgency, 'medium', 'не принято: ' + JSON.stringify(bad));
  }
  await api('deleteTask', { id: t.id });
});

test('старая задача без поля срочности: отчёт как раньше, можно отметить', async () => {
  const s = await api('list');
  const a = await api('addTask', { board: s.boards[0].id, text: 'Старая' });
  const t = a.tasks.find(x => x.text === 'Старая');
  assert.equal(t.urgency, '');
  // как в старом tasks.json — поля нет вовсе: текст отчёта прежний
  const old = { status: 'done', board: s.boards[0].id, category: '', text: 'Старая' };
  assert.equal(reportText(old, 'Сделала', 'Маша'),
    '✅ Сделано — ' + s.boards[0].name + '\n\nЗадача: Старая\n\nКомментарий: Сделала\n\n— Маша');
  assert.equal(migrateState({ tasks: [{ id: 'z', text: 'old' }] }).tasks[0].urgency, undefined, 'данные не переписываются');
  const r = await api('sendReport', { id: t.id, comment: '', target: 'me' });
  assert.equal(r.ok, true);
  assert.match(sent.at(-1).body.text, /^🆕 Новая задача — [^\n]+\n\nЗадача: Старая$/);
  const u = await api('updateTask', { id: t.id, text: 'Старая 2' });
  assert.equal(u.tasks.find(x => x.id === t.id).urgency, '');
  const v = await api('updateTask', { id: t.id, urgency: 'urgent' });
  assert.equal(v.tasks.find(x => x.id === t.id).urgency, 'urgent');
  await api('deleteTask', { id: t.id });
});

test('переименование бота', async () => {
  const s = await api('list');
  const r = await api('renameBoard', { id: s.boards[0].id, name: 'ПризКитбот 2' });
  assert.equal(r.boards[0].name, 'ПризКитбот 2');
});

test('удаление темы оставляет задачу без темы', async () => {
  const s = await api('list');
  const r = await api('deleteCategory', { id: s.categories[0].id });
  assert.equal(r.tasks[0].category, '');
  const d = await api('deleteTask', { id: r.tasks[0].id });
  assert.equal(d.tasks.length, 0);
});
