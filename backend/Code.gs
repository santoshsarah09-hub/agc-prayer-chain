/**
 * AGC Prayer Chain — backend (Google Apps Script)
 *
 * Runs as YOU, so all data lives in YOUR Google Drive:
 *   My Drive / Executive Assistant Workspace / AGC Prayer Chain /
 *       AGC Prayer Chain - Live Data   (Google Sheet the app reads and writes)
 *       Archive / AGC Prayer Chain - YYYY-MM   (one sheet saved per finished month)
 *
 * First-time setup: run setup() once (see SETUP.md).
 */

var CONFIG = {
  TZ: 'America/Chicago',        // one time zone for everyone
  START_HOUR: 0,                // first hour of each day (0 = 12 AM)
  END_HOUR: 24,                 // end of the last hour (24 = through midnight)
  CHAIN_WEEKDAY: 6,             // the prayer chain runs on this weekday: 0 = Sunday ... 6 = Saturday (null = every day of the month)
  CHAIN_WEEK: 1,                // ... in this week of the month: 1 = first, 2 = second, ...
  MAX_PER_DEVICE: 50,           // most hours one phone can hold in a month
  MAX_TRANSLATIONS: 30,         // translations one phone may request per 6 hours (the admin PIN is exempt)
  MAX_SESSIONS: 40,             // group prayer times per month
  ROOT_FOLDER: 'Executive Assistant Workspace',
  APP_FOLDER: 'AGC Prayer Chain',
  ARCHIVE_FOLDER: 'Archive',
  LIVE_NAME: 'AGC Prayer Chain - Live Data'
};

var SLOT_HEADERS = ['key', 'month', 'date', 'hour', 'name', 'deviceId', 'claimedAt', 'prayedAt'];
var REQ_HEADERS = ['id', 'month', 'en', 'ne', 'status', 'order'];
var SES_HEADERS = ['id', 'month', 'date', 'time', 'duration', 'titleEn', 'titleNe', 'link'];
var JOIN_HEADERS = ['sessionId', 'name', 'country', 'deviceId', 'joinedAt'];

/* ---------------------------------------------------------------- setup */

function setup() {
  var props = PropertiesService.getScriptProperties();
  var root = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.ROOT_FOLDER);
  var app = getOrCreateFolder_(root, CONFIG.APP_FOLDER);
  getOrCreateFolder_(app, CONFIG.ARCHIVE_FOLDER);

  if (!props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create(CONFIG.LIVE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(app);
    var slots = ss.getSheets()[0];
    slots.setName('Slots');
    prepSheet_(slots, SLOT_HEADERS);
    var reqs = ss.insertSheet('Requests');
    prepSheet_(reqs, REQ_HEADERS);
    ensureSheet_(ss, 'Sessions', SES_HEADERS);
    ensureSheet_(ss, 'Joins', JOIN_HEADERS);
    props.setProperty('SHEET_ID', ss.getId());
  }
  if (!props.getProperty('ADMIN_PIN')) {
    var pin = String(Math.floor(100000 + Math.random() * 900000));
    props.setProperty('ADMIN_PIN', pin);
    Logger.log('YOUR ADMIN PIN IS: ' + pin + '  (change it any time in Project Settings > Script properties)');
  } else {
    Logger.log('Admin PIN already set (see Project Settings > Script properties).');
  }
  installTrigger();
  Logger.log('Setup finished. Live data sheet: ' + SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl());
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'monthlyArchive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('monthlyArchive').timeBased().onMonthDay(1).atHour(1).inTimezone(CONFIG.TZ).create();
}

function prepSheet_(sheet, headers) {
  // Plain-text format everywhere so Sheets never turns "2026-10-18" into a date
  // or a typed "=..." into a formula.
  sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(sheet.getMaxColumns(), headers.length)).setNumberFormat('@');
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); prepSheet_(sh, headers); }
  return sh;
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ------------------------------------------------------------ web entry */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === 'state') return json_(getState_(p.month, p.deviceId));
    return json_({ ok: true, app: 'AGC Prayer Chain' });
  } catch (err) {
    return json_({ error: String(err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    // Translation does not touch the sheets, so it must not hold the lock (it can take a second or two).
    if (body.action === 'translate') return json_(translate_(body));
    lock.waitLock(15000);
    var res;
    switch (body.action) {
      case 'claim': res = claim_(body); break;
      case 'release': res = release_(body); break;
      case 'prayed': res = prayed_(body); break;
      case 'checkPin': requireAdmin_(body.pin); res = { ok: true }; break;
      case 'saveRequests': requireAdmin_(body.pin); res = saveRequests_(body); break;
      case 'saveSessions': requireAdmin_(body.pin); res = saveSessions_(body); break;
      case 'join': res = join_(body); break;
      case 'leave': res = leave_(body); break;
      case 'archive': requireAdmin_(body.pin); res = archiveMonth_(body.month); break;
      case 'removeName': requireAdmin_(body.pin); res = removeName_(body); break;
      default: throw new Error('Unknown action');
    }
    dropStateCache_();                       // every write makes the cached copy of the month out of date
    return json_(res);
  } catch (err) {
    var msg = String(err.message || err);
    if (/lock/i.test(msg) && !/PIN/.test(msg)) msg = 'The server is busy right now. Please try again in a moment.';
    return json_({ error: msg });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ----------------------------------------------------------------- time */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function nowParts_() {
  var s = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd-HH-mm');
  var a = s.split('-');
  return { date: a[0] + '-' + a[1] + '-' + a[2], month: a[0] + '-' + a[1], hour: Number(a[3]), minute: Number(a[4]) };
}

function nextMonth_(month) {
  var a = month.split('-'), y = Number(a[0]), m = Number(a[1]) + 1;
  if (m > 12) { m = 1; y++; }
  return y + '-' + pad2_(m);
}

function prevMonth_(month) {
  var a = month.split('-'), y = Number(a[0]), m = Number(a[1]) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + pad2_(m);
}

function daysInMonth_(month) {
  var a = month.split('-');
  return new Date(Date.UTC(Number(a[0]), Number(a[1]), 0)).getUTCDate();
}

// The one day of the month the prayer chain runs (default: the first Saturday), as 'yyyy-MM-dd'.
// Returns null when the chain runs every day (CHAIN_WEEKDAY = null).
function chainDate_(month) {
  if (CONFIG.CHAIN_WEEKDAY === null) return null;
  var a = month.split('-');
  var firstDow = new Date(Date.UTC(Number(a[0]), Number(a[1]) - 1, 1)).getUTCDay();
  var day = 1 + ((CONFIG.CHAIN_WEEKDAY - firstDow + 7) % 7) + 7 * (CONFIG.CHAIN_WEEK - 1);
  return month + '-' + pad2_(day);
}

function allowedMonths_() {
  var cur = nowParts_().month;
  return [cur, nextMonth_(cur)];
}

function checkMonth_(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || '')) || allowedMonths_().indexOf(month) < 0) {
    throw new Error('That month is not open.');
  }
  return month;
}

function isPast_(date, hour) {
  var n = nowParts_();
  return date < n.date || (date === n.date && hour < n.hour);
}

function hasStarted_(date, hour) {
  var n = nowParts_();
  return date < n.date || (date === n.date && hour <= n.hour);
}

/* ----------------------------------------------------------------- data */

function liveSheets_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Run setup() first.');
  var ss = SpreadsheetApp.openById(id);
  return {
    ss: ss, slots: ss.getSheetByName('Slots'), reqs: ss.getSheetByName('Requests'),
    sessions: ensureSheet_(ss, 'Sessions', SES_HEADERS), joins: ensureSheet_(ss, 'Joins', JOIN_HEADERS)
  };
}

// Reads a sheet as rows of plain strings. Google Sheets sometimes turns typed text such as "2026-11" or
// "2026-11-07" into real dates (and "20:00" into a time). Those are turned back into the exact text the app uses,
// based on the column name, so older rows written that way still show up in the app.
function rows_(sheet) {
  var v = sheet.getDataRange().getValues();
  if (!v.length) return [];
  var head = v[0].map(String);
  var tz = CONFIG.TZ;
  try { tz = sheet.getParent().getSpreadsheetTimeZone() || CONFIG.TZ; } catch (e) { /* keep default */ }
  var fmt = head.map(function (h) {
    return h === 'month' ? 'yyyy-MM' : h === 'date' ? 'yyyy-MM-dd' : h === 'time' ? 'HH:mm' : null;
  });
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][0]) === '') continue;
    out.push({ row: i + 1, v: v[i].map(function (x, c) {
      if (x instanceof Date) return fmt[c] ? Utilities.formatDate(x, tz, fmt[c]) : x.toISOString();
      return String(x);
    }) });
  }
  return out;
}

// Adds a row as plain text (unlike appendRow, which lets Sheets turn "2026-11-07" into a date).
function appendText_(sheet, values) {
  var r = sheet.getLastRow() + 1;
  var rng = sheet.getRange(r, 1, 1, values.length);
  rng.setNumberFormat('@');
  rng.setValues([values.map(String)]);
}

function cleanName_(raw) {
  var s = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f<>&"'`\\]/g, ' ').trim();
  s = s.split(/\s+/)[0] || '';                 // first name only
  s = s.replace(/^[=+\-@]+/, '');              // never start like a formula
  s = Array.from(s).slice(0, 20).join('');
  if (!s) throw new Error('Please enter your first name.');
  return s;
}

function slotKey_(date, hour) { return date + '-' + pad2_(hour); }

function parseSlot_(body) {
  var month = checkMonth_(body.month);
  var date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) throw new Error('Bad date.');
  var day = Number(date.slice(8, 10));
  if (day < 1 || day > daysInMonth_(month)) throw new Error('Bad date.');
  var cd = chainDate_(month);
  if (cd && date !== cd) throw new Error('The prayer chain is only on ' + cd + '.');
  var hour = Number(body.hour);
  if (!(hour >= CONFIG.START_HOUR && hour < CONFIG.END_HOUR && hour % 1 === 0)) throw new Error('Bad hour.');
  return { month: month, date: date, hour: hour, key: slotKey_(date, hour) };
}

// Reading the sheets is the slow part (about a second). Many phones asking at once could hit Google's
// limit of ~30 simultaneous runs, so the month's data is kept in a short-lived cache and thrown away
// whenever anything is written. The cache is private to the script; each phone only gets its own "mine" flags.
function stateCacheKey_(month) { return 'st:' + month; }

function dropStateCache_() {
  try {
    var months = allowedMonths_();
    CacheService.getScriptCache().removeAll(months.map(stateCacheKey_));
  } catch (e) { /* cache is only an optimization */ }
}

function readMonth_(month) {
  var L = liveSheets_();
  var slots = [];
  rows_(L.slots).forEach(function (r) {
    if (r.v[1] !== month) return;
    slots.push({ d: r.v[2], h: Number(r.v[3]), n: r.v[4], dev: r.v[5], p: r.v[7] !== '' });
  });
  var requests = [];
  rows_(L.reqs).forEach(function (r) {
    if (r.v[1] !== month) return;
    requests.push({ id: r.v[0], en: r.v[2], ne: r.v[3], status: r.v[4] === 'answered' ? 'answered' : 'active', order: Number(r.v[5]) || 0 });
  });
  requests.sort(function (a, b) { return a.order - b.order; });
  var joinRows = rows_(L.joins);
  var sessions = [];
  rows_(L.sessions).forEach(function (r) {
    if (r.v[1] !== month) return;
    var joined = joinRows.filter(function (j) { return j.v[0] === r.v[0]; }).map(function (j) {
      return { n: j.v[1], c: j.v[2], dev: j.v[3] };
    });
    sessions.push({ id: r.v[0], d: r.v[2], t: r.v[3], dur: Number(r.v[4]) || 60, en: r.v[5], ne: r.v[6], link: r.v[7], joined: joined });
  });
  sessions.sort(function (a, b) { return (a.d + a.t) < (b.d + b.t) ? -1 : 1; });
  return { slots: slots, requests: requests, sessions: sessions };
}

function getState_(month, deviceId) {
  month = checkMonth_(month);
  var cache = CacheService.getScriptCache(), key = stateCacheKey_(month), raw = null;
  try { var hit = cache.get(key); if (hit) raw = JSON.parse(hit); } catch (e) { raw = null; }
  if (!raw) {
    raw = readMonth_(month);
    try { var txt = JSON.stringify(raw); if (txt.length < 90000) cache.put(key, txt, 20); } catch (e) { /* too big or cache down */ }
  }
  var dev = String(deviceId || '');
  var n = nowParts_();
  return {
    month: month,
    slots: raw.slots.map(function (s) { return { d: s.d, h: s.h, n: s.n, m: !!dev && s.dev === dev, p: s.p }; }),
    requests: raw.requests,
    sessions: raw.sessions.map(function (q) {
      return { id: q.id, d: q.d, t: q.t, dur: q.dur, en: q.en, ne: q.ne, link: q.link,
        joined: q.joined.map(function (j) { return { n: j.n, c: j.c, m: !!dev && j.dev === dev }; }) };
    }),
    config: { tz: CONFIG.TZ, startHour: CONFIG.START_HOUR, endHour: CONFIG.END_HOUR, months: allowedMonths_(), nowDate: n.date, nowHour: n.hour,
      chainWeekday: CONFIG.CHAIN_WEEKDAY, chainWeek: CONFIG.CHAIN_WEEK, chainDate: chainDate_(month) }
  };
}

/* -------------------------------------------------------------- actions */

function claim_(body) {
  var s = parseSlot_(body);
  if (isPast_(s.date, s.hour)) throw new Error('That hour has already passed.');
  var deviceId = String(body.deviceId || '');
  if (deviceId.length < 8) throw new Error('Missing device.');
  var name = cleanName_(body.name);
  var L = liveSheets_();
  var mine = 0;
  var taken = false;
  rows_(L.slots).forEach(function (r) {
    if (r.v[0] === s.key) taken = true;
    if (r.v[1] === s.month && r.v[5] === deviceId) mine++;
  });
  if (taken) throw new Error('taken');
  if (mine >= CONFIG.MAX_PER_DEVICE) throw new Error('You have reached the limit of ' + CONFIG.MAX_PER_DEVICE + ' hours this month.');
  appendText_(L.slots, [s.key, s.month, s.date, String(s.hour), name, deviceId, new Date().toISOString(), '']);
  return { ok: true };
}

function release_(body) {
  var s = parseSlot_(body);
  var isAdmin = !!body.pin && checkPin_(body.pin);
  var L = liveSheets_();
  var found = rows_(L.slots).filter(function (r) { return r.v[0] === s.key; })[0];
  if (!found) return { ok: true };
  if (!isAdmin && found.v[5] !== String(body.deviceId || '')) throw new Error('You can only release your own hour.');
  L.slots.deleteRow(found.row);
  return { ok: true };
}

// Admin: take every hour (and group-time sign-up) under one first name off the board, e.g. after a prank.
function removeName_(body) {
  var month = checkMonth_(body.month);
  var target = cleanName_(body.name).toLowerCase();
  var L = liveSheets_();
  var slots = rows_(L.slots).filter(function (r) { return r.v[1] === month && r.v[4].toLowerCase() === target; });
  for (var i = slots.length - 1; i >= 0; i--) L.slots.deleteRow(slots[i].row);
  var sesIds = {};
  rows_(L.sessions).forEach(function (r) { if (r.v[1] === month) sesIds[r.v[0]] = true; });
  var joins = rows_(L.joins).filter(function (j) { return sesIds[j.v[0]] && j.v[1].toLowerCase() === target; });
  for (var k = joins.length - 1; k >= 0; k--) L.joins.deleteRow(joins[k].row);
  return { ok: true, removed: slots.length + joins.length };
}

function prayed_(body) {
  var s = parseSlot_(body);
  if (!hasStarted_(s.date, s.hour)) throw new Error('This hour has not started yet.');
  var L = liveSheets_();
  var found = rows_(L.slots).filter(function (r) { return r.v[0] === s.key; })[0];
  if (!found || found.v[5] !== String(body.deviceId || '')) throw new Error('You can only check in on your own hour.');
  L.slots.getRange(found.row, 8).setValue(found.v[7] === '' ? new Date().toISOString() : '');
  return { ok: true };
}

// Checks the admin PIN. After 5 wrong tries (from anyone) admin actions are locked for 15 minutes,
// so the PIN cannot be guessed by trial and error.
function checkPin_(pin) {
  var cache = CacheService.getScriptCache();
  if (Number(cache.get('pinfail')) >= 5) throw new Error('Too many wrong PINs. Admin is locked for 15 minutes.');
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (real && String(pin || '') === real) { cache.put('pinfail', '0', 900); return true; }
  if (pin) cache.put('pinfail', String((Number(cache.get('pinfail')) || 0) + 1), 900);
  return false;
}

function requireAdmin_(pin) {
  if (!checkPin_(pin)) throw new Error('Wrong admin PIN.');
}

function cleanText_(t) {
  return String(t || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 1000);
}

function saveRequests_(body) {
  var month = checkMonth_(body.month);
  var list = Array.isArray(body.requests) ? body.requests.slice(0, 60) : [];
  var L = liveSheets_();
  var old = rows_(L.reqs).filter(function (r) { return r.v[1] === month; });
  for (var i = old.length - 1; i >= 0; i--) L.reqs.deleteRow(old[i].row);   // bottom-up keeps row numbers valid
  var n = 0;
  list.forEach(function (q, idx) {
    var en = cleanText_(q.en), ne = cleanText_(q.ne);
    if (!en && !ne) return;
    appendText_(L.reqs, [Utilities.getUuid(), month, en, ne, q.status === 'answered' ? 'answered' : 'active', String(idx + 1)]);
    n++;
  });
  return { ok: true, saved: n };
}

/* ------------------------------------------------------- group sessions */
// A group session is a time the admin announces when many people, in different places,
// pray together. Times are stored in the chain time zone (CONFIG.TZ); each phone converts
// them to the viewer's own time zone.

function cleanLink_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.length > 300 || !/^https?:\/\/[^\s<>"'`\\]+$/i.test(s)) throw new Error('The meeting link must start with http:// or https://');
  return s;
}

function cleanPlace_(raw) {
  var s = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f<>&"'`\\]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@]+/, '');
  return Array.from(s).slice(0, 30).join('');
}

// "2026-10-25" + "23:30" + 90 minutes -> "2026-10-26 01:00" (plain clock arithmetic in the chain time zone)
function endString_(date, time, minutes) {
  var iso = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)),
    Number(time.slice(0, 2)), Number(time.slice(3, 5)) + minutes)).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

function nowString_() {
  var n = nowParts_();
  return n.date + ' ' + pad2_(n.hour) + ':' + pad2_(n.minute);
}

function sessionEnded_(row) {
  return nowString_() >= endString_(row.v[2], row.v[3], Number(row.v[4]) || 60);
}

function saveSessions_(body) {
  var month = checkMonth_(body.month);
  var list = Array.isArray(body.sessions) ? body.sessions.slice(0, CONFIG.MAX_SESSIONS) : [];
  var L = liveSheets_();
  var old = rows_(L.sessions).filter(function (r) { return r.v[1] === month; });
  var oldIds = {};
  old.forEach(function (r) { oldIds[r.v[0]] = true; });

  // Validate everything first, so a mistake never leaves the month half-saved.
  var clean = [];
  list.forEach(function (q) {
    var date = String(q.d || ''), time = String(q.t || '');
    var en = cleanText_(q.en).slice(0, 120), ne = cleanText_(q.ne).slice(0, 120);
    if (!en && !ne && !date) return;                                  // empty row
    if (!en && !ne) throw new Error('Each group time needs a title.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month ||
        Number(date.slice(8, 10)) < 1 || Number(date.slice(8, 10)) > daysInMonth_(month) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error('Each group time needs a date in this month and a start time.');
    }
    var dur = Math.round(Number(q.dur)) || 60;
    dur = Math.max(15, Math.min(240, dur));
    clean.push({ id: (q.id && oldIds[q.id]) ? String(q.id) : Utilities.getUuid(), date: date, time: time, dur: dur, en: en, ne: ne, link: cleanLink_(q.link) });
  });

  var keep = {};
  clean.forEach(function (c) { keep[c.id] = true; });
  for (var i = old.length - 1; i >= 0; i--) L.sessions.deleteRow(old[i].row);
  clean.forEach(function (c) {
    appendText_(L.sessions, [c.id, month, c.date, c.time, String(c.dur), c.en, c.ne, c.link]);
  });
  // People who joined a session that was removed go with it.
  var joins = rows_(L.joins).filter(function (j) { return oldIds[j.v[0]] && !keep[j.v[0]]; });
  for (var k = joins.length - 1; k >= 0; k--) L.joins.deleteRow(joins[k].row);
  return { ok: true, saved: clean.length };
}

function join_(body) {
  var month = checkMonth_(body.month);
  var L = liveSheets_();
  var id = String(body.sessionId || '');
  var ses = rows_(L.sessions).filter(function (r) { return r.v[0] === id && r.v[1] === month; })[0];
  if (!ses) throw new Error('That group time no longer exists.');
  if (sessionEnded_(ses)) throw new Error('This group time has already ended.');
  var deviceId = String(body.deviceId || '');
  if (deviceId.length < 8) throw new Error('Missing device.');
  var name = cleanName_(body.name), place = cleanPlace_(body.country);
  var joins = rows_(L.joins).filter(function (j) { return j.v[0] === id; });
  var mine = joins.filter(function (j) { return j.v[3] === deviceId; })[0];
  if (mine) {                                                          // joining again just updates the name/place
    L.joins.getRange(mine.row, 2, 1, 2).setValues([[name, place]]);
    return { ok: true };
  }
  if (joins.length >= 500) throw new Error('This group time is full.');
  appendText_(L.joins, [id, name, place, deviceId, new Date().toISOString()]);
  return { ok: true };
}

function leave_(body) {
  var L = liveSheets_();
  var id = String(body.sessionId || ''), deviceId = String(body.deviceId || '');
  var mine = rows_(L.joins).filter(function (j) { return j.v[0] === id && j.v[3] === deviceId; })[0];
  if (mine) L.joins.deleteRow(mine.row);
  return { ok: true };
}

/* ------------------------------------------------------------ translator */
// English <-> Nepali using Google's built-in translation (LanguageApp). It is a machine translation:
// good for a first draft, not a substitute for a Nepali speaker's check.

function translate_(body) {
  var text = String(body.text || '').trim();
  var from = String(body.from || ''), to = String(body.to || '');
  if (!text) throw new Error('Nothing to translate.');
  if (text.length > 1000) throw new Error('Please translate up to 1000 characters at a time.');
  if (!((from === 'en' && to === 'ne') || (from === 'ne' && to === 'en'))) throw new Error('Only English and Nepali are supported.');
  var isAdmin = !!body.pin && checkPin_(body.pin);
  if (!isAdmin) {
    var deviceId = String(body.deviceId || '');
    if (deviceId.length < 8) throw new Error('Missing device.');
    var cache = CacheService.getScriptCache();
    var key = 'tr:' + deviceId.slice(0, 40);
    var n = Number(cache.get(key)) || 0;
    if (n >= CONFIG.MAX_TRANSLATIONS) throw new Error('Translation limit reached for now. Please try again in a few hours.');
    cache.put(key, String(n + 1), 21600);
  }
  var out;
  try { out = LanguageApp.translate(text, from, to); } catch (err) { throw new Error('Translation is not available right now.'); }
  return { ok: true, text: String(out) };
}

/* -------------------------------------------------------------- archive */

// Runs by itself on the 1st. It emails the owner either way, so a failure never goes unnoticed.
function monthlyArchive() {
  var prev = prevMonth_(nowParts_().month);
  var lock = LockService.getScriptLock();
  var subject, body;
  try {
    lock.waitLock(30000);
    var r = archiveMonth_(prev);
    dropStateCache_();
    subject = 'AGC Prayer Chain: ' + prev + (r.archived ? ' saved to your Drive' : ' - nothing to save');
    body = r.archived ? ('The month ' + prev + ' was saved (' + r.hours + ' hours covered).\n' + r.url) : (r.note || 'Nothing to archive.');
  } catch (err) {
    subject = 'AGC Prayer Chain: monthly save FAILED for ' + prev;
    body = 'The automatic save did not finish: ' + String(err.message || err) +
      '\nOpen the app > Admin > "Save last month to Drive" to try again. Nothing was lost.';
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
  try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body); } catch (e) { /* email is a courtesy */ }
}

function archiveMonth_(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('Bad month.');
  if (month >= nowParts_().month) {
    // Archiving removes the month from the live app, so only finished months can be archived.
    throw new Error('Only finished months can be archived.');
  }
  var L = liveSheets_();
  var slotRows = rows_(L.slots).filter(function (r) { return r.v[1] === month; });
  var reqRows = rows_(L.reqs).filter(function (r) { return r.v[1] === month; });
  var sesRows = rows_(L.sessions).filter(function (r) { return r.v[1] === month; });
  var sesIds = {};
  sesRows.forEach(function (r) { sesIds[r.v[0]] = true; });
  var joinRows = rows_(L.joins).filter(function (j) { return sesIds[j.v[0]]; });
  if (!slotRows.length && !reqRows.length && !sesRows.length) return { ok: true, archived: false, note: 'Nothing to archive for ' + month };

  sesRows.sort(function (a, b) { return (a.v[2] + a.v[3]) < (b.v[2] + b.v[3]) ? -1 : 1; });
  slotRows.sort(function (a, b) { return a.v[0] < b.v[0] ? -1 : 1; });
  reqRows.sort(function (a, b) { return Number(a.v[5]) - Number(b.v[5]); });

  var root = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.ROOT_FOLDER);
  var app = getOrCreateFolder_(root, CONFIG.APP_FOLDER);
  var archive = getOrCreateFolder_(app, CONFIG.ARCHIVE_FOLDER);

  var out = SpreadsheetApp.create('AGC Prayer Chain - ' + month);
  DriveApp.getFileById(out.getId()).moveTo(archive);

  var total = (chainDate_(month) ? 1 : daysInMonth_(month)) * (CONFIG.END_HOUR - CONFIG.START_HOUR);
  var prayed = slotRows.filter(function (r) { return r.v[7] !== ''; }).length;
  var summary = out.getSheets()[0];
  summary.setName('Summary');
  summary.getRange(1, 1, 6, 2).setNumberFormat('@').setValues([
    ['Month', month],
    ['Chain day', chainDate_(month) || 'every day'],
    ['Hours in month', String(total)],
    ['Hours covered', String(slotRows.length)],
    ['Marked "I prayed"', String(prayed)],
    ['Coverage', Math.round(100 * slotRows.length / total) + '%']
  ]);

  var sched = out.insertSheet('Schedule');
  var sv = [['Date', 'Hour', 'First name', 'Marked prayed']];
  slotRows.forEach(function (r) {
    var h = Number(r.v[3]);
    sv.push([r.v[2], hourLabel_(h) + ' - ' + hourLabel_((h + 1) % 24), r.v[4], r.v[7] !== '' ? 'Yes' : '']);
  });
  sched.getRange(1, 1, sv.length, 4).setNumberFormat('@').setValues(sv);

  var rq = out.insertSheet('Prayer Requests');
  var rv = [['English', 'Nepali', 'Status']];
  reqRows.forEach(function (r) { rv.push([r.v[2], r.v[3], r.v[4]]); });
  rq.getRange(1, 1, rv.length, 3).setNumberFormat('@').setValues(rv);

  if (sesRows.length) {
    var gs = out.insertSheet('Group Sessions');
    var gv = [['Date', 'Start time (' + CONFIG.TZ + ')', 'Minutes', 'Title (English)', 'Title (Nepali)', 'People joined', 'Who joined']];
    sesRows.forEach(function (r) {
      var who = joinRows.filter(function (j) { return j.v[0] === r.v[0]; }).map(function (j) { return j.v[1] + (j.v[2] ? ' (' + j.v[2] + ')' : ''); });
      gv.push([r.v[2], r.v[3], r.v[4], r.v[5], r.v[6], String(who.length), who.join('; ')]);
    });
    gs.getRange(1, 1, gv.length, 7).setNumberFormat('@').setValues(gv);
  }

  // Remove the archived month from the live sheets (bottom-up).
  joinRows.slice().sort(function (a, b) { return b.row - a.row; }).forEach(function (r) { L.joins.deleteRow(r.row); });
  sesRows.slice().sort(function (a, b) { return b.row - a.row; }).forEach(function (r) { L.sessions.deleteRow(r.row); });
  slotRows.slice().sort(function (a, b) { return b.row - a.row; }).forEach(function (r) { L.slots.deleteRow(r.row); });
  var reqNow = rows_(L.reqs).filter(function (r) { return r.v[1] === month; }).sort(function (a, b) { return b.row - a.row; });
  reqNow.forEach(function (r) { L.reqs.deleteRow(r.row); });

  return { ok: true, archived: true, url: out.getUrl(), hours: slotRows.length };
}

function hourLabel_(h) {
  var ap = h < 12 ? 'AM' : 'PM';
  var x = h % 12; if (x === 0) x = 12;
  return x + ' ' + ap;
}
