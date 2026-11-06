#!/usr/bin/env node
/* Record the site's Top Picks exactly as the home page ranks them.
 *
 * The score is computed by docs/app.js itself (analyze/score/matchup/catRate), so
 * nothing here re-implements it: pick selection is the same pool + ordering as
 * viewHome() in docs/app.js. If you change that ranking, change it here too — the
 * Python side (scripts/picks.py) only merges and grades.
 *
 * Usage: node scripts/picks.js docs/data   -> {"generated": ..., "picks": [...]}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA = process.argv[2] || 'docs/data';
const APP = path.join(__dirname, '..', 'docs', 'app.js');
const noop = () => {};

/* a DOM-shaped no-op so app.js can load: it only needs document/window/fetch stubs */
const el = new Proxy(function () {}, {
  get: (t, k) => k === 'style' ? {} :
    k === 'classList' ? { add: noop, remove: noop, toggle: noop, contains: () => false } :
    k === 'dataset' ? {} : k === 'children' ? [] : k === 'value' ? '' :
    typeof k === 'string' ? el : undefined,
  set: () => true,
  apply: () => el,
});
const store = new Map();
const ctx = {
  console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
  setTimeout, clearTimeout, setInterval: noop, clearInterval: noop,
  Promise, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap,
  isNaN, isFinite, parseFloat, parseInt, RegExp, Error, URLSearchParams,
  location: { hash: '', pathname: '/' }, history: { replaceState: noop }, scrollTo: noop,
  addEventListener: noop,
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  sessionStorage: { getItem: () => null, setItem: noop },
  requestAnimationFrame: noop, innerWidth: 1200,
  matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
  document: { getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], createElement: () => el,
    body: el, documentElement: el, addEventListener: noop, activeElement: null },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  fetch: async u => {
    const f = String(u).split('?')[0].split('/').pop();
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
  },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(APP, 'utf8'), ctx, { filename: 'app.js' });

const RUN = `(async () => {
  await load();
  const now = Date.now(), pool = [];
  for (const row of S.board) {
    if (new Date(row.g.ko).getTime() < now) continue;          // game already started
    if (row.inj && BAD_STATUS.test(row.inj.status)) continue;  // out / doubtful
    if (!row.recent) continue;
    for (const sd of (row.m === 'anytime_td' ? [1] : [1, -1])) {
      const a = sd > 0 ? row.over && row.over.a : row.under && row.under.a;
      if (!a || (a.SZN && a.SZN.n || 0) < 3) continue;
      pool.push({ row, side: sd, sc: score(a).score });
    }
  }
  pool.sort((x, y) => y.sc - x.sc);
  if (S.hasBook) pool.sort((x, y) => (y.row.src === 'book') - (x.row.src === 'book') || y.sc - x.sc);
  const per = {}, top = [];
  for (const x of pool) {
    if ((per[x.row.pid] || 0) >= 2) continue;                  // max two props per player
    per[x.row.pid] = (per[x.row.pid] || 0) + 1;
    top.push(x);
    if (top.length >= 12) break;
  }
  return top.map(x => {
    const b = bestPrice(x.row, x.side);
    return { pid: x.row.pid, player: x.row.p && x.row.p.name, market: x.row.m, line: x.row.line,
      side: x.side, price: b ? b.o : null, book: b ? b.book : null, score: x.sc,
      event: x.row.g.id, commence: x.row.g.ko, week: x.row.g.week };
  });
})()`;

(async () => {
  try {
    const picks = await vm.runInContext(RUN, ctx, { filename: 'picks-run.js' });
    process.stdout.write(JSON.stringify({ generated: new Date().toISOString(), picks }));
  } catch (e) {
    process.stderr.write('picks.js: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
})();
