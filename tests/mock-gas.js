// In-memory mock of the Google Apps Script services used by backend/Code.gs.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

function makeBackend(opts = {}) {
// opts.everyDay: run the chain on every day of the month (the older behaviour) instead of the first Saturday.
let src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
if (opts.everyDay) { assert(src.includes('CHAIN_WEEKDAY: 6,')); src = src.replace('CHAIN_WEEKDAY: 6,', 'CHAIN_WEEKDAY: null,'); }

const clock = { date: '2026-10-18', hour: 17, minute: 0 };           // pretend "now" in the app's time zone
const sheetsById = {};
let idCounter = 0;
const filesMoved = [];

class Sheet {
  constructor(name) { this.name = name; this.rows = [[]]; }
  setName(n) { this.name = n; }
  getName() { return this.name; }
  getMaxRows() { return 1000; }
  getMaxColumns() { return 26; }
  getLastRow() { return this.rows.length; }
  getParent() { return { getSpreadsheetTimeZone: () => 'America/Chicago' }; }
  getDataRange() { const rows = this.rows; return { getValues: () => rows.map((r) => r.slice()) }; }
  appendRow(r) { this.rows.push(r.slice()); }
  deleteRow(n) { assert(n >= 1 && n <= this.rows.length, 'deleteRow out of range ' + n); this.rows.splice(n - 1, 1); }
  getRange(r, c, nr, nc) {
    const sh = this;
    const o = {
      setNumberFormat() { return o; },
      setValue(v) { while (sh.rows.length < r) sh.rows.push([]); sh.rows[r - 1][c - 1] = v; return o; },
      setValues(vs) { vs.forEach((row, i) => { while (sh.rows.length < r + i) sh.rows.push([]); row.forEach((v, j) => { sh.rows[r + i - 1][c + j - 1] = v; }); }); return o; }
    };
    return o;
  }
}
class Spreadsheet {
  constructor(name) { this.name = name; this.id = 'ss' + (++idCounter); this.sheets = [new Sheet('Sheet1')]; sheetsById[this.id] = this; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
}
class Folder {
  constructor(name) { this.name = name; this.kids = []; }
  getFoldersByName(n) { const m = this.kids.filter((k) => k.name === n); let i = 0; return { hasNext: () => i < m.length, next: () => m[i++] }; }
  createFolder(n) { const f = new Folder(n); this.kids.push(f); return f; }
}
const rootFolder = new Folder('My Drive');
const props = {};
const cache = {};
const translateCalls = [];
const mails = [];
let triggers = [];
let lockHeld = 0;
const logs = [];

const sandbox = {
  console,
  SpreadsheetApp: { create: (n) => new Spreadsheet(n), openById: (id) => sheetsById[id] },
  DriveApp: { getRootFolder: () => rootFolder, getFileById: (id) => ({ moveTo: (f) => { filesMoved.push({ id, folder: f.name }); } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => { let held = false; return { waitLock: () => { held = true; lockHeld++; }, releaseLock: () => { if (held) { held = false; lockHeld--; } } }; } },
  CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, removeAll: (ks) => { ks.forEach((k) => { delete cache[k]; }); } }) },
  MailApp: { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@test' }) },
  LanguageApp: { translate: (text, from, to) => { translateCalls.push({ text, from, to }); if (text === 'FAIL') throw new Error('boom'); return `[${to}] ${text}`; } },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  Utilities: {
    formatDate: (d, tz, pat) => {
      if (pat === 'yyyy-MM-dd-HH-mm') return `${clock.date}-${String(clock.hour).padStart(2, '0')}-${String(clock.minute || 0).padStart(2, '0')}`;   // "now"
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
      const g = (t) => p.find((x) => x.type === t).value;
      return pat.replace('yyyy', g('year')).replace('MM', g('month')).replace('dd', g('day')).replace('HH', g('hour')).replace('mm', g('minute'));
    },
    getUuid: () => require('crypto').randomUUID()
  },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
    newTrigger: (fn) => { const t = { getHandlerFunction: () => fn }; const b = { timeBased: () => b, onMonthDay: () => b, atHour: () => b, inTimezone: () => b, create: () => { triggers.push(t); return t; } }; return b; }
  },
  Logger: { log: (m) => logs.push(m) }
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx);

const call = (fn, ...a) => vm.runInContext(`${fn}`, ctx)(...a);
const env = { mails, translateCalls, cache, clock, sheetsById, filesMoved, props, rootFolder, ctx, call, triggers: () => triggers, lockHeld: () => lockHeld, logs };
env.post = (body) => JSON.parse(call('doPost', { postData: { contents: JSON.stringify(body) } }).getContent());
env.get = (p) => JSON.parse(call('doGet', { parameter: p }).getContent());
return env;
}
module.exports = { makeBackend };
