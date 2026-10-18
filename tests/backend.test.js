// Runs backend/Code.gs against a small in-memory mock of Google Apps Script services.
// Usage: node tests/backend.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');


const { makeBackend } = require('./mock-gas');
const env = makeBackend();
const { clock, sheetsById, filesMoved, props, rootFolder, ctx, call } = env;
const post = env.post, get = env.get;
const be = () => env;
const triggersLen = () => env.triggers().length;
const lockHeldNow = () => env.lockHeld();
const D1 = 'dev-one-1234', D2 = 'dev-two-5678';
let passed = 0;
const t = (name, fn) => { try { delete env.cache.pinfail; fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

/* ---------- tests ---------- */
console.log('Backend tests');

t('setup creates folders, live sheet, PIN, monthly trigger', () => {
  call('setup');
  const root = rootFolder.kids[0];
  assert.strictEqual(root.name, 'Executive Assistant Workspace');
  assert.strictEqual(root.kids[0].name, 'AGC Prayer Chain');
  assert.strictEqual(root.kids[0].kids[0].name, 'Archive');
  assert(props.SHEET_ID && /^\d{6}$/.test(props.ADMIN_PIN));
  assert.strictEqual(triggersLen(), 1);
  assert(filesMoved.some((f) => f.folder === 'AGC Prayer Chain'));
  call('setup');                                              // second run must not duplicate anything
  assert.strictEqual(rootFolder.kids.length, 1);
  assert.strictEqual(triggersLen(), 1);
  assert.strictEqual(Object.keys(sheetsById).length, 1);
});
const PIN = () => props.ADMIN_PIN;

t('month helpers handle year ends and leap years', () => {
  assert.strictEqual(call('nextMonth_', '2026-12'), '2027-01');
  assert.strictEqual(call('prevMonth_', '2027-01'), '2026-12');
  assert.strictEqual(call('daysInMonth_', '2028-02'), 29);
  assert.strictEqual(call('daysInMonth_', '2026-10'), 31);
});

t('state: current + next month open, others rejected', () => {
  assert.strictEqual(get({ action: 'state', month: '2026-10' }).month, '2026-10');
  assert.strictEqual(get({ action: 'state', month: '2026-11' }).month, '2026-11');
  assert(get({ action: 'state', month: '2026-09' }).error);
  assert(get({ action: 'state', month: 'bad' }).error);
  const c = get({ action: 'state', month: '2026-10' }).config;
  assert.strictEqual(c.tz, 'America/Chicago'); assert.strictEqual(c.endHour, 24);
});

t('claim a slot; it shows with first name only and is flagged mine only for owner', () => {
  assert.strictEqual(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 18, name: '  Rajan Sharma  ' }).ok, true);
  const mine = get({ action: 'state', month: '2026-10', deviceId: D1 }).slots;
  assert.deepStrictEqual(mine, [{ d: '2026-10-18', h: 18, n: 'Rajan', m: true, p: false }]);
  const other = get({ action: 'state', month: '2026-10', deviceId: D2 }).slots;
  assert.strictEqual(other[0].m, false);
  assert(!JSON.stringify(get({ action: 'state', month: '2026-10', deviceId: D2 })).includes(D1), 'deviceId must not leak');
});

t('double booking is refused (taken)', () => {
  assert.strictEqual(post({ action: 'claim', deviceId: D2, month: '2026-10', date: '2026-10-18', hour: 18, name: 'Maria' }).error, 'taken');
});

t('past hours, bad hours, bad dates, empty names are refused', () => {
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 16, name: 'A' }).error.includes('passed'));
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-17', hour: 20, name: 'A' }).error.includes('passed'));
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 24, name: 'A' }).error);
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 1.5, name: 'A' }).error);
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-32', hour: 3, name: 'A' }).error);
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-11-02', hour: 3, name: 'A' }).error);
  assert(post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 3, name: '   ' }).error);
  assert(post({ action: 'claim', deviceId: 'x', month: '2026-10', date: '2026-10-20', hour: 3, name: 'A' }).error);
});

t('the current hour can still be claimed', () => {
  assert.strictEqual(post({ action: 'claim', deviceId: D2, month: '2026-10', date: '2026-10-18', hour: 17, name: 'Grace' }).ok, true);
});

t('names are cleaned: formula characters, tags, long names, Nepali names', () => {
  post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 1, name: '=HYPERLINK("x")' });
  post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 2, name: '<b>Sam</b>' });
  post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 3, name: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
  post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 4, name: 'सुनिता श्रेष्ठ' });
  const s = get({ action: 'state', month: '2026-10' }).slots.filter((x) => x.d === '2026-10-20');
  const by = Object.fromEntries(s.map((x) => [x.h, x.n]));
  assert(!/^[=+\-@]/.test(by[1]), 'formula char stripped: ' + by[1]);
  assert.strictEqual(by[2], 'Sam', 'tags stripped: ' + by[2]);
  assert.strictEqual(by[3].length, 20);
  assert.strictEqual(by[4], 'सुनिता');
});

t('release: owner yes, stranger no, admin yes', () => {
  assert(post({ action: 'release', deviceId: D2, month: '2026-10', date: '2026-10-20', hour: 4 }).error);
  assert.strictEqual(post({ action: 'release', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 4 }).ok, true);
  assert.strictEqual(post({ action: 'release', deviceId: D2, month: '2026-10', date: '2026-10-20', hour: 3, pin: PIN() }).ok, true);
  assert(post({ action: 'release', deviceId: D2, month: '2026-10', date: '2026-10-20', hour: 2, pin: '000000' }).error);
  assert.strictEqual(post({ action: 'release', deviceId: D1, month: '2026-10', date: '2026-10-25', hour: 9 }).ok, true); // nothing there: harmless
});

t('"I prayed": own hour only, only once started, toggles', () => {
  assert(post({ action: 'prayed', deviceId: D1, month: '2026-10', date: '2026-10-20', hour: 2 }).error.includes('not started'));
  assert(post({ action: 'prayed', deviceId: D2, month: '2026-10', date: '2026-10-18', hour: 18 }).error);       // not his hour
  post({ action: 'claim', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 19, name: 'Rajan' });
  clock.hour = 19;
  assert.strictEqual(post({ action: 'prayed', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 19 }).ok, true);
  assert.strictEqual(get({ action: 'state', month: '2026-10' }).slots.find((x) => x.h === 19 && x.d === '2026-10-18').p, true);
  post({ action: 'prayed', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 19 });
  assert.strictEqual(get({ action: 'state', month: '2026-10' }).slots.find((x) => x.h === 19 && x.d === '2026-10-18').p, false);
  post({ action: 'prayed', deviceId: D1, month: '2026-10', date: '2026-10-18', hour: 19 });                      // leave prayed = true
  clock.hour = 17;
});

t('per-phone limit', () => {
  vm.runInContext('CONFIG.MAX_PER_DEVICE = 3', ctx);
  const d3 = 'dev-three-0000';
  for (let h = 5; h < 8; h++) assert.strictEqual(post({ action: 'claim', deviceId: d3, month: '2026-10', date: '2026-10-22', hour: h, name: 'Li' }).ok, true);
  assert(post({ action: 'claim', deviceId: d3, month: '2026-10', date: '2026-10-22', hour: 8, name: 'Li' }).error.includes('limit'));
  vm.runInContext('CONFIG.MAX_PER_DEVICE = 50', ctx);
});

t('prayer requests: admin only, ordered, replace-per-month, blanks dropped', () => {
  assert(post({ action: 'saveRequests', month: '2026-10', pin: 'nope', requests: [] }).error.includes('PIN'));
  assert(post({ action: 'checkPin', pin: '123' }).error);
  assert.strictEqual(post({ action: 'checkPin', pin: PIN() }).ok, true);
  const r = post({ action: 'saveRequests', month: '2026-10', pin: PIN(), requests: [
    { en: 'First', ne: 'पहिलो' }, { en: '', ne: '' }, { en: 'Second', ne: 'दोस्रो', status: 'answered' }, { en: 'Third', ne: '' }] });
  assert.strictEqual(r.saved, 3);
  post({ action: 'saveRequests', month: '2026-11', pin: PIN(), requests: [{ en: 'November one', ne: 'नोभेम्बर' }] });
  let q = get({ action: 'state', month: '2026-10' }).requests;
  assert.deepStrictEqual(q.map((x) => [x.en, x.ne, x.status, x.order]), [['First', 'पहिलो', 'active', 1], ['Second', 'दोस्रो', 'answered', 3], ['Third', '', 'active', 4]]);
  post({ action: 'saveRequests', month: '2026-10', pin: PIN(), requests: [{ en: 'Only', ne: 'मात्र' }] });
  q = get({ action: 'state', month: '2026-10' }).requests;
  assert.strictEqual(q.length, 1);
  assert.strictEqual(get({ action: 'state', month: '2026-11' }).requests.length, 1, 'other month untouched');
  post({ action: 'saveRequests', month: '2026-10', pin: PIN(), requests: [{ en: 'A', ne: 'क' }, { en: 'B', ne: 'ख' }] });
});

t('locks are always released, even after errors', () => { assert.strictEqual(lockHeldNow(), 0); });

const S = (month) => get({ action: 'state', month, deviceId: D1 }).sessions;
const saveS = (list, pin) => post({ action: 'saveSessions', month: '2026-10', pin: pin === undefined ? PIN() : pin, sessions: list });

t('group sessions: admin only; validated; saved in order with default length', () => {
  assert(saveS([{ d: '2026-10-25', t: '20:00', en: 'World prayer', ne: 'विश्व प्रार्थना' }], 'nope').error.includes('PIN'));
  assert(saveS([{ d: '2026-11-02', t: '20:00', en: 'Wrong month' }]).error.includes('date in this month'));
  assert(saveS([{ d: '2026-10-25', t: '25:00', en: 'Bad time' }]).error.includes('start time'));
  assert(saveS([{ d: '2026-10-25', t: '20:00' }]).error.includes('title'));
  assert(saveS([{ d: '2026-10-25', t: '20:00', en: 'x', link: 'javascript:alert(1)' }]).error.includes('http'));
  assert(saveS([{ d: '2026-10-25', t: '20:00', en: 'x', link: 'https://x.test/a b' }]).error.includes('http'));
  assert.strictEqual(S('2026-10').length, 0, 'failed saves change nothing');
  const r = saveS([
    { d: '2026-10-30', t: '07:30', dur: 5000, en: 'Late', ne: 'पछि', link: 'https://meet.example/abc' },
    { d: '2026-10-25', t: '20:00', en: 'World prayer', ne: 'विश्व प्रार्थना' },
    { d: '', t: '', en: '', ne: '' }]);
  assert.strictEqual(r.saved, 2);
  const list = S('2026-10');
  assert.deepStrictEqual(list.map((x) => x.en), ['World prayer', 'Late'], 'sorted by date and time');
  assert.strictEqual(list[0].dur, 60);
  assert.strictEqual(list[1].dur, 240, 'length is capped');
  assert.strictEqual(list[1].link, 'https://meet.example/abc');
});

t('failed re-save keeps the existing sessions and their joiners', () => {
  const id = S('2026-10')[0].id;
  assert.strictEqual(post({ action: 'join', deviceId: D1, month: '2026-10', sessionId: id, name: 'Rajan Sharma', country: 'Nepal' }).ok, true);
  assert(saveS([{ id, d: '2026-10-25', t: 'bad', en: 'x' }]).error);
  assert.strictEqual(S('2026-10').length, 2);
  assert.strictEqual(S('2026-10')[0].joined.length, 1);
});

t('joining: first name + place cleaned, flagged mine only for owner, re-join updates, others can join', () => {
  const id = S('2026-10')[0].id;
  assert.strictEqual(post({ action: 'join', deviceId: D1, month: '2026-10', sessionId: id, name: 'Raj', country: '=Kathmandu <b>Nepal</b>' }).ok, true);
  assert.strictEqual(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: id, name: 'Maria Lopez', country: 'Brazil' }).ok, true);
  const mineView = get({ action: 'state', month: '2026-10', deviceId: D1 }).sessions[0].joined;
  assert.strictEqual(mineView.length, 2, 're-join did not duplicate');
  assert.deepStrictEqual(mineView.map((j) => [j.n, j.m]), [['Raj', true], ['Maria', false]]);
  assert(!/[=<>]/.test(mineView[0].c) && mineView[0].c.includes('Kathmandu'), 'place cleaned: ' + mineView[0].c);
  assert(!JSON.stringify(get({ action: 'state', month: '2026-10', deviceId: D2 })).includes(D1), 'deviceId must not leak');
  assert(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: id, name: '  ' }).error);
  assert(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: 'nope', name: 'A' }).error.includes('no longer'));
  assert(post({ action: 'join', deviceId: 'x', month: '2026-10', sessionId: id, name: 'A' }).error);
});

t('joining: allowed until the session ends (late joins ok, midnight-crossing ok), refused after', () => {
  Object.assign(clock, { date: '2026-10-18', hour: 17, minute: 0 });
  const mk = (d, tm, dur, en) => ({ d, t: tm, dur, en, ne: '' });
  const base = S('2026-10').map((x) => ({ id: x.id, d: x.d, t: x.t, dur: x.dur, en: x.en, ne: x.ne, link: x.link }));
  saveS(base.concat([mk('2026-10-18', '08:00', 60, 'ended'), mk('2026-10-18', '16:30', 60, 'running'), mk('2026-10-18', '23:30', 90, 'crosses midnight'), mk('2026-10-18', '17:00', 60, 'starts now')]));
  const by = Object.fromEntries(S('2026-10').map((x) => [x.en, x.id]));
  assert(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: by.ended, name: 'A' }).error.includes('ended'));
  assert.strictEqual(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: by.running, name: 'A' }).ok, true);
  assert.strictEqual(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: by['crosses midnight'], name: 'A' }).ok, true);
  assert.strictEqual(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: by['starts now'], name: 'A' }).ok, true);
  Object.assign(clock, { date: '2026-10-19', hour: 0, minute: 59 });
  assert.strictEqual(post({ action: 'join', deviceId: D1, month: '2026-10', sessionId: by['crosses midnight'], name: 'B' }).ok, true, 'still running at 00:59');
  Object.assign(clock, { date: '2026-10-19', hour: 1, minute: 0 });
  assert(post({ action: 'join', deviceId: 'dev-new-99999', month: '2026-10', sessionId: by['crosses midnight'], name: 'C' }).error.includes('ended'), 'over at 01:00');
  Object.assign(clock, { date: '2026-10-18', hour: 17, minute: 0 });
});

t('leaving removes only my join; removing a session removes its joiners', () => {
  const id = S('2026-10').find((x) => x.en === 'World prayer').id;
  assert.strictEqual(post({ action: 'leave', deviceId: D2, month: '2026-10', sessionId: id }).ok, true);
  assert.deepStrictEqual(S('2026-10').find((x) => x.id === id).joined.map((j) => j.n), ['Raj']);
  assert.strictEqual(post({ action: 'leave', deviceId: D2, month: '2026-10', sessionId: id }).ok, true, 'leaving twice is harmless');
  const joinsBefore = be().sheetsById[be().props.SHEET_ID].getSheetByName('Joins').rows.length;
  const keep = S('2026-10').filter((x) => x.en === 'World prayer' || x.en === 'Late').map((x) => ({ id: x.id, d: x.d, t: x.t, dur: x.dur, en: x.en, ne: x.ne, link: x.link }));
  saveS(keep);
  assert.deepStrictEqual(S('2026-10').map((x) => x.en), ['World prayer', 'Late']);
  assert.deepStrictEqual(S('2026-10')[0].joined.map((j) => j.n), ['Raj'], 'kept session keeps its joiner');
  const joinsAfter = be().sheetsById[be().props.SHEET_ID].getSheetByName('Joins').rows.length;
  assert(joinsAfter < joinsBefore, 'joiners of removed sessions deleted');
  assert(post({ action: 'join', deviceId: D2, month: '2026-10', sessionId: id, name: 'Maria', country: 'Brazil' }).ok);   // leave one in the archive data
});

t('translate: English<->Nepali, input checks, per-phone limit, admin exempt, friendly failure, no lock held', () => {
  const r = post({ action: 'translate', deviceId: D1, text: ' Pray for rain ', from: 'en', to: 'ne' });
  assert.deepStrictEqual([r.ok, r.text], [true, '[ne] Pray for rain']);
  assert.deepStrictEqual(env.translateCalls.pop(), { text: 'Pray for rain', from: 'en', to: 'ne' });
  assert.strictEqual(post({ action: 'translate', deviceId: D1, text: 'वर्षा', from: 'ne', to: 'en' }).text, '[en] वर्षा');
  assert(post({ action: 'translate', deviceId: D1, text: '  ', from: 'en', to: 'ne' }).error);
  assert(post({ action: 'translate', deviceId: D1, text: 'x'.repeat(1001), from: 'en', to: 'ne' }).error.includes('1000'));
  assert(post({ action: 'translate', deviceId: D1, text: 'hi', from: 'en', to: 'fr' }).error.includes('English and Nepali'));
  assert(post({ action: 'translate', deviceId: D1, text: 'hi', from: 'en', to: 'en' }).error);
  assert(post({ action: 'translate', text: 'hi', from: 'en', to: 'ne' }).error.includes('device'));
  assert(post({ action: 'translate', deviceId: D1, text: 'FAIL', from: 'en', to: 'ne' }).error.includes('not available'));
  const d9 = 'dev-limit-99999';
  vm.runInContext('CONFIG.MAX_TRANSLATIONS = 3', ctx);
  for (let i = 0; i < 3; i++) assert.strictEqual(post({ action: 'translate', deviceId: d9, text: 'hi', from: 'en', to: 'ne' }).ok, true);
  assert(post({ action: 'translate', deviceId: d9, text: 'hi', from: 'en', to: 'ne' }).error.includes('limit'));
  assert.strictEqual(post({ action: 'translate', deviceId: d9, text: 'hi', from: 'en', to: 'ne', pin: PIN() }).ok, true, 'admin exempt');
  assert(post({ action: 'translate', deviceId: d9, text: 'hi', from: 'en', to: 'ne', pin: 'wrong' }).error.includes('limit'), 'wrong PIN is not exempt');
  vm.runInContext('CONFIG.MAX_TRANSLATIONS = 30', ctx);
  assert.strictEqual(lockHeldNow(), 0);
});


t('admin PIN lockout: 5 wrong tries lock admin for everyone; success resets the count', () => {
  for (let i = 0; i < 5; i++) assert(post({ action: 'checkPin', pin: '00000' + i }).error.includes('Wrong admin PIN'));
  assert(post({ action: 'checkPin', pin: PIN() }).error.includes('locked'), 'even the right PIN is refused while locked');
  assert(post({ action: 'release', deviceId: D2, month: '2026-10', date: '2026-10-25', hour: 9, pin: PIN() }).error.includes('locked'));
  assert(post({ action: 'translate', deviceId: D2, text: 'hi', from: 'en', to: 'ne', pin: PIN() }).error.includes('locked'));
  assert.strictEqual(post({ action: 'claim', deviceId: D2, month: '2026-10', date: '2026-10-26', hour: 9, name: 'Ok' }).ok, true, 'normal users are not affected');
  delete env.cache.pinfail;                                   // 15 minutes later the cache entry expires
  assert.strictEqual(post({ action: 'checkPin', pin: PIN() }).ok, true);
  for (let i = 0; i < 4; i++) post({ action: 'checkPin', pin: 'nope' });
  assert.strictEqual(post({ action: 'checkPin', pin: PIN() }).ok, true, 'correct PIN after 4 misses still works');
  for (let i = 0; i < 4; i++) post({ action: 'checkPin', pin: 'nope' });
  assert.strictEqual(post({ action: 'checkPin', pin: PIN() }).ok, true, 'and the counter was reset by the success');
  post({ action: 'release', deviceId: D2, month: '2026-10', date: '2026-10-26', hour: 9 });
});


t('archive: refuses current month; archives finished month into Drive; keeps other months', () => {
  assert(post({ action: 'archive', month: '2026-10', pin: PIN() }).error.includes('finished'));
  assert(post({ action: 'archive', month: '2026-09', pin: 'bad' }).error.includes('PIN'));
  post({ action: 'claim', deviceId: D1, month: '2026-11', date: '2026-11-03', hour: 9, name: 'Ruth' });   // November data must survive
  Object.assign(clock, { date: '2026-11-01', hour: 1 });
  const octSlotsBefore = sheetsById[props.SHEET_ID].getSheetByName('Slots').rows.filter((r) => r[1] === '2026-10').length;
  call('monthlyArchive');                                                                               // what the monthly trigger runs
  const live = sheetsById[props.SHEET_ID];
  const left = live.getSheetByName('Slots').rows.slice(1).map((r) => r[1]);
  assert(!left.includes('2026-10') && left.includes('2026-11'), 'October removed, November kept');
  assert(!live.getSheetByName('Requests').rows.slice(1).some((r) => r[1] === '2026-10'));
  assert(live.getSheetByName('Requests').rows.slice(1).some((r) => r[1] === '2026-11'));
  const archived = Object.values(sheetsById).find((s) => s.name === 'AGC Prayer Chain - 2026-10');
  assert(archived, 'archive spreadsheet exists');
  assert(filesMoved.some((f) => f.id === archived.id && f.folder === 'Archive'), 'filed in Archive folder');
  const sum = Object.fromEntries(archived.getSheetByName('Summary').rows);
  assert.strictEqual(sum['Hours in month'], '744');
  assert.strictEqual(sum['Hours covered'], String(octSlotsBefore));
  assert.strictEqual(sum['Marked "I prayed"'], '1');
  const sched = archived.getSheetByName('Schedule').rows;
  assert.deepStrictEqual(sched[0], ['Date', 'Hour', 'First name', 'Marked prayed']);
  assert.strictEqual(sched.length - 1, octSlotsBefore);
  const rq = archived.getSheetByName('Prayer Requests').rows;
  assert.deepStrictEqual(rq.slice(1).map((r) => r[0]), ['A', 'B']);
  const again = post({ action: 'archive', month: '2026-10', pin: PIN() });
  assert.strictEqual(again.archived, false);
  assert.strictEqual(lockHeldNow(), 0);
});

t('archive also saves the month\'s group sessions with who joined, then clears them', () => {
  const archived = Object.values(sheetsById).find((x) => x.name === 'AGC Prayer Chain - 2026-10');
  const gs = archived.getSheetByName('Group Sessions').rows;
  assert.strictEqual(gs.length, 3);
  assert.strictEqual(gs[1][3], 'World prayer');
  assert.strictEqual(gs[1][5], '2');
  assert(gs[1][6].includes('Raj (Kathmandu Nepal)') && gs[1][6].includes('Maria (Brazil)'));
  const live = sheetsById[props.SHEET_ID];
  assert.strictEqual(live.getSheetByName('Sessions').rows.slice(1).filter((r) => r[1] === '2026-10').length, 0);
  assert.strictEqual(live.getSheetByName('Joins').rows.length, 1, 'only the header is left');
});


t('after rollover the old month is closed and the new one is open', () => {
  assert(get({ action: 'state', month: '2026-10' }).error);
  assert.strictEqual(get({ action: 'state', month: '2026-12' }).month, '2026-12');
});

t('unknown action and bad JSON do not crash', () => {
  assert(post({ action: 'nope' }).error);
  const r = JSON.parse(call('doPost', { postData: { contents: '{bad' } }).getContent());
  assert(r.error); assert.strictEqual(lockHeldNow(), 0);
});

t('the monthly save emails the owner (success and failure)', () => {
  const m = env.mails.filter((x) => /saved to your Drive/.test(x.subject));
  assert(m.length >= 1 && m[0].to === 'owner@test' && m[0].subject.includes('2026-10'), 'success mail sent');
  const keep = props.SHEET_ID; delete props.SHEET_ID;
  call('monthlyArchive');
  props.SHEET_ID = keep;
  const f = env.mails[env.mails.length - 1];
  assert(/FAILED/.test(f.subject) && /Nothing was lost/.test(f.body), 'failure mail sent');
  assert.strictEqual(lockHeldNow(), 0);
});

t('state is cached briefly, never leaks device ids, and any write refreshes it', () => {
  const claim = post({ action: 'claim', deviceId: D1, month: '2026-11', date: '2026-11-20', hour: 5, name: 'Cara' });
  assert(claim.ok);
  const a = call('doGet', { parameter: { action: 'state', month: '2026-11', deviceId: D1 } }).getContent();
  assert(env.cache['st:2026-11'], 'month is cached after a read');
  const mineA = JSON.parse(a).slots.find((x) => x.n === 'Cara');
  assert.strictEqual(mineA.m, true);
  const b = call('doGet', { parameter: { action: 'state', month: '2026-11', deviceId: D2 } }).getContent();
  assert.strictEqual(JSON.parse(b).slots.find((x) => x.n === 'Cara').m, false, 'cached data still gives each phone its own flag');
  assert(!a.includes(D1) && !b.includes(D1) && !b.includes(D2), 'no device id in responses');
  post({ action: 'claim', deviceId: D2, month: '2026-11', date: '2026-11-20', hour: 6, name: 'Dan' });
  assert(!env.cache['st:2026-11'], 'write cleared the cache');
  assert(get({ action: 'state', month: '2026-11', deviceId: D2 }).slots.some((x) => x.n === 'Dan' && x.m));
  assert.strictEqual(lockHeldNow(), 0);
});

t('busy server gives a friendly message', () => {
  const real = ctx.LockService;
  ctx.LockService = { getScriptLock: () => ({ waitLock() { throw new Error('Lock timeout: Could not obtain lock after 15000 milliseconds.'); }, releaseLock() {} }) };
  const r = post({ action: 'claim', deviceId: D1, month: '2026-11', date: '2026-11-21', hour: 1, name: 'Eli' });
  ctx.LockService = real;
  assert(/busy/i.test(r.error) && !/Lock timeout/.test(r.error));
});

t('admin can remove every hour and sign-up under one name', () => {
  post({ action: 'claim', deviceId: D2, month: '2026-11', date: '2026-11-22', hour: 2, name: 'Prank' });
  post({ action: 'claim', deviceId: D2, month: '2026-11', date: '2026-11-22', hour: 3, name: 'prank' });
  assert(post({ action: 'removeName', month: '2026-11', name: 'Prank', pin: 'bad' }).error.includes('PIN'));
  const r = post({ action: 'removeName', month: '2026-11', name: 'PRANK', pin: PIN() });
  assert.strictEqual(r.removed, 2);
  const st = get({ action: 'state', month: '2026-11', deviceId: D1 });
  assert(!st.slots.some((x) => /prank/i.test(x.n)) && st.slots.some((x) => x.n === 'Cara'), 'only that name removed');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
