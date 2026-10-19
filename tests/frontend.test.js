// Front-end tests in jsdom.  Usage: NODE_PATH=<dir with jsdom> node tests/frontend.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { makeBackend } = require('./mock-gas');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chicagoNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 };
}

function boot({ api, fetchImpl, ua, chain } = {}) {
  // Tests run against the app with no backend URL (demo) or a fake one; chain:true keeps the first-Saturday rule,
  // otherwise the older every-day mode is used so the general tests can pick any day.
  let html = HTML.replace(/const API_URL = '[^']*';/, `const API_URL = '${api || ''}';`);
  if (!chain) html = html.replace('const CHAIN_DEFAULT = { weekday: 6, week: 1 };', 'const CHAIN_DEFAULT = { weekday: null, week: 1 };');
  const errors = [], downloads = [];
  const dom = new JSDOM(html, {
    url: 'https://prayer.example/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      if (ua) Object.defineProperty(w.navigator, 'userAgent', { get: () => ua });
      w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {}; w.confirm = () => true;
      w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, name: this.download }); };
      if (fetchImpl) w.fetch = fetchImpl;
      w.addEventListener('error', (e) => errors.push(e.message));
    }
  });
  const w = dom.window, d = w.document;
  const api2 = {
    w, d, errors, downloads,
    $: (s) => d.querySelector(s), $$: (s) => [...d.querySelectorAll(s)],
    // Visible text only (never the <script> source, which contains every label as a string literal).
    text: () => ['#app', '#tabs', '#sheet'].map((s) => (d.querySelector(s) || { textContent: '' }).textContent).join(' ').replace(/\s+/g, ' '),
    S: (expr) => w.eval(expr),
    async idle() { for (let i = 0; i < 100; i++) { await sleep(10); if (!w.eval('S.busy')) break; } await sleep(30); },
    async click(sel) { const el = typeof sel === 'string' ? d.querySelector(sel) : sel; assert(el, 'missing element: ' + sel); el.click(); await api2.idle(); },
    type(sel, v) { const el = typeof sel === 'string' ? d.querySelector(sel) : sel; assert(el, 'missing input ' + sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    async tab(v) { await api2.click(`nav [data-v="${v}"]`); },
    close() { w.close(); }
  };
  return api2;
}
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; process.exitCode = 1; console.error('FAIL  ' + name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
  console.log('Front end — demo mode');
  const A = boot(); await sleep(200);

  await t('renders English and Nepali titles, five tabs, demo banner, no script errors', () => {
    assert(A.text().includes('AGC Prayer Chain') && A.text().includes('AGC प्रार्थना शृङ्खला'));
    assert.strictEqual(A.$$('nav button').length, 5);
    assert(A.text().includes('Demo mode'));
    assert.deepStrictEqual(A.errors, []);
  });
  await t('shows all 24 hours of the day with coverage meter', () => {
    assert.strictEqual(A.$$('.slot').length, 24);
    assert(A.$('.meter') && /\d+%/.test(A.text()));
  });
  await t('can pick an open hour: asks for first name, shows first name only, marks as mine', async () => {
    const btn = A.$('.slot.open button[data-act="pick"]'); assert(btn, 'an open hour exists');
    const h = btn.dataset.h, d = btn.dataset.d;
    await A.click(btn);
    assert(A.$('#sheet.open'));
    A.type('#nameIn', 'Santosh Sharma');
    await A.click('[data-act="confirmPick"]');
    assert(!A.$('#sheet.open'), 'sheet closes');
    const row = A.$(`.slot[data-hour="${h}"]`);
    assert(row.classList.contains('mine'));
    assert(row.textContent.includes('Santosh') && !row.textContent.includes('Sharma'));
    A.d.__h = h; A.d.__d = d;
  });
  await t('name is remembered for the next pick', async () => {
    const btn = A.$('.slot.open button[data-act="pick"]'); await A.click(btn);
    assert.strictEqual(A.$('#nameIn').value, 'Santosh');
    await A.click('[data-act="closeSheet"]');
    assert(!A.$('#sheet.open'));
  });
  await t('empty name is refused and nothing is saved', async () => {
    const btn = A.$('.slot.open button[data-act="pick"]'); const h = btn.dataset.h;
    await A.click(btn); A.type('#nameIn', '   ');
    await A.click('[data-act="confirmPick"]');
    assert(A.$('#sheet.open') && A.$('#toast').textContent.includes('first name'));
    await A.click('[data-act="closeSheet"]');
    assert(!A.$(`.slot[data-hour="${h}"]`).classList.contains('mine'));
  });
  await t('HTML in a name is neutralised', async () => {
    const btn = A.$('.slot.open button[data-act="pick"]'); const h = btn.dataset.h;
    await A.click(btn); A.type('#nameIn', '<img src=x onerror=alert(1)>Eve');
    await A.click('[data-act="confirmPick"]');
    assert.strictEqual(A.$$('main img').length, 0);
    assert(A.$(`.slot[data-hour="${h}"]`).textContent.includes('Eve') && !A.$(`.slot[data-hour="${h}"]`).textContent.includes('img'), 'tag removed, name kept');
  });
  await t('someone else\'s hour has no Pick button; mine has Cancel', () => {
    A.$$('.slot').forEach((r) => {
      if (r.classList.contains('open')) return;
      const hasPick = !!r.querySelector('[data-act="pick"]');
      assert(!hasPick, 'taken/past rows cannot be picked');
    });
    assert(A.$('.slot.mine [data-act="cancel"]'));
  });
  await t('My Hours lists my hours with calendar reminder; reminder downloads an .ics', async () => {
    await A.tab('mine');
    assert(A.$$('main .card').length >= 2);
    await A.click('[data-act="cal"]');
    assert.strictEqual(A.downloads.length, 1);
    assert(/^prayer-\d{4}-\d{2}-\d{2}-\d{2}\.ics$/.test(A.downloads[0].name));
  });
  await t('cancelling releases the hour', async () => {
    const before = A.$$('main .card').length;
    await A.click('[data-act="cancel"]');
    assert.strictEqual(A.$$('main .card').length, before - 1);
  });
  await t('prayer requests show English and Nepali side by side', async () => {
    await A.tab('requests');
    const reqs = A.$$('.req'); assert.strictEqual(reqs.length, 3);
    assert(reqs[0].children[0].textContent.includes('church families'));
    assert(reqs[0].children[1].textContent.includes('मण्डलीका'));
    assert(A.text().includes('प्रार्थनाका विषयहरू'));
  });
  await t('admin: wrong PIN stays locked, right PIN unlocks; add, save, answered section', async () => {
    await A.click('#gear');
    A.type('#pinIn', '0000'); await A.click('[data-act="unlock"]');
    assert(A.$('#pinIn'), 'still locked');
    A.type('#pinIn', '1234'); await A.click('[data-act="unlock"]');
    const reqItems = () => A.$$('.item').filter((i) => i.querySelector('[data-i]'));
    assert.strictEqual(reqItems().length, 3);
    await A.click('[data-act="addReq"]');
    const items = reqItems(); assert.strictEqual(items.length, 4);
    A.type(items[3].querySelector('textarea[data-f="en"]'), 'Pray for <b>missionaries</b>');
    A.type(items[3].querySelector('textarea[data-f="ne"]'), 'मिसनरीहरूका लागि प्रार्थना गरौं।');
    const chk = A.$$('input[data-act="ans"]')[0]; chk.checked = true; chk.dispatchEvent(new A.w.Event('change', { bubbles: true }));
    await A.click('[data-act="saveReq"]');
    await A.tab('requests');
    assert.strictEqual(A.$$('.req').length, 4);
    assert.strictEqual(A.$$('.req.ans').length, 1);
    assert(A.text().includes('Answered prayers'));
    assert.strictEqual(A.$$('main b').length, 0, 'request text is escaped');
    assert(A.text().includes('मिसनरीहरूका'));
  });
  await t('admin can reorder and delete', async () => {
    await A.click('#gear');
    await A.click('[data-act="down"][data-i="0"]');
    assert(A.$('.item textarea[data-f="en"]').value.includes('sick'));
    await A.click('[data-act="del"][data-i="0"]');
    assert.strictEqual(A.$$('.item').filter((i) => i.querySelector('[data-i]')).length, 3);
  });
  await t('next month: no hours filled, no past hours; month tabs work', async () => {
    await A.tab('slots');
    const nextBtn = A.$$('#months button')[1]; await A.click(nextBtn); await sleep(50);
    assert.strictEqual(A.S('S.data.slots.length'), 0);
    assert(A.text().includes('0%'));
    assert.strictEqual(A.$$('.slot.past').length, 0);
    assert.strictEqual(A.$$('.day').length, A.S('daysIn(S.month)'));
  });
  await t('"find next open hour" jumps to an open hour', async () => {
    await A.click(A.$$('#months button')[0]); await sleep(50);
    A.w.eval('S.day = S.now.date');
    await A.click('[data-act="nextOpen"]');
    assert(A.S('S.day') >= A.S('S.now.date'));
  });
  await t('time zone maths: reminder times are right across daylight-saving changes', () => {
    const f = (d, h) => new Date(A.w.eval(`zonedToUtc('${d}', ${h}, 'America/Chicago')`)).toISOString();
    assert.strictEqual(f('2026-10-18', 17), '2026-10-18T22:00:00.000Z');   // CDT, UTC-5
    assert.strictEqual(f('2026-12-01', 9), '2026-12-01T15:00:00.000Z');    // CST, UTC-6
    assert.strictEqual(f('2026-11-01', 12), '2026-11-01T18:00:00.000Z');   // day DST ends
    assert.strictEqual(f('2026-03-08', 12), '2026-03-08T17:00:00.000Z');   // day DST starts
    const ics = A.w.eval(`buildIcs('2026-10-18', 17, 'America/Chicago')`);
    assert(ics.includes('DTSTART:20261018T220000Z') && ics.includes('DTEND:20261018T230000Z') && ics.includes('TRIGGER:-PT10M'));
    assert(ics.startsWith('BEGIN:VCALENDAR') && ics.trim().endsWith('END:VCALENDAR'));
  });
  await t('every on-screen string has a Nepali version (no blank translations)', () => {
    const missing = Object.entries(A.w.eval('I')).filter(([, v]) => !v[0] || !v[1] || !/[ऀ-ॿ]|^\W*$/.test(v[1]));
    assert.deepStrictEqual(missing.map((m) => m[0]), []);
  });
  await t('time zones: a viewer in another zone sees a second "your time" line (Nepal is UTC+5:45)', async () => {
    await A.tab('slots');
    const sel = A.$('#tz'); assert(sel, 'time zone picker exists');
    assert([...sel.options].some((o) => o.value === 'Asia/Kathmandu' && o.textContent.includes('UTC+5:45')));
    sel.value = 'Asia/Kathmandu'; sel.dispatchEvent(new A.w.Event('change', { bubbles: true })); await A.idle();
    assert.strictEqual(A.S('S.vtz'), 'Asia/Kathmandu');
    assert.strictEqual(A.w.eval(`localRange('2026-10-20', 0)`), 'Tue 10:45 AM – 11:45 AM');
    assert.strictEqual(A.w.eval(`localRange('2026-10-20', 23)`), 'Wed 9:45 AM – 10:45 AM');
    assert.strictEqual(A.$$('.slot .loc').length, 24);
    assert(A.$('.note') && A.$('.note').textContent.includes('chain time'));
    sel.value = 'America/Chicago'; sel.dispatchEvent(new A.w.Event('change', { bubbles: true })); await A.idle();
    assert.strictEqual(A.$$('.slot .loc').length, 0, 'same offset as the chain: no second line');
    assert(!A.$('.note'));
    assert.strictEqual(A.w.localStorage.getItem('agc_vtz'), '"America/Chicago"');
  });
  await t('Pray Together: shows chain time and my time; joining adds my first name + place; leaving removes me', async () => {
    const sel = A.$('#tz'); sel.value = 'Asia/Kathmandu'; sel.dispatchEvent(new A.w.Event('change', { bubbles: true })); await A.idle();
    await A.tab('together');
    let card = A.$('.sess'); assert(card, 'sample group time exists');
    assert(card.textContent.includes('Worldwide prayer gathering') && card.textContent.includes('विश्वव्यापी'));
    assert(card.textContent.includes('3 joined') && card.textContent.includes('Sunita (Nepal)'));
    assert(card.textContent.includes('🌍') && card.textContent.includes('GMT+5:45'), card.textContent);
    if (card.classList.contains('ended')) { console.log('      (sample session already ended today; join steps skipped)'); return; }
    await A.click('[data-act="joinPick"]');
    A.type('#nameIn', 'Santosh Sharma'); A.type('#placeIn', 'Sioux Falls, USA');
    await A.click('[data-act="confirmJoin"]');
    card = A.$('.sess');
    assert(card.textContent.includes('4 joined') && card.textContent.includes('Santosh (Sioux Falls, USA)') && !card.textContent.includes('Sharma'));
    assert(card.textContent.includes('You are in'));
    await A.click('[data-act="calSes"]');
    assert(/^prayer-group-\d{4}-\d{2}-\d{2}\.ics$/.test(A.downloads[A.downloads.length - 1].name));
    await A.click('[data-act="leaveSes"]');
    card = A.$('.sess'); assert(card.textContent.includes('3 joined') && A.$('[data-act="joinPick"]'));
  });
  await t('admin: add a group time; unsafe link refused; safe link becomes a safe anchor; titles escaped; delete works', async () => {
    await A.click('#gear');
    if (A.$('#pinIn')) { A.type('#pinIn', '1234'); await A.click('[data-act="unlock"]'); }
    const sessItems = () => A.$$('.item').filter((i) => i.querySelector('[data-si]'));
    assert.strictEqual(sessItems().length, 1);
    await A.click('[data-act="addSes"]');
    const it = sessItems()[1]; assert(it);
    const f = (n) => it.querySelector(`[data-f="${n}"]`);
    A.type(f('d'), `${A.S('S.month')}-28`); A.type(f('t'), '20:30');
    A.type(f('en'), '<b>Bold</b> evening prayer'); A.type(f('ne'), 'सँगै प्रार्थना');
    A.type(f('link'), 'javascript:alert(1)');
    await A.click('[data-act="saveSes"]');
    assert(A.$('#toast').textContent.includes('http'), 'unsafe link refused: ' + A.$('#toast').textContent);
    A.$$('.item').filter((i) => i.querySelector('[data-si]'));
    A.type(sessItems()[1].querySelector('[data-f="link"]'), 'https://meet.example/x?a=1&b=2');
    await A.click('[data-act="saveSes"]');
    await A.tab('together');
    assert.strictEqual(A.$$('.sess').length, 2);
    const mine = A.$$('.sess').find((c) => c.textContent.includes('evening prayer'));
    assert.strictEqual(mine.querySelectorAll('.h2 b').length, 0, 'title is plain text, not HTML');
    assert(mine.textContent.includes('<b>Bold</b>'));
    const a = mine.querySelector('a[href]');
    if (a) { assert.strictEqual(a.getAttribute('href'), 'https://meet.example/x?a=1&b=2'); assert(/noopener/.test(a.rel) && a.target === '_blank'); }
    else assert(mine.classList.contains('ended'), 'link hidden only when the session has ended');
    await A.click('#gear');
    await A.click('[data-act="delSes"][data-si="1"]');
    await A.click('[data-act="saveSes"]');
    await A.tab('together');
    assert.strictEqual(A.$$('.sess').length, 1);
  });
  await t('translator (demo): empty input, direction toggle keeps text, clear message that live translation needs the backend', async () => {
    await A.tab('translate');
    await A.click('[data-act="trGo"]'); assert(A.$('#toast').textContent.includes('Type or paste'));
    A.type('#trIn', 'Pray for rain'); await A.click('[data-act="trGo"]');
    assert(A.$('#toast').textContent.includes('Translation works once'));
    await A.click('[data-v="ne-en"]');
    assert.strictEqual(A.$('#trIn').lang, 'ne'); assert.strictEqual(A.$('#trIn').value, 'Pray for rain');
    assert(A.text().includes('Machine translation') && A.text().includes('मेसिनद्वारा'));
  });

  assert.deepStrictEqual(A.errors, [], 'no script errors in demo run');
  A.close();

  /* ------------------------------------------------------------------ */
  console.log('\nFront end + real backend logic — two phones');
  const be = makeBackend({ everyDay: true }); Object.assign(be.clock, chicagoNow()); be.call('setup');
  const PIN = be.props.ADMIN_PIN;
  const shim = (flag) => async (url, opts) => {
    if (flag.offline) throw new TypeError('network down');
    const u = new URL(url);
    const body = opts && opts.method === 'POST' ? be.post(JSON.parse(opts.body)) : be.get(Object.fromEntries(u.searchParams));
    return { json: async () => body, text: async () => JSON.stringify(body) };
  };
  const net = { offline: false };
  const P1 = boot({ api: 'https://script.test/exec', fetchImpl: shim(net) });
  const P2 = boot({ api: 'https://script.test/exec', fetchImpl: shim(net) });
  await sleep(300);

  await t('live mode: no demo banner; phone 1 picks an hour', async () => {
    assert(!P1.text().includes('Demo mode'));
    const btn = P1.$('.slot.open button[data-act="pick"]'); assert(btn);
    P1.w.__h = btn.dataset.h;
    await P1.click(btn); P1.type('#nameIn', 'Rajan'); await P1.click('[data-act="confirmPick"]');
    assert(P1.$(`.slot[data-hour="${P1.w.__h}"]`).classList.contains('mine'));
    assert.strictEqual(be.sheetsById[be.props.SHEET_ID].getSheetByName('Slots').rows.length, 2, 'saved in the Drive sheet');
  });
  await t('phone 2 sees it (after refresh) as someone else\'s: name shown, no cancel', async () => {
    await P2.w.eval('load(true)'); await P2.idle();
    const row = P2.$(`.slot[data-hour="${P1.w.__h}"]`);
    assert(row.textContent.includes('Rajan'));
    assert(!row.classList.contains('mine') && !row.querySelector('[data-act="cancel"]') && !row.querySelector('[data-act="pick"]'));
  });
  await t('phone 2 tries a stale hour that phone 1 just took: friendly message, no crash', async () => {
    // Make phone 2 believe the hour is open, then press Pick.
    const h = P1.w.__h, d = P1.S('S.day');
    P2.w.eval(`S.data.slots = S.data.slots.filter(s => !(s.d === '${d}' && s.h === ${h})); render();`);
    await P2.click(P2.$(`.slot[data-hour="${h}"] [data-act="pick"]`));
    P2.type('#nameIn', 'Maria'); await P2.click('[data-act="confirmPick"]');
    assert(P2.$('#toast').textContent.includes('Someone just took this hour'));
    assert(P2.$(`.slot[data-hour="${h}"]`).textContent.includes('Rajan'), 'refreshed to the truth');
  });
  await t('admin on phone 2 posts requests; phone 1 reads them', async () => {
    await P2.click('#gear'); P2.type('#pinIn', PIN); await P2.click('[data-act="unlock"]');
    await P2.click('[data-act="addReq"]');
    P2.type('.item textarea[data-f="en"]', 'Pray for rain'); P2.type('.item textarea[data-f="ne"]', 'वर्षाका लागि प्रार्थना गरौं।');
    await P2.click('[data-act="saveReq"]');
    await P1.w.eval('load(true)'); await P1.idle(); await P1.tab('requests');
    assert(P1.$('.req').children[0].textContent.includes('Pray for rain'));
    assert(P1.$('.req').children[1].textContent.includes('वर्षाका'));
  });
  await t('admin on phone 2 can remove someone else\'s hour; wrong PIN is rejected', async () => {
    await P2.tab('slots');
    P2.w.eval(`S.day = '${P1.S('S.day')}'; render();`);
    const row = P2.$(`.slot[data-hour="${P1.w.__h}"]`);
    await P2.click(row.querySelector('[data-act="remove"]'));
    assert(P2.$(`.slot[data-hour="${P1.w.__h}"]`).classList.contains('open'));
    await P2.click('#gear'); await P2.click('[data-act="lock"]');
    P2.type('#pinIn', '000000'); await P2.click('[data-act="unlock"]');
    assert(P2.$('#pinIn'), 'still locked');
  });
  await t('offline: the last view stays visible with an offline notice', async () => {
    await P1.tab('slots'); net.offline = true;
    await P1.w.eval('load(true)'); await P1.idle(); await sleep(50);
    assert(P1.text().includes('Offline'));
    assert(P1.$$('.slot').length === 24);
    net.offline = false; await P1.w.eval('load(true)'); await P1.idle();
    assert(!P1.text().includes('Offline'));
  });
  const adminOpen = async (P) => { await P.click('#gear'); if (P.$('#pinIn')) { P.type('#pinIn', PIN); await P.click('[data-act="unlock"]'); } };
  await t('live: translator shows the backend\'s translation with a copy button', async () => {
    await P1.tab('translate'); P1.type('#trIn', 'Pray for rain'); await P1.click('[data-act="trGo"]');
    assert.strictEqual(P1.$('#trOut').textContent, '[ne] Pray for rain');
    assert.strictEqual(P1.$('#trOut').lang, 'ne'); assert(P1.$('[data-act="trCopy"]'));
    await P1.click('[data-v="ne-en"]'); P1.type('#trIn', 'वर्षा'); await P1.click('[data-act="trGo"]');
    assert.strictEqual(P1.$('#trOut').textContent, '[en] वर्षा');
  });
  await t('live: admin "Translate to Nepali (draft)" fills the Nepali box for review', async () => {
    await adminOpen(P2);
    await P2.click('[data-act="addReq"]');
    const last = P2.$$('.item').filter((i) => i.querySelector('[data-i]')).pop();
    P2.type(last.querySelector('textarea[data-f="en"]'), 'Pray for our teachers');
    await P2.click(last.querySelector('[data-act="trAdmin"]'));
    const again = P2.$$('.item').filter((i) => i.querySelector('[data-i]')).pop();
    assert.strictEqual(again.querySelector('textarea[data-f="ne"]').value, '[ne] Pray for our teachers');
    assert(P2.$('#toast').textContent.includes('review'));
    assert.strictEqual(be.translateCalls.pop().text, 'Pray for our teachers');
    await P2.click(again.querySelector('[data-act="del"]'));
  });
  await t('live: admin posts a group time; phones in different zones join and see each other', async () => {
    await adminOpen(P2);
    await P2.click('[data-act="addSes"]');
    const it = P2.$$('.item').filter((i) => i.querySelector('[data-si]')).pop();
    const f = (n) => it.querySelector(`[data-f="${n}"]`);
    P2.type(f('d'), P2.S('S.now.date')); P2.type(f('t'), '23:00'); P2.type(f('en'), 'Global hour'); P2.type(f('ne'), 'विश्वव्यापी घण्टा');
    P2.type(f('link'), 'https://meet.example/global');
    await P2.click('[data-act="saveSes"]');
    assert.strictEqual(be.sheetsById[be.props.SHEET_ID].getSheetByName('Sessions').rows.length, 2, 'saved in the Drive sheet');
    P1.w.eval(`S.vtz = 'Asia/Kathmandu'; LS.set('agc_vtz', S.vtz)`); P2.w.eval(`S.vtz = 'Europe/London'; LS.set('agc_vtz', S.vtz)`);
    await P1.w.eval('load(true)'); await P1.idle(); await P1.tab('together');
    await P1.click('[data-act="joinPick"]'); P1.type('#nameIn', 'Rajan'); P1.type('#placeIn', 'Kathmandu, Nepal'); await P1.click('[data-act="confirmJoin"]');
    await P2.tab('together'); await P2.w.eval('load(true)'); await P2.idle();
    const c2 = P2.$('.sess'); assert(c2.textContent.includes('Global hour') && c2.textContent.includes('Rajan (Kathmandu, Nepal)'), c2.textContent);
    await P2.click('[data-act="joinPick"]'); P2.type('#nameIn', 'Maria'); P2.type('#placeIn', 'London'); await P2.click('[data-act="confirmJoin"]');
    await P1.w.eval('load(true)'); await P1.idle();
    const c1 = P1.$('.sess');
    assert(c1.textContent.includes('2 joined') && c1.textContent.includes('Maria (London)') && c1.textContent.includes('GMT+5:45'), c1.textContent);
    assert(c2.textContent.length > 0 && P2.$('.sess').textContent.includes('GMT'), 'London phone shows its own zone');
    assert(P1.$('a[href="https://meet.example/global"]'));
  });
  await t('live: a session that has ended cannot be joined (friendly message)', async () => {
    const [y, m, d] = be.clock.date.split('-').map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    if (tomorrow.slice(0, 7) !== be.clock.date.slice(0, 7)) { console.log('      (last day of the month: skipped)'); return; }
    await P1.tab('together');
    if (P1.$('[data-act="leaveSes"]')) await P1.click('[data-act="leaveSes"]');
    const saved = Object.assign({}, be.clock);
    Object.assign(be.clock, { date: tomorrow, hour: 0, minute: 30 });          // the 11 PM session is over on the server
    await P1.click('[data-act="joinPick"]'); P1.type('#nameIn', 'Late'); await P1.click('[data-act="confirmJoin"]');
    assert(P1.$('#toast').textContent.includes('already ended'), P1.$('#toast').textContent);
    assert(!P1.$('#sheet.open'), 'sheet is not left open');
    Object.assign(be.clock, saved);
  });
  await t('live: month rollover while the app stays open moves to the new month (no stale "offline" view)', async () => {
    await P1.tab('slots');
    Object.assign(be.clock, { date: '2026-11-01', hour: 1, minute: 0 });
    P1.w.tzNow = () => ({ date: '2026-11-01', hour: 1, minute: 0 });
    await P1.w.eval('load(true)'); await P1.idle(); await sleep(50);
    assert.strictEqual(P1.S('S.month'), '2026-11');
    assert(!P1.text().includes('Offline'));
    assert.strictEqual(P1.$$('.day').length, 30);
    assert.strictEqual(P1.$$('#months button[aria-pressed="true"]').length, 1);
  });
  await t('archive button reports cleanly', async () => {
    await adminOpen(P2);
    await P2.click('[data-act="archive"]');
    assert(P2.$('#toast').style.display === 'block');
  });

  Object.assign(be.clock, chicagoNow(), { minute: 0 });
  const Pa = boot({ api: 'https://script.test/exec', fetchImpl: shim(net) }); await sleep(300);
  await t('admin: remove every hour under one first name', async () => {
    const P2 = Pa;
    await P2.tab('slots');
    const day = P2.S('S.day'), h = [...P2.$$('.slot.open button[data-act="pick"]')].map((b) => b.dataset.h).slice(0, 2);
    for (const hh of h) { await P2.click(P2.$(`.slot[data-hour="${hh}"] [data-act="pick"]`)); P2.type('#nameIn', 'Troll'); await P2.click('[data-act="confirmPick"]'); }
    assert.strictEqual(P2.$$('.slot.mine').length >= 2, true);
    await adminOpen(P2);
    P2.type('#rmIn', 'troll'); await P2.click('[data-act="rmName"]');
    await P2.tab('slots');
    assert(!P2.text().includes('Troll'), 'Troll hours gone');
  });
  await t('My Hours shows a backup code; restoring on another phone adopts it; junk is refused', async () => {
    await Pa.tab('mine');
    const code = Pa.S('deviceId');
    assert(Pa.$('#myCode').textContent.trim() === code, 'code visible');
    const P3 = boot({ api: 'https://script.test/exec', fetchImpl: shim(net) }); await sleep(250);
    await P3.tab('mine');
    P3.type('#restoreIn', 'bad code!'); await P3.click('[data-act="restore"]');
    assert(P3.$('#toast').textContent.includes('does not look right'));
    assert.notStrictEqual(P3.w.localStorage.getItem('agc_device'), JSON.stringify(code));
    P3.type('#restoreIn', code); P3.w.eval('location.reload = () => { window.__reloaded = true; }');
    await P3.click('[data-act="restore"]');
    assert.strictEqual(P3.w.localStorage.getItem('agc_device'), JSON.stringify(code));
    P3.close();
  });
  await t('links opened inside WhatsApp/Facebook-style browsers get an "open in Safari or Chrome" notice', async () => {
    const fb = boot({ api: 'https://script.test/exec', fetchImpl: shim(net), ua: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FBAN/FB4A;FBAV/440.0]' });
    const wk = boot({ api: 'https://script.test/exec', fetchImpl: shim(net), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
    const safari = boot({ api: 'https://script.test/exec', fetchImpl: shim(net), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    await sleep(300);
    assert(fb.text().includes('Open this link in Safari or Chrome'));
    assert(wk.text().includes('Open this link in Safari or Chrome'));
    assert(!safari.text().includes('Open this link in Safari or Chrome'), 'real Safari is fine');
    assert(!Pa.text().includes('Open this link in Safari or Chrome'), 'normal browsers are fine');
    fb.close(); wk.close(); safari.close();
  });
  await t('bad connection or a broken server shows a plain message, never a raw error, and never leaves the app stuck', async () => {
    const sawSignal = [];
    const html = boot({ api: 'https://script.test/exec', fetchImpl: async (u, o) => { sawSignal.push(!!(o && o.signal)); return { text: async () => '<!DOCTYPE html><title>Sign in</title>' }; } });
    const down = boot({ api: 'https://script.test/exec', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await sleep(300);
    assert(html.text().includes('Something went wrong') || html.text().length > 0);
    const eh = html.S('S.error'), ed = down.S('S.error');
    assert(/did not answer correctly/.test(eh) && !/Unexpected token/.test(eh), eh);
    assert(/No connection/.test(ed) && !/Failed to fetch/.test(ed), ed);
    assert(sawSignal.every(Boolean), 'every request has a timeout signal');
    assert.strictEqual(html.S('S.busy'), false);
    html.close(); down.close();
  });
  Pa.close();


  await t('first Saturday: phone shows one chain day with 24 hours; other days cannot be picked', async () => {
    const be2 = makeBackend(); Object.assign(be2.clock, chicagoNow()); be2.call('setup');
    const sh = async (url, opts) => { const u = new URL(url); const body = opts && opts.method === 'POST' ? be2.post(JSON.parse(opts.body)) : be2.get(Object.fromEntries(u.searchParams)); return { text: async () => JSON.stringify(body) }; };
    const C = boot({ api: 'https://script.test/exec', fetchImpl: sh, chain: true }); await sleep(300);
    const cd = C.S('chainDates(S.month)');
    assert.strictEqual(cd.length, 1, 'one chain day');
    assert.strictEqual(new Date(cd[0] + 'T00:00:00Z').getUTCDay(), 6, 'it is a Saturday');
    assert(Number(cd[0].slice(8)) <= 7, 'first week');
    assert(cd[0] >= chicagoNow().date, 'shows the upcoming chain, not a finished one');
    assert.strictEqual(C.$$('.day').length, 0, 'no day strip');
    assert.strictEqual(C.$$('.slot').length, 24, '24 hours');
    assert(C.text().includes('Prayer chain day') && C.text().includes('पहिलो शनिबार'));
    assert(C.text().includes('of 24'), 'coverage counts 24 hours');
    const btn = C.$('.slot.open [data-act="pick"]'); await C.click(btn); C.type('#nameIn', 'Asha'); await C.click('[data-act="confirmPick"]');
    assert.strictEqual(C.$$('.slot.mine').length, 1);
    const r = await C.w.eval(`Api.post({ action: 'claim', month: S.month, date: S.month + '-28', hour: 9, name: 'X' }).then(() => 'ok', (e) => e.message)`);
    assert(/only on/.test(r), r);
    assert.deepStrictEqual(C.errors, []);
    C.close();
  });
  await t('first Saturday (demo): same rule without a backend', async () => {
    const D = boot({ chain: true }); await sleep(250);
    assert.strictEqual(D.$$('.slot').length, 24);
    assert.strictEqual(D.$$('.day').length, 0);
    assert(D.text().includes('Prayer chain day'));
    assert.deepStrictEqual(D.errors, []);
    D.close();
  });


  await t('two phones: a pick shows on the other phone as taken (name, no Pick button) and coverage goes up', async () => {
    const be3 = makeBackend(); Object.assign(be3.clock, chicagoNow()); be3.call('setup');
    const sh = async (url, opts) => { const u = new URL(url); const body = opts && opts.method === 'POST' ? be3.post(JSON.parse(opts.body)) : be3.get(Object.fromEntries(u.searchParams)); return { text: async () => JSON.stringify(body) }; };
    const A1 = boot({ api: 'https://script.test/exec', fetchImpl: sh, chain: true }), B1 = boot({ api: 'https://script.test/exec', fetchImpl: sh, chain: true });
    await sleep(300);
    assert(B1.text().includes('0 of 24'));
    const h = A1.$('.slot.open [data-act="pick"]').dataset.h;
    await A1.click(A1.$(`.slot[data-hour="${h}"] [data-act="pick"]`)); A1.type('#nameIn', 'Bimala'); await A1.click('[data-act="confirmPick"]');
    assert(A1.text().includes('1 of 24') && A1.text().includes('4%'), 'own phone updates at once');
    await B1.click('[data-act="refresh"]');
    const row = B1.$(`.slot[data-hour="${h}"]`);
    assert(row.textContent.includes('Bimala'), 'name visible to others');
    assert(!row.querySelector('[data-act="pick"]') && !row.classList.contains('open'), 'no longer available');
    assert(B1.text().includes('1 of 24') && B1.text().includes('4%'), 'coverage updated');
    assert(B1.text().includes('Updated'));
    assert.deepStrictEqual(A1.errors.concat(B1.errors), []);
    A1.close(); B1.close();
  });

  assert.deepStrictEqual(P1.errors.concat(P2.errors), [], 'no script errors in live run');
  P1.close(); P2.close();

  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})();
