/* PropScout — NFL player prop research (static app). */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TZ = 'America/New_York';

/* ---------- markets ---------- */
const MK = {
  pass_yds:    {label:'Pass Yds', short:'PaYd', pos:['QB'], dvp:'QB', f:g=>g.passing_yards, alt:[-25,-10,10,25], book:true},
  pass_tds:    {label:'Pass TDs', short:'PaTD', pos:['QB'], dvp:'QB', f:g=>g.passing_tds, alt:[-1,1], book:true},
  completions: {label:'Completions', short:'Cmp', pos:['QB'], dvp:'QB', f:g=>g.completions, alt:[-3,-1,1,3], book:true},
  rush_yds:    {label:'Rush Yds', short:'RuYd', pos:['QB','RB'], dvp:null, f:g=>g.rushing_yards, alt:[-15,-5,5,15], book:true},
  rec_yds:     {label:'Rec Yds', short:'ReYd', pos:['RB','WR','TE'], dvp:null, f:g=>g.receiving_yards, alt:[-15,-5,5,15], book:true},
  receptions:  {label:'Receptions', short:'Rec', pos:['RB','WR','TE'], dvp:null, f:g=>g.receptions, alt:[-2,-1,1,2], book:true},
  anytime_td:  {label:'Anytime TD', short:'ATD', pos:['QB','RB','WR','TE'], dvp:null, f:g=>g.rushing_tds+g.receiving_tds, alt:[1], book:true, fixed:0.5},
  rush_rec_yds:{label:'Rush+Rec Yds', short:'R+R', pos:['RB','WR','TE'], dvp:null, f:g=>g.rushing_yards+g.receiving_yards, alt:[-15,-5,5,15]},
  pass_att:    {label:'Pass Att', short:'Att', pos:['QB'], dvp:'QB', f:g=>g.attempts, alt:[-3,3]},
  rush_att:    {label:'Rush Att', short:'Car', pos:['QB','RB'], dvp:null, f:g=>g.carries, alt:[-2,2]},
  targets:     {label:'Targets', short:'Tgt', pos:['RB','WR','TE'], dvp:null, f:g=>g.targets, alt:[-2,2]},
  ints:        {label:'Interceptions', short:'INT', pos:['QB'], dvp:'QB', f:g=>g.passing_interceptions, alt:[1]},
};
const BOARD_MK = ['pass_yds','pass_tds','completions','rush_yds','rec_yds','receptions','anytime_td'];
// minimum per-game volume to show a model-line prop on the board
const VOL = {pass_yds:p=>p.att>=15, pass_tds:p=>p.att>=15, completions:p=>p.att>=15, pass_att:p=>p.att>=15, ints:p=>p.att>=15,
  rush_yds:p=>p.car>=6, rush_att:p=>p.car>=6, rec_yds:p=>p.tgt>=3, receptions:p=>p.tgt>=3, targets:p=>p.tgt>=3,
  rush_rec_yds:p=>(p.car+p.tgt)>=6, anytime_td:p=>(p.car+p.tgt)>=5};
const dvpPos = (m, pos) => MK[m].dvp || (pos === 'FB' ? 'RB' : pos);
const BAD_STATUS = /^(out|doubtful|injured reserve|ir|suspension|pup)/i;

/* ---------- state ---------- */
const S = {SPORT:'nfl', POS_LIST:['QB','RB','WR','TE'], SKILL:['QB','RB','WR','TE','FB'], stats:null, games:null, inj:null, props:null, hist:null, status:null, odds:null,
  players:{}, logs:{}, gamesById:{}, injByName:{}, injByTeam:{}, slate:[], slateTeam:{}, dvp:{}, lines:{}, board:[], ready:false};
const LS = {
  get(k, d){ try{ return JSON.parse(localStorage.getItem((window.PS_PREFIX||'ps_')+k)) ?? d; }catch{ return d; } },
  set(k, v){ localStorage.setItem((window.PS_PREFIX||'ps_')+k, JSON.stringify(v)); }
};
let FAV = LS.get('fav', []);   // [{pid,m,line,side}]
let SLIP = LS.get('slip', []); // [{pid,m,line,side}]

/* ---------- utils ---------- */
const norm = n => (n||'').toLowerCase().replace(/[.'`’\-]/g,'').replace(/\b(jr|sr|ii|iii|iv|v)\b/g,'').replace(/\s+/g,' ').trim();
const r1 = x => Math.round(x*10)/10;
const pct = x => x==null ? '–' : Math.round(x*100)+'%';
const median = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
const fmtOdds = o => o==null ? '–' : (o>0?'+':'')+o;
const toDec = o => o>0 ? 1+o/100 : 1+100/(-o);
const toAm = d => d>=2 ? Math.round((d-1)*100) : Math.round(-100/(d-1));
const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-US',{timeZone:TZ,weekday:'short',hour:'numeric',minute:'2-digit'})+' ET' : '';
const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET' : '–';
const ago = iso => { if(!iso) return 'never'; const m=(Date.now()-new Date(iso))/60000; return m<60?Math.round(m)+'m ago':m<1440?Math.round(m/60)+'h ago':Math.round(m/1440)+'d ago'; };
const cls = h => h==null?'n':h>=.7?'g':h>=.5?'a':'r';
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,1800); }
const headshot = p => p?.img ? `<img class="hs" loading="lazy" src="${esc(p.img)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="hs"></div>`;
const roundHalf = x => Math.floor(x)+0.5;

/* ---------- load ---------- */
async function getJSON(f, fallback){
  try{ const r = await fetch((window.PS_DATA||'data/')+f+'?v='+Math.floor(Date.now()/600000)); if(!r.ok) throw new Error(r.status); return await r.json(); }
  catch(e){ console.warn('load fail', f, e); if(fallback!==undefined) return fallback; throw e; }
}
async function load(){
  const [stats, games, inj, props, hist, status] = await Promise.all([
    getJSON('stats.json'), getJSON('games.json'), getJSON('injuries.json',{items:[]}),
    getJSON('props.json',{lines:[]}), getJSON('line_history.json',{}), getJSON('status.json',{})]);
  Object.assign(S,{stats,games,inj,props,hist,status});
  S.snaps = await getJSON('snaps.json',{}); S.cats = await getJSON('results.json',{cats:{}});
  S.splits = await getJSON('splits.json',{games:[]}); S.splitBy={}; for(const g of S.splits.games||[]) S.splitBy[g.away+'@'+g.home] ??= g;
  const cols = stats.cols;
  S.players = stats.players;
  for(const g of games.games) S.gamesById[g.id]=g;
  for(const [pid, rows] of Object.entries(stats.logs)){
    S.logs[pid] = rows.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
  }
  for(const i of inj.items||[]){ S.injByName[norm(i.name)+'|'+i.team]=i; S.injByName[norm(i.name)] ??= i; (S.injByTeam[i.team] ??= []).push(i); }
  S.slate = games.upcoming || [];
  for(const g of S.slate){ S.slateTeam[g.home]={g,opp:g.away,home:!g.neutral,away:false}; S.slateTeam[g.away]={g,opp:g.home,home:false}; }
  buildDvP(); buildLines(); buildBoard();
  S.ready = true;
}
function injuryOf(p){ const i=S.injByName[norm(p.name)+'|'+p.team]; return i && !/^active/i.test(i.status||'') ? i : null; }

/* ---------- key injuries around a player ----------
   Own team: who competes with / feeds him.  Opponent: who covers him.
   Only Out / Doubtful / Questionable / IR, and only "key" players (season snap share
   above a starter threshold, from nflverse snap counts). */
const KI_STATUS = /^(out|doubtful|questionable|injured reserve|day-to-day)/i;
const KI_OWN = {QB:['WR','TE','OL'], RB:['RB','OL'], WR:['WR','TE','QB'], TE:['TE','WR','QB']};
const KI_OPP = {QB:['DL','CB','S'], RB:['DL','LB'], WR:['CB','S'], TE:['LB','S']};
/* score points for the OVER side per fresh Out/Doubtful/IR key player (Questionable = 40%).
   Positive = helps his volume or matchup. */
const KI_PTS = {
  own:{ QB:{WR:-2.5,TE:-1.5,OL:-2}, RB:{RB:+6,OL:-2}, WR:{WR:+4,TE:+2,QB:-6}, TE:{TE:+4,WR:+2.5,QB:-6} },
  opp:{ QB:{DL:+1.5,CB:+2.5,S:+1.5}, RB:{DL:+2,LB:+2}, WR:{CB:+4,S:+1.5}, TE:{LB:+2.5,S:+2.5} },
};
const KI_CAP = 12, KI_SELF_Q = -6;  // his own Questionable tag: -6 on either side (risk he sits or is limited)
const KI_LAB = {own:'teammate', opp:'defender'};
const kiW = st => /^(questionable|day-to-day)/i.test(st||'') ? .4 : 1;
const kiShort = st => /^injured/i.test(st)?'IR':/^out/i.test(st)?'Out':/^doubt/i.test(st)?'D':/^quest/i.test(st)?'Q':/^day/i.test(st)?'DTD':st;
const kiUse = i => i.role ? `${i.role}${i.toi?`, ${i.toi} TOI`:''}` : `${Math.round((i.snap||0)*100)}% snaps`;
const kiCls = st => /^(questionable|day-to-day)/i.test(st||'')?'a':'r';
const _ki = {};
function keyInj(pid){
  if(_ki[pid]) return _ki[pid];
  const p=S.players[pid]; const pos=p?.pos==='FB'?'RB':p?.pos; const st=S.slateTeam[p?.team];
  const res={own:[], opp:[], pts:0, notes:[]};
  if(!p || !KI_OWN[pos]) return (_ki[pid]=res);
  const pick=(team, grps, side)=>(S.injByTeam[team]||[]).filter(i=>i.key && grps.includes(i.grp) && KI_STATUS.test(i.status||'')
      && !(side==='own' && norm(i.name)===norm(p.name)))
    .map(i=>({...i, side, pts: i.fresh ? (KI_PTS[side][pos][i.grp]||0)*kiW(i.status) : 0}))
    .sort((a,b)=>Math.abs(b.pts)-Math.abs(a.pts) || (b.snap||0)-(a.snap||0));
  res.own = pick(p.team, KI_OWN[pos], 'own');
  if(st) res.opp = pick(st.opp, KI_OPP[pos], 'opp');
  let t=0; for(const i of [...res.own,...res.opp]) t+=i.pts;
  res.pts = Math.max(-KI_CAP, Math.min(KI_CAP, r1(t)));
  const me=injuryOf(p); res.self = me && /^(questionable|day-to-day)/i.test(me.status||'') ? KI_SELF_Q : 0; res.selfSt = me?.status;
  for(const i of [...res.own,...res.opp]) if(i.pts) res.notes.push({t:`${i.side==='own'?p.team:st.opp} ${i.grp} ${i.name} ${kiShort(i.status)} (${kiUse(i)})`, v:i.pts});
  return (_ki[pid]=res);
}
const kiAll = k => [...k.own, ...k.opp];
const kiLine = i => `${esc(i.name)} ${esc(i.grp)} ${kiShort(i.status)}${i.fresh?'':' (long-term)'}`;
function warnIcon(pid){
  const k=keyInj(pid), all=kiAll(k); if(!all.length) return '';
  const tip = all.map(i=>`${i.side==='own'?S.players[pid].team:S.slateTeam[S.players[pid].team]?.opp}: ${i.name} (${i.grp}) – ${i.status}${i.fresh?'':', long-term'}`).join('\n');
  return `<span class="warn" tabindex="0" role="button" aria-label="${esc(tip)}">⚠️<span class="tip">${all.map(i=>`<span><i class="pill ${kiCls(i.status)}">${kiShort(i.status)}</i> ${esc(i.side==='own'?S.players[pid].team:S.slateTeam[S.players[pid].team]?.opp)} ${esc(i.grp)} <b>${esc(i.name)}</b>${i.fresh?'':' <em>long-term</em>'}</span>`).join('')}</span></span>`;
}
function kiCompact(pid){
  const k=keyInj(pid), p=S.players[pid], opp=S.slateTeam[p.team]?.opp; if(!kiAll(k).length && !k.self) return '';
  const part=(arr,lab)=>arr.length?`<div><span class="mut">${lab}:</span> ${arr.slice(0,3).map(i=>`<span class="kit ${kiCls(i.status)}">${kiLine(i)}</span>`).join(' ')}${arr.length>3?` <span class="mut">+${arr.length-3}</span>`:''}</div>`:'';
  return `<div class="ki small"><b>🩹 Key injuries${k.pts?` <span class="pill ${k.pts>0?'g':'r'}">${k.pts>0?'+':''}${k.pts} over</span>`:''}${k.self?` <span class="pill r">${k.self} (he's Q)</span>`:''}</b>${part(k.own,p.team)}${part(k.opp,opp?opp+' D':'Opp D')}</div>`;
}
function kiPanel(pid){
  const k=keyInj(pid), p=S.players[pid], opp=S.slateTeam[p.team]?.opp, pos=p.pos==='FB'?'RB':p.pos;
  if(!KI_OWN[pos]) return '';
  const list=(arr,side)=>arr.length?arr.map(i=>`<div class="row small" style="padding:3px 0"><span class="pill ${kiCls(i.status)}">${esc(i.status)}</span><b>${esc(i.name)}</b><span class="mut">${esc(i.pos||i.grp)} · ${esc(kiUse(i))}${i.fresh?'':' · long-term (already in recent stats)'}</span><span class="sp"></span>${i.pts?`<span class="pill ${i.pts*(side==='opp'?1:1)>0?'g':'r'}">${i.pts>0?'+':''}${r1(i.pts)}</span>`:''}</div>`).join(''):'<div class="mut small">None</div>';
  return `<h2>Key injuries</h2><div class="grid g2">
   <div class="card"><div class="small mut" style="margin-bottom:4px">${p.team} at ${KI_OWN[pos].join('/')} (usage & volume)</div>${list(k.own,'own')}</div>
   <div class="card"><div class="small mut" style="margin-bottom:4px">${opp?opp+' defense':'Opponent'} at ${KI_OPP[pos].join('/')} (who covers him)</div>${opp?list(k.opp,'opp'):'<div class="mut small">No game this week</div>'}</div></div>
   <p class="small mut">Key = season snap share above a starter threshold (nflverse snap counts). Score adjustment for the Over (reversed for the Under): ${k.pts>0?'+':''}${k.pts} pts${k.self?`, plus ${k.self} because he is listed ${esc(k.selfSt)}`:''}, from fresh absences only — players already out for weeks are labeled long-term because his recent stats already reflect them. Questionable teammates/defenders count 40%. Capped at ±12.</p>`;
}

/* ---------- defense vs position ---------- */
function buildDvP(){
  const season = S.stats.season, agg = {}, off = {}; // team -> pos -> {games:Set, sums}
  for(const [pid, rows] of Object.entries(S.logs)){
    const p = S.players[pid]; if(!p) continue;
    for(const g of rows){ if(g.season!==season) continue;
      const pos = p.pos==='FB'?'RB':p.pos;
      const a = ((agg[g.opp] ??= {})[pos] ??= {games:new Set(), s:{}});
      const o = ((off[g.team] ??= {})[pos] ??= {s:{}});
      a.games.add(g.game);
      for(const m of Object.keys(MK)){ const v=MK[m].f(g); a.s[m]=(a.s[m]||0)+v; o.s[m]=(o.s[m]||0)+v; }
    }
  }
  // games a defense played this season (from schedule), so zero-production games still count
  const dGames = {};
  for(const g of S.games.games) if(g.season===season && g.hs!=null){ (dGames[g.home]??=new Set()).add(g.id); (dGames[g.away]??=new Set()).add(g.id); }
  const out = {};
  for(const pos of S.POS_LIST){
    out[pos] = {};
    for(const m of Object.keys(MK)){
      const rows = Object.keys(dGames).map(t => { const a=agg[t]?.[pos]; const n=dGames[t].size||1; return {t, v:a?(a.s[m]||0)/n:0, n}; });
      rows.sort((x,y)=>x.v-y.v); // rank 1 = fewest allowed = toughest
      rows.forEach((r,i)=>{ (out[pos][r.t] ??= {gp:r.n})[m] = {v:r1(r.v), rank:i+1}; });
    }
  }
  const outO = {};
  for(const pos of S.POS_LIST){
    outO[pos] = {};
    for(const m of Object.keys(MK)){
      const rows = Object.keys(dGames).map(t => { const a=off[t]?.[pos]; const n=dGames[t].size||1; return {t, v:a?(a.s[m]||0)/n:0, n}; });
      rows.sort((x,y)=>y.v-x.v); // rank 1 = most produced
      rows.forEach((r,i)=>{ (outO[pos][r.t] ??= {gp:r.n})[m] = {v:r1(r.v), rank:i+1}; });
    }
  }
  S.dvp = out; S.off = outO; S.dvpTeams = Object.keys(dGames).sort();
}
const dvpOf = (team, m, pos) => S.dvp[dvpPos(m,pos)]?.[team]?.[m] || null;

/* ---------- sportsbook lines ---------- */
function buildLines(){
  const by = {};
  for(const l of (S.props.lines||[])){
    let pid = l.pid;
    if(!pid){ const n = norm(l.player); pid = Object.keys(S.players).find(k=>norm(S.players[k].name)===n); }
    if(!pid) continue;
    (by[pid+'|'+l.market] ??= []).push(l);
  }
  for(const [k, arr] of Object.entries(by)){
    const main = arr.filter(l=>l.over!=null || l.under!=null);
    // consensus: the line posted by the most books (ties -> median)
    const cnt = {}; main.forEach(l=>cnt[l.line]=(cnt[l.line]||0)+1);
    const max = Math.max(...Object.values(cnt));
    const cands = Object.keys(cnt).filter(x=>cnt[x]===max).map(Number);
    const line = median(cands);
    const at = main.filter(l=>l.line===line);
    const bestO = at.filter(l=>l.over!=null).sort((a,b)=>toDec(b.over)-toDec(a.over))[0];
    const bestU = at.filter(l=>l.under!=null).sort((a,b)=>toDec(b.under)-toDec(a.under))[0];
    S.lines[k] = {line, books:main.sort((a,b)=>a.book.localeCompare(b.book)), bestO, bestU, commence:arr[0].commence};
  }
}

/* ---------- analysis core ---------- */
function gamesFor(pid, opts={}){
  let g = S.logs[pid] || [];
  if(opts.without && opts.without.length){
    const team = S.players[pid]?.team;
    const sets = opts.without.map(t => new Set((S.logs[t]||[]).map(x=>x.game)));
    g = g.filter(x => sets.every(s=>!s.has(x.game)));
  }
  return g;
}
function hitRate(vals, line, side){ // side 1 over, -1 under
  if(!vals.length) return null;
  const h = vals.filter(v => side>0 ? v>line : v<line).length;
  return {h, n:vals.length, r:h/vals.length};
}
function analyze(pid, m, line, side=1, opts={}){
  const p = S.players[pid], f = MK[m].f, season = S.stats.season;
  const all = gamesFor(pid, opts);
  const vals = all.map(f);
  const cur = all.filter(g=>g.season===season);
  const st = S.slateTeam[p.team];
  const opp = opts.opp || st?.opp;
  const isHome = st ? st.home : null;
  const v = a => a.map(f);
  const last = n => vals.slice(-n);
  const res = {
    pid, m, line, side, n:all.length,
    L3:hitRate(last(3),line,side), L5:hitRate(last(5),line,side), L10:hitRate(last(10),line,side),
    SZN:hitRate(v(cur),line,side), H2H: opp ? hitRate(v(all.filter(g=>g.opp===opp)),line,side) : null,
    HOME:hitRate(v(all.filter(g=>g.home===1 && g.season>=season-1)),line,side),
    AWAY:hitRate(v(all.filter(g=>g.home===0 && g.season>=season-1)),line,side),
    avgL5:avg(last(5)), avgL10:avg(last(10)), avgSzn:avg(v(cur)), medL10:median(last(10)),
    opp, isHome, games:all,
  };
  res.VENUE = isHome==null ? null : (isHome ? res.HOME : res.AWAY);
  // streak vs line (most recent backwards)
  let s=0; for(let i=vals.length-1;i>=0;i--){ if(side>0?vals[i]>line:vals[i]<line) s++; else break; } res.streak=s;
  res.dvp = opp ? dvpOf(opp, m, p.pos) : null;
  return res;
}
/* ---------- matchup factor ----------
   Composite 0-1 (for the Over; 1-x for the Under), from:
     35% defense vs position, season (stat-specific: e.g. rec yds allowed to WRs)
     20% same, recent form (defense's last 4 games NFL / last 10 NHL)
     20% game environment: implied team total from total + moneyline/spread, plus game script
         (NFL: underdogs pass more, favorites run more; NHL: more defending -> more blocks/hits)
     10% pace (NFL plays per game, NHL shot volume) for both teams
     15% sport-specific: NFL QB - opponent sacks/game; NHL - opposing goalie save% (goals/points), shots allowed (goalies)
   NHL rest: own back-to-back -0.08, opponent back-to-back +0.06.  Grade: A >=.68, B >=.57, C >=.43, D >=.32, else F. */
const PASSM = new Set(['pass_yds','pass_tds','completions','pass_att','ints','rec_yds','receptions','targets']);
const RUSHM = new Set(['rush_yds','rush_att']);
const LEAGUE_TT = {nfl:22.5, nhl:3.1};
const clamp01 = x => Math.max(0, Math.min(1, x));
function gameEnv(team){
  const st=S.slateTeam[team]; if(!st) return null; const g=st.g; let total=null, pw=null, src='';
  const sp=splitOf(g);
  if(sp?.markets?.total?.[0]) { const t=parseFloat(String(sp.markets.total[0].side).replace(/[^0-9.]/g,'')); if(t) { total=t; src='DraftKings'; } }
  if(sp?.markets?.moneyline?.length===2){ let [h,a]=sp.markets.moneyline; if(String(a.side).toUpperCase().startsWith(g.home)) [h,a]=[a,h];
    const nv=noVig(h.odds,a.odds); if(nv) pw = st.home ? nv.o : nv.u; }
  let tt=null;
  if(total==null && g.total){ total=g.total; src='nflverse'; }
  if(total==null) return null;
  if(S.SPORT==='nfl' && g.spread!=null){ const m = st.home ? g.spread : -g.spread; tt = total/2 + m/2; if(pw==null) pw = 1/(1+Math.exp(-m/6)); }
  if(pw==null) pw=.5;
  if(tt==null) tt = total*(.5 + (pw-.5)*.55);
  return {total, pw, tt:r1(tt), oppT:r1(total-tt), src};
}
function buildMatchupExtras(){
  // recent DvP: each defense's last K games
  const season=S.stats.season, K = S.SPORT==='nhl'?10:4;
  const last={}; for(const g of [...S.games.games].filter(g=>g.season===season && g.hs!=null).sort((a,b)=>a.ko<b.ko?1:-1)){
    for(const t of [g.home,g.away]){ const a=(last[t] ??= new Set()); if(a.size<K) a.add(g.id); } }
  const agg={}, plays={}, allowed={};
  for(const [pid, rows] of Object.entries(S.logs)){
    const p=S.players[pid]; if(!p) continue; const pos=p.pos==='FB'?'RB':p.pos;
    for(const g of rows){ if(g.season!==season) continue;
      const pl = S.SPORT==='nhl' ? (pos==='G'?0:(g.sog||0)) : ((g.attempts||0)+(g.carries||0));
      ((plays[g.team] ??= {})[g.game] = (plays[g.team][g.game]||0)+pl);
      ((allowed[g.opp] ??= {})[g.game] = (allowed[g.opp][g.game]||0)+pl);
      if(S.SPORT==='nfl' && pos==='QB'){ ((S._sacks ??= {})[g.opp] ??= {s:0,gm:new Set()}); S._sacks[g.opp].s+=g.sacks_suffered||0; S._sacks[g.opp].gm.add(g.game); }
      if(!last[g.opp]?.has(g.game)) continue;
      const a=((agg[g.opp] ??= {})[pos] ??= {s:{}});
      for(const m of Object.keys(MK)){ a.s[m]=(a.s[m]||0)+MK[m].f(g); }
    }
  }
  S.dvpR={};
  for(const pos of S.POS_LIST){ S.dvpR[pos]={};
    for(const m of Object.keys(MK)){ const rows=Object.keys(last).map(t=>({t, v:(agg[t]?.[pos]?.s[m]||0)/(last[t].size||1)})); rows.sort((x,y)=>x.v-y.v);
      rows.forEach((r,i)=>{ (S.dvpR[pos][r.t] ??= {})[m]={v:r1(r.v), rank:i+1}; }); } }
  const avgOf=o=>{ const v=Object.values(o||{}); return v.length? v.reduce((a,b)=>a+b,0)/v.length : null; };
  S.pace={}; for(const t of Object.keys(plays)) S.pace[t]={off:avgOf(plays[t]), def:avgOf(allowed[t])};
  const vals=Object.values(S.pace).flatMap(x=>[x.off,x.def]).filter(x=>x!=null); S.paceMu=avg(vals); S.paceSd=Math.sqrt(avg(vals.map(v=>(v-S.paceMu)**2)))||1;
  if(S._sacks){ S.sackPg={}; for(const [t,x] of Object.entries(S._sacks)) S.sackPg[t]=x.s/(x.gm.size||1); const sv=Object.values(S.sackPg); S.sackMu=avg(sv); S.sackSd=Math.sqrt(avg(sv.map(v=>(v-S.sackMu)**2)))||1; }
}
const _mu={};
function matchup(a){
  const k=a.pid+'|'+a.m+'|'+a.side+'|'+a.opp; if(_mu[k]) return _mu[k];
  const p=S.players[a.pid]; if(!S.pace) buildMatchupExtras();
  const pos=dvpPos(a.m,p.pos), comps=[];
  const add=(label, part, w, txt)=>{ if(part==null||isNaN(part)) return; comps.push({label, part:clamp01(part), w, txt}); };
  if(a.dvp) add('Defense vs '+pos+' (season)', (a.dvp.rank-1)/31, .35, `${a.opp} allows ${a.dvp.v} ${MK[a.m].label.toLowerCase()}/g, rank ${a.dvp.rank}/32`);
  const dr = a.opp ? S.dvpR?.[pos]?.[a.opp]?.[a.m] : null;
  if(dr) add('Defense vs '+pos+' (recent)', (dr.rank-1)/31, .20, `last ${S.SPORT==='nhl'?10:4}: ${dr.v}/g, rank ${dr.rank}/32`);
  const env=gameEnv(p.team), avgT=LEAGUE_TT[S.SPORT];
  if(env){ let part, txt;
    if(S.SPORT==='nhl' && (a.m==='blk'||a.m==='hits'||p.pos==='G')){ part=.5+(env.oppT-avgT)/(avgT*1.0); txt=`opponent implied ${env.oppT} goals (total ${env.total})`; }
    else { part=.5+(env.tt-avgT)/(avgT*(S.SPORT==='nhl'?1.0:.62)); txt=`implied team total ${env.tt} (game total ${env.total}${env.pw!=null?`, win prob ${pct(env.pw)}`:''})`;
      if(S.SPORT==='nfl'){ if(PASSM.has(a.m)){ part+=(.5-env.pw)*.5; if(env.pw<.42) txt+=' · underdog script: more passing'; }
        if(RUSHM.has(a.m)){ part+=(env.pw-.5)*.6; if(env.pw>.58) txt+=' · favorite script: more running'; } } }
    add('Game environment', part, .20, txt+(env.src?` [${env.src}]`:'')); }
  const st=S.slateTeam[p.team];
  if(st && S.pace[p.team] && S.pace[a.opp]){ let v, txt;
    if(p.pos==='G'){ v=(S.pace[a.opp].off + S.pace[p.team].def)/2; txt=`${a.opp} shots for + ${p.team} shots allowed ≈ ${r1(v)}/g`; }
    else { v=(S.pace[p.team].off + S.pace[a.opp].def)/2; txt = S.SPORT==='nhl' ? `${p.team} shots + ${a.opp} shots allowed ≈ ${r1(v)}/g` : `${p.team} plays + ${a.opp} plays allowed ≈ ${r1(v)}/g`; }
    add('Pace / volume', .5+(v-S.paceMu)/(4*S.paceSd), .10, txt); }
  if(S.SPORT==='nfl' && p.pos==='QB' && S.sackPg?.[a.opp]!=null && PASSM.has(a.m)) add('Pass rush', .5-(S.sackPg[a.opp]-S.sackMu)/(4*S.sackSd), .15, `${a.opp} ${r1(S.sackPg[a.opp])} sacks/g`);
  const sp = S.matchSpecial ? S.matchSpecial(a,p) : null; if(sp) add(sp.label, sp.part, .15, sp.txt);
  let tw=0, t=0; for(const c of comps){ tw+=c.w; t+=c.w*c.part; }
  let part = tw ? t/tw : .5, adjTxt=[];
  const rest = S.matchRest ? S.matchRest(a,p) : null; if(rest){ part+=rest.adj; adjTxt.push(rest.txt); }
  part=clamp01(part); if(a.side<0) part=1-part;
  const grade = part>=.68?'A':part>=.57?'B':part>=.43?'C':part>=.32?'D':'F';
  return (_mu[k]={part, grade, pts:r1(W.MATCH*(part-.5)*100), comps, rest:adjTxt});
}

/* Transparent score (0-100):
   25% L10 hit rate + 20% L5 + 15% season + 10% H2H (season if <2 H2H games)
   + 15% cushion (avg of last 10 vs line, scaled) + 15% matchup (opponent's rank allowing this stat to this position). */
const W = {L10:.20, L5:.16, SZN:.12, H2H:.07, EDGE:.13, MATCH:.22, CAT:.10};
/* Category base rate (market x side): published prior blended with our own graded results.
   rate = (prior*N0 + hits) / (N0 + hits + misses); factor = 0.5 + (rate-0.5)*5, so a 54% category is worth ~+2 pts. */
const CAT_N0 = 200;
const CAT_PRIOR = { // under-hit share
  nfl:{pass_yds:{u:.494,src:'PropSims, FanDuel 2025 (n=530)'}, completions:{u:.538,src:'PropSims, FanDuel 2025 (n=301)'}, pass_tds:{u:.517,src:'PropSims, FanDuel 2025 (n=528)'},
       rush_yds:{u:.523,src:'PropSims, FanDuel 2025 (n=1,369)'}, rec_yds:{u:.534,src:'PropSims, FanDuel 2025 (n=2,747)'}, receptions:{u:.552,src:'PropSims, FanDuel 2025 (n=2,729)'}},
  nhl:{sog:{u:.528,src:'Fourth & Value, 2026-27 to date (n=3,526)'}},
};
function catRate(m, side){
  const pr=CAT_PRIOR[S.SPORT]?.[m]; if(!pr) return null; // yes/no & 0.5-line markets: the price carries it, no factor
  const c=S.cats?.cats?.[m]?.[side>0?'over':'under']||[0,0,0]; const h=c[0], mi=c[1];
  const p0 = side>0 ? 1-pr.u : pr.u;
  return {rate:(p0*CAT_N0+h)/(CAT_N0+h+mi), prior:p0, h, n:h+mi, src:pr.src};
}
function score(a){
  const hr = k => a[k]?.r ?? null;
  const szn = hr('SZN') ?? hr('L10') ?? .5;
  const h2h = (a.H2H && a.H2H.n>=2) ? a.H2H.r : szn;
  const scale = Math.max(Math.abs(a.line)*0.3, MK[a.m].fixed ? 0.6 : 1.5);
  const edgeRaw = a.m==='anytime_td' ? ((a.L10?.r ?? .5) - .5) : a.side*((a.avgL10 ?? a.line) - a.line)/scale;
  const edge = Math.max(0, Math.min(1, .5 + edgeRaw/2));
  const mu = a.pid ? matchup(a) : null, match = mu ? mu.part : .5;
  const cr = catRate(a.m, a.side), cat = cr ? Math.max(0, Math.min(1, .5 + (cr.rate-.5)*5)) : .5;
  const parts = {L10:hr('L10')??.5, L5:hr('L5')??.5, SZN:szn, H2H:h2h, EDGE:edge, MATCH:match, CAT:cat};
  let t=0; for(const k in W) t+=W[k]*parts[k];
  const ki = a.pid ? keyInj(a.pid) : null, adj = ki ? r1(ki.pts * (a.side>0?1:-1) + ki.self) : 0;
  return {score:Math.max(0,Math.min(100,Math.round(t*100+adj))), base:Math.round(t*100), parts, inj:adj, mu};
}
function reasons(a, p){
  const M = MK[a.m], side = a.side>0?'Over':'Under', out=[];
  const f = x => x ? `${x.h}/${x.n} (${pct(x.r)})` : '–';
  if(a.m==='anytime_td') out.push(`Scored in ${f(a.L10)} of last ${a.L10?.n||0} games, ${f(a.SZN)} this season`);
  else out.push(`${side} ${a.line} hit in ${f(a.L10)} of last ${a.L10?.n||0}; last 5: ${f(a.L5)}; season: ${f(a.SZN)}`);
  if(a.avgL10!=null && a.m!=='anytime_td'){ const d=a.avgL10-a.line; out.push(`Averaging ${r1(a.avgL10)} over last 10 (${d>=0?'+':''}${r1(d)} vs line), ${a.avgSzn!=null?r1(a.avgSzn)+' this season':''}`); }
  if(a.pid){ const mu=matchup(a); if(mu.comps.length) out.push(`🛡 Matchup ${mu.grade} (${mu.pts>=0?'+':''}${mu.pts} pts): ${mu.comps.map(c=>c.txt).concat(mu.rest).join('; ')}`); }
  if(a.H2H && a.H2H.n) out.push(`vs ${a.opp} since ${S.stats.season-(S.SPORT==='nhl'?1:2)}: ${f(a.H2H)}`);
  if(a.VENUE && a.VENUE.n>=3) out.push(`${a.isHome?'Home':'Away'} games (2 seasons): ${f(a.VENUE)}`);
  { const k=keyInj(a.pid); if(k.self) out.push(`🩹 He is listed ${k.selfSt}: ${k.self} pts`); if(k.pts){ const adj=k.pts*(a.side>0?1:-1); const sg=a.side>0?1:-1; out.push(`🩹 Injuries ${adj>0?'+':''}${r1(adj)} pts: ${k.notes.map(n=>`${n.t} ${n.v*sg>0?'+':''}${r1(n.v*sg)}`).join('; ')}`); } }
  { const cr=catRate(a.m,a.side); if(cr) out.push(`📊 ${MK[a.m].label} ${a.side>0?'Overs':'Unders'} hit ${pct(cr.rate)} as a category (prior ${pct(cr.prior)}, ${cr.src}; our graded lines n=${cr.n})`); }
  if(a.streak>=3) out.push(a.m==='anytime_td'?`🔥 Scored in ${a.streak} straight games`:`🔥 ${a.streak}-game ${side.toLowerCase()} streak`);
  return out;
}
const ordinal = n => { const v=n%100; if(v>=11&&v<=13) return n+'th'; return n+({1:'st',2:'nd',3:'rd'}[n%10]||'th'); };


/* ---------- betting splits (DraftKings public page: game lines only) ---------- */
const splitOf = g => g ? S.splitBy[g.away+'@'+g.home] : null;
function splitsCard(g, compact){
  const sp=splitOf(g); if(!sp) return '';
  const mk=(lab,rows)=>!rows?'':`<div class="spm"><div class="small mut">${lab}</div>${rows.map(r=>{const gap=r.handle-r.bets;
    return `<div class="spr"><span class="sps">${esc(r.side)}${r.odds!=null?` <span class="mut">${fmtOdds(r.odds)}</span>`:''}</span><span class="spb" title="% of bets"><i style="width:${r.bets}%"></i><em>${r.bets}% bets</em></span><span class="spb h" title="% of money (handle)"><i style="width:${r.handle}%"></i><em>${r.handle}% $</em></span>${gap>=10?'<span class="pill g" title="Money share well above ticket share: bigger bets on this side">$ ≫ bets</span>':''}</div>`;}).join('')}</div>`;
  return `<div class="card splits${compact?' small':''}"><div class="row"><b>${g.away} @ ${g.home} · Betting splits</b><span class="sp"></span><span class="small mut">DraftKings · ${ago(S.splits.updated)}</span></div>
   ${mk('Spread',sp.markets.spread)}${mk('Total',sp.markets.total)}${mk('Moneyline',sp.markets.moneyline)}
   <p class="small mut" style="margin:6px 0 0">% of bets = tickets, % $ = share of money (handle), all DraftKings jurisdictions. Player-prop splits aren't published by any free source, so props show none.</p></div>`;
}
/* ---------- board ---------- */
function volume(pid){
  const season=S.stats.season, rows=(S.logs[pid]||[]).filter(g=>g.season===season);
  const n=rows.length||1; return {gp:rows.length, att:rows.reduce((s,g)=>s+g.attempts,0)/n, car:rows.reduce((s,g)=>s+g.carries,0)/n, tgt:rows.reduce((s,g)=>s+g.targets,0)/n};
}
function teamLastGames(team, k=2){
  const season=S.stats.season;
  return S.games.games.filter(g=>g.season===season && g.hs!=null && (g.home===team||g.away===team)).sort((a,b)=>a.ko<b.ko?1:-1).slice(0,k).map(g=>g.id);
}
function modelLine(pid, m){
  if(MK[m].fixed) return MK[m].fixed;
  const vals=(S.logs[pid]||[]).slice(-10).map(MK[m].f); if(!vals.length) return null;
  // pick the x.5 line closest to a 50/50 split over the last 10 games (tie -> nearest the average)
  const md=median(vals), mu=avg(vals); let best=null;
  for(let c=Math.max(0.5,Math.floor(md)-2.5); c<=Math.floor(md)+2.5; c+=1){
    const o=vals.filter(v=>v>c).length/vals.length, d=Math.abs(o-.5)+Math.abs(c-mu)/1000;
    if(!best||d<best.d) best={c,d};
  }
  return best.c;
}
function lineFor(pid, m){
  const b=S.lines[pid+'|'+m];
  if(b) return {line:b.line, src:'book', b};
  const l=modelLine(pid,m); return l==null?null:{line:l, src:'model'};
}
function buildBoard(){
  const out=[], season=S.stats.season, hasBook=Object.keys(S.lines).length>0;
  const lastG = {}; for(const t of Object.keys(S.slateTeam)) lastG[t]=new Set(teamLastGames(t));
  for(const [pid,p] of Object.entries(S.players)){
    const st=S.slateTeam[p.team]; if(!st) continue;
    const vol=volume(pid); if(vol.gp<2) continue;
    const recent=(S.logs[pid]||[]).some(g=>lastG[p.team].has(g.game));
    const inj=injuryOf(p);
    for(const m of BOARD_MK){
      if(!MK[m].pos.includes(p.pos==='FB'?'RB':p.pos)) continue;
      const book=S.lines[pid+'|'+m];
      if(!book && (!VOL[m](vol) || !recent)) continue;
      const L=lineFor(pid,m); if(!L) continue;
      const sides = m==='anytime_td' ? [1] : [1,-1];
      const an = sides.map(sd=>{ const a=analyze(pid,m,L.line,sd); const sc=score(a); return {a,sc}; });
      const best = an.sort((x,y)=>y.sc.score-x.sc.score)[0];
      out.push({pid,p,m,line:L.line,src:L.src,book:L.b||null,inj,recent,g:st.g,
        over: an.find(x=>x.a.side>0)||best, under: an.find(x=>x.a.side<0)||null, best});
    }
  }
  S.board=out; S.hasBook=hasBook;
}

/* ---------- favorites & slip ---------- */
const keyOf = x => `${x.pid}|${x.m}|${x.side}`;
function isFav(pid,m,side){ return FAV.some(f=>f.pid===pid&&f.m===m&&f.side===side); }
function toggleFav(pid,m,line,side){
  const i=FAV.findIndex(f=>f.pid===pid&&f.m===m&&f.side===side);
  if(i>=0) FAV.splice(i,1); else FAV.push({pid,m,line,side,at:Date.now()});
  LS.set('fav',FAV); toast(i>=0?'Removed from watchlist':'Added to watchlist'); return i<0;
}
function addSlip(pid,m,line,side){
  SLIP=SLIP.filter(s=>!(s.pid===pid&&s.m===m)); SLIP.push({pid,m,line,side});
  LS.set('slip',SLIP); updSlipCount(); toast(`Added ${S.players[pid]?.name} ${side>0?'Over':'Under'} ${line}`);
}
function updSlipCount(){ $$('[data-slipcount]').forEach(e=>e.textContent=SLIP.length||''); }

/* ---------- components ---------- */
function hrChips(a, keys=['L3','L5','L10','SZN','H2H','VENUE']){
  const lab={L3:'L3',L5:'L5',L10:'L10',SZN:'2026',H2H:'H2H',VENUE:a.isHome?'Home':'Away',HOME:'Home',AWAY:'Away'};
  lab.SZN = String(S.stats.season);
  return `<div class="chips">${keys.map(k=>{const x=a[k]; return `<span class="chip ${cls(x?.r)}" title="${x?x.h+'/'+x.n:'no games'}">${lab[k]}<b>${x?pct(x.r):'–'}</b></span>`;}).join('')}</div>`;
}
function dvpPill(a,p){
  const mu=a.pid?matchup(a):null; const gp = mu&&mu.comps.length ? `<span class="pill ${'AB'.includes(mu.grade)?'g':mu.grade==='C'?'a':'r'}" title="Matchup grade (${mu.pts>=0?'+':''}${mu.pts} pts)">Matchup ${mu.grade}</span> ` : '';
  if(!a.dvp) return gp;
  const r=a.dvp.rank, t=a.side>0?r:33-r, c=t>=22?'g':t<=10?'r':'a';
  return gp+`<span class="pill ${c}" title="Rank 32 = allows the most">${a.opp} ${ordinal(r)}/32 vs ${dvpPos(a.m,p.pos)}</span>`;
}
function injPill(inj){ if(!inj || /^active/i.test(inj.status||'')) return ''; const c=BAD_STATUS.test(inj.status)?'r':'a'; return `<span class="pill ${c}" title="${esc(inj.detail)}">${esc(inj.status)}</span>`; }
function priceStr(row, side){
  const b=row.book; if(!b) return `<span class="pill b" title="No sportsbook line loaded; line = median of last 10 games">model line</span>`;
  const x = side>0?b.bestO:b.bestU; return x?`<span class="pill">${fmtOdds(side>0?x.over:x.under)} ${esc(x.book)}</span>`:'';
}
function propCard(row, side, rank){
  const a = side>0?row.over.a:row.under.a, sc=score(a), p=row.p, M=MK[row.m];
  const sideTxt = row.m==='anytime_td' ? 'YES' : side>0?'OVER':'UNDER';
  const fav = isFav(row.pid,row.m,side);
  return `<div class="card pick" data-go="#/player/${row.pid}?m=${row.m}&line=${row.line}&side=${side}" tabindex="0" role="link" aria-label="Open ${esc(p.name)} stats">
    ${rank?`<div class="rank">#${rank}</div>`:''}
    <div class="row">${headshot(p)}<div class="sp"><a class="pname" href="#/player/${row.pid}?m=${row.m}">${esc(p.name)}</a>${warnIcon(row.pid)}
      <div class="small mut">${p.pos} · ${p.team} ${a.isHome?'vs':'@'} ${a.opp} · ${fmtTime(row.g.ko)}</div></div>
      <button class="star ${fav?'on':''}" data-fav="${row.pid}|${row.m}|${row.line}|${side}" title="Watchlist">★</button></div>
    <div class="row" style="margin-top:10px"><span class="side ${side>0?'o':'u'}">${sideTxt}</span><b class="big" style="font-size:18px">${row.m==='anytime_td'?'':row.line} ${M.label}</b><span class="sp"></span>${priceStr(row,side)}</div>
    <div style="margin-top:10px">${hrChips(a)}</div>
    <div class="row small" style="margin-top:8px;flex-wrap:wrap;gap:6px">${dvpPill(a,p)} ${injPill(row.inj)} <span class="pill">L10 avg ${a.avgL10!=null?r1(a.avgL10):'–'}</span>${a.streak>=3?`<span class="pill g">🔥 ${a.streak} straight</span>`:''}</div>
    ${kiCompact(row.pid)}
    <div class="row" style="margin-top:10px"><div class="sp"><div class="small mut">PropScout score</div><div class="scorebar"><i style="width:${sc.score}%"></i></div></div><div class="score">${sc.score}</div>
      <button class="btn" data-slip="${row.pid}|${row.m}|${row.line}|${side}">+ Slip</button></div>
  </div>`;
}
function bindCommon(root){
  $$('[data-fav]',root).forEach(b=>b.onclick=e=>{e.preventDefault(); const [pid,m,l,s]=b.dataset.fav.split('|'); const on=toggleFav(pid,m,+l,+s); b.classList.toggle('on',on); if(location.hash.startsWith('#/favorites')) route();});
  $$('[data-slip]',root).forEach(b=>b.onclick=e=>{e.preventDefault(); const [pid,m,l,s]=b.dataset.slip.split('|'); addSlip(pid,m,+l,+s);});
}

/* ---------- views ---------- */
function banner(){
  const el=$('#banner'), st=S.status||{}; let h='';
  const age = st.updated ? (Date.now()-new Date(st.updated))/3600000 : 99;
  if(age>14) h+=`<div class="banner err">Data is ${Math.round(age)}h old — the scheduled refresh may be failing. See the Data page.</div>`;
  if(!S.hasBook && !sessionStorage.ps_nob) h+=`<div class="banner">No sportsbook lines loaded yet${st.odds?.has_key?' (odds fetch for upcoming games happens ~30h before kickoff)':' — add the free <b>ODDS_API_KEY</b> secret to load real lines'}. Until then, props use <b>model lines</b> (the .5 line that splits the last 10 games ~50/50), so L10 hit rates near 50% are expected and matchup, trend and season form drive the ranking. <button class="btn" style="margin-left:6px" onclick="this.parentNode.remove();sessionStorage.ps_nob=1">Dismiss</button></div>`;
  el.innerHTML=h;
}
function viewHome(){
  const now=Date.now();
  const pool=[];
  for(const row of S.board){
    if(new Date(row.g.ko).getTime() < now) continue;           // game already started
    if(row.inj && BAD_STATUS.test(row.inj.status)) continue;    // out/doubtful
    if(!row.recent) continue;
    for(const sd of (row.m==='anytime_td'?[1]:[1,-1])){
      const a = sd>0?row.over?.a:row.under?.a; if(!a) continue;
      if((a.SZN?.n||0)<3) continue;
      const sc=score(a); pool.push({row, side:sd, a, sc:sc.score});
    }
  }
  pool.sort((x,y)=>y.sc-x.sc);
  // diversify: max 2 props per player
  const f=HS.f, filt=pool.filter(x=> f==='all' || (f==='over'&&x.side>0&&x.row.m!=='anytime_td') || (f==='under'&&x.side<0) || x.row.m===f);
  // diversify: max 2 props per player, max 4 anytime TDs in the mixed view, book lines first when available
  if(S.hasBook) filt.sort((x,y)=>(y.row.src==='book')-(x.row.src==='book') || y.sc-x.sc);
  const per={}, perM={}, top=[]; for(const x of filt){ if((per[x.row.pid]||0)>=2) continue; if(f==='all'&&x.row.m==='anytime_td'&&(perM.atd||0)>=4) continue;
    per[x.row.pid]=(per[x.row.pid]||0)+1; if(x.row.m==='anytime_td') perM.atd=(perM.atd||0)+1; top.push(x); if(top.length>=HS.n) break; }
  const slateTxt = S.slate.length ? `${S.slateLabel?S.slateLabel():'Week '+S.slate[0].week} · ${S.slate.length} games · next ${S.SPORT==='nhl'?'puck drop':'kickoff'} ${fmtTime(S.slate.find(g=>new Date(g.ko)>now)?.ko)}` : 'No upcoming games found';
  return `<h1>Today's Top Picks</h1>
  <p class="sub">${slateTxt}. Ranked by the PropScout score — every input is shown so you can judge it yourself.</p>
  <details class="card small" style="margin-bottom:14px"><summary style="cursor:pointer;font-weight:700">How the score works</summary>
   <p class="mut">Score (0–100) = 20% last-10 hit rate + 16% last-5 + 12% season + 7% head-to-head vs this opponent (season rate if fewer than 2 meetings) + 13% cushion (last-10 average vs the line) + 22% matchup (graded A–F: defense vs position season 35% and recent 20%, game environment from implied team total & game script 20%, pace 10%, pass rush / opposing goalie 15%, NHL rest) + 10% category base rate (how often this market's Overs or Unders hit: a published prior blended with our own graded lines, see <a href="#/categories" style="color:var(--green)">Category hit rates</a>). Then a <b>key-injury adjustment</b> (capped ±12): +4 per starting WR teammate out (WR/TE), +6 when the other lead RB is out, −6 when his QB is out, −2 per starting OL out (RB/QB), +4 when the opponent's starting CB is out (WR), +2.5 for a starting LB/S out (TE); teammates/defenders listed Questionable count 40% and only fresh absences count; −6 if he himself is Questionable. It's listed in each pick's reasons, and ⚠️ next to a name shows the key injuries around him. Players listed Out/Doubtful/IR, players who missed their team's last two games, and games already started are excluded. Max two props per player.</p></details>
  ${slateStrip()}
  ${(S.splits.games||[]).length?`<details class="card small" style="margin-bottom:12px"><summary style="cursor:pointer;font-weight:700">📊 Betting splits (% bets / % money) for this week's games</summary><div class="grid g2" style="margin-top:10px">${S.slate.map(g=>splitsCard(g,true)).join('')}</div></details>`:''}
  <div class="tabs" id="htabs">${[['all','All'],['over','Overs'],['under','Unders'],...BOARD_MK.map(m=>[m,MK[m].label])].map(([k,l])=>`<button data-h="${k}" class="${HS.f===k?'on':''}">${l}</button>`).join('')}</div>
  ${top.length?`<div class="grid g2">${top.map((x,i)=>propWithWhy(x,i+1)).join('')}</div>`:`<div class="empty card">No picks available — the slate may be finished. Check back after the next data refresh.</div>`}
  ${top.length>=HS.n?`<div style="text-align:center;margin-top:14px"><button class="btn" id="hmore">Show more picks</button></div>`:''}
  <p class="small mut" style="margin-top:14px">See every prop on the <a href="#/board" style="color:var(--green)">Board</a>.</p>`;
}
const HS={f:'all',n:12};
function slateStrip(){
  const now=Date.now();
  return `<div class="slate">${S.slate.map(g=>{const live=new Date(g.ko).getTime()<now; const fav=g.spread==null?'':g.spread>0?`${g.home} -${g.spread}`:g.spread<0?`${g.away} ${g.spread}`:'PK';
    return `<a class="game ${live?'past':''}" href="#/board?game=${g.id}"><div class="row"><b>${g.away}</b><span class="mut">@</span><b>${g.home}</b></div><div class="small mut">${live?'Started':fmtTime(g.ko)}</div><div class="small">${fav}${g.total?` · O/U ${g.total}`:''}</div>${(()=>{const sp=splitOf(g)?.markets?.spread; if(!sp) return ''; const t=[...sp].sort((a,b)=>b.bets-a.bets)[0]; return `<div class="small mut">📊 ${esc(t.side.split(' ')[0])} ${t.bets}% bets · ${t.handle}% $</div>`;})()}</a>`;}).join('')}</div>`;
}
function bindHome(){
  bindCommon($('#app'));
  $$('#htabs button').forEach(b=>b.onclick=()=>{HS.f=b.dataset.h; HS.n=12; route();});
  const m=$('#hmore'); if(m) m.onclick=()=>{HS.n+=12; const y=scrollY; route(); scrollTo(0,y);};
}
function propWithWhy(x, rank){
  const card = propCard(x.row, x.side, rank);
  const why = reasons(x.a, x.row.p).map(r=>`<li>${esc(r)}</li>`).join('');
  return card.replace(/<\/div>\s*$/, `<ul class="why">${why}</ul></div>`);
}
const BS = LS.get('boardf', {m:'all',pos:'all',team:'all',game:'all',side:'best',win:'L10',min:0,dvp:'all',sort:'score',hideInj:true,bookOnly:false,q:''});
let BN=60;
function viewBoard(params){
  if(params?.get('game')){ BS.game=params.get('game'); BS.team='all'; }
  BN=60;
  const teams=[...new Set(S.board.map(r=>r.p.team))].sort();
  const sel=(id,opts,v)=>`<select id="${id}">${opts.map(([k,l])=>`<option value="${k}" ${String(v)===String(k)?'selected':''}>${l}</option>`).join('')}</select>`;
  return `<h1>Props Board</h1><p class="sub">${S.board.length} props on this week's slate${S.hasBook?'':' (model lines)'}.</p>
  <button class="btn ftoggle" onclick="document.querySelector('.filters').classList.toggle('open')">⚙ Filters & sort</button>
  <div class="filters">
    <input id="bq" type="search" placeholder="Filter player" value="${esc(BS.q)}" style="width:150px">
    ${sel('bm',[['all','All markets'],...BOARD_MK.map(m=>[m,MK[m].label])],BS.m)}
    ${sel('bpos',[['all','All pos'],...S.POS_LIST.map(x=>[x,x])],BS.pos)}
    ${sel('bgame',[['all','All games'],...S.slate.map(g=>[g.id,`${g.away} @ ${g.home}`])],BS.game)}
    ${sel('bteam',[['all','All teams'],...teams.map(t=>[t,t])],BS.team)}
    ${sel('bside',[['best','Best side'],['over','Over'],['under','Under']],BS.side)}
    ${sel('bwin',[['L3','Hit% L3'],['L5','Hit% L5'],['L10','Hit% L10'],['SZN','Hit% season'],['H2H','Hit% H2H'],['VENUE','Hit% home/away']],BS.win)}
    ${sel('bmin',[[0,'Any hit%'],[.5,'≥50%'],[.6,'≥60%'],[.7,'≥70%'],[.8,'≥80%'],[1,'100%']],BS.min)}
    ${sel('bdvp',[['all','Any matchup'],['soft','Soft D (rank 22-32)'],['mid','Neutral'],['tough','Tough D (1-10)']],BS.dvp)}
    ${sel('bsort',[['score','Sort: score'],['hit','Sort: hit% (window)'],['edge','Sort: avg vs line'],['dvp','Sort: matchup'],['time','Sort: kickoff']],BS.sort)}
    <label class="row small"><input type="checkbox" id="binj" ${BS.hideInj?'checked':''}> Hide Out/Doubtful</label>
    <label class="row small"><input type="checkbox" id="bbook" ${BS.bookOnly?'checked':''} ${S.hasBook?'':'disabled'}> Book lines only</label>
  </div>${BS.game!=='all'?splitsCard(S.slate.find(g=>g.id===BS.game)):''}<div id="boardlist"></div>`;
}
function renderBoardList(){
  const q=norm(BS.q);
  let rows=[];
  for(const r of S.board){
    if(BS.m!=='all'&&r.m!==BS.m) continue; if(BS.pos!=='all'&&r.p.pos!==BS.pos) continue;
    if(BS.team!=='all'&&r.p.team!==BS.team) continue; if(BS.game!=='all'&&r.g.id!==BS.game) continue;
    if(BS.hideInj && r.inj && BAD_STATUS.test(r.inj.status)) continue; if(BS.bookOnly && r.src!=='book') continue;
    if(q && !norm(r.p.name).includes(q)) continue;
    const side = BS.side==='over'?1:BS.side==='under'?-1:(r.best.a.side);
    if(side<0 && !r.under) continue;
    const a = side>0?r.over.a:r.under.a;
    const h = a[BS.win]?.r ?? -1; if(h < +BS.min) continue;
    if(BS.dvp!=='all'){ const k=a.dvp?.rank; if(!k) continue; const t = side>0?k:33-k; if(BS.dvp==='soft'&&t<22) continue; if(BS.dvp==='tough'&&t>10) continue; if(BS.dvp==='mid'&&(t<11||t>21)) continue; }
    rows.push({r,side,a,sc:score(a).score,h});
  }
  const edge=x=>x.a.side*((x.a.avgL10??x.a.line)-x.a.line)/Math.max(x.a.line,1);
  const srt={score:(x,y)=>y.sc-x.sc, hit:(x,y)=>y.h-x.h||y.sc-x.sc, edge:(x,y)=>edge(y)-edge(x), dvp:(x,y)=>((y.a.dvp?.rank||0)*y.side)-((x.a.dvp?.rank||0)*x.side), time:(x,y)=>x.r.g.ko<y.r.g.ko?-1:1}[BS.sort];
  rows.sort(srt);
  const total=rows.length; rows=rows.slice(0,BN);
  $('#boardlist').innerHTML = rows.length ? `<p class="small mut">${total} match${total===1?'':'es'}${total>BN?` · showing ${BN}`:''} <button class="btn" id="breset" style="margin-left:6px">Reset filters</button></p><div class="grid g3">${rows.map(x=>propCard(x.r,x.side)).join('')}</div>${total>BN?`<div style="text-align:center;margin-top:14px"><button class="btn" id="bmore">Show more (${total-BN} left)</button></div>`:''}` : `<div class="empty card">No props match these filters. <button class="btn" id="breset">Reset filters</button></div>`;
  const mo=$('#bmore'); if(mo) mo.onclick=()=>{BN+=60; renderBoardList();};
  $('#breset').onclick=()=>{Object.assign(BS,{m:'all',pos:'all',team:'all',game:'all',side:'best',win:'L10',min:0,dvp:'all',sort:'score',hideInj:true,bookOnly:false,q:''}); LS.set('boardf',BS); route();};
  bindCommon($('#boardlist'));
}
function bindBoard(){
  const map={bq:'q',bm:'m',bpos:'pos',bgame:'game',bteam:'team',bside:'side',bwin:'win',bmin:'min',bdvp:'dvp',bsort:'sort'};
  for(const [id,k] of Object.entries(map)){ const el=$('#'+id); el.oninput=el.onchange=()=>{BS[k]=el.value; LS.set('boardf',BS); renderBoardList();}; }
  $('#binj').onchange=e=>{BS.hideInj=e.target.checked; LS.set('boardf',BS); renderBoardList();};
  $('#bbook').onchange=e=>{BS.bookOnly=e.target.checked; LS.set('boardf',BS); renderBoardList();};
  renderBoardList();
}

/* ----- player page ----- */
const PS = {without:[], win:'20'};
function viewPlayer(pid, params){
  const p=S.players[pid]; if(!p) return `<div class="empty card">Player not found.</div>`;
  const pos=p.pos==='FB'?'RB':p.pos;
  const mks=Object.keys(MK).filter(m=>MK[m].pos.includes(pos));
  const m = params.get('m') && MK[params.get('m')] ? params.get('m') : mks[0];
  if(PS.pid!==pid){ PS.pid=pid; PS.without=[]; }
  PS.m=m;
  const L=lineFor(pid,m);
  PS.line = params.get('line')!=null ? +params.get('line') : (L?.line ?? 0.5);
  PS.side = +(params.get('side')||1);
  PS.src=L?.src;
  const inj=injuryOf(p), st=S.slateTeam[p.team];
  return `<div class="row" style="gap:14px;flex-wrap:wrap">${headshot(p).replace('class="hs"','class="hs lg"')}
    <div class="sp"><h1 style="margin:0">${esc(p.name)} ${warnIcon(pid)}</h1>
    <div class="mut">${p.pos} · ${p.team} ${st?`· Next: ${st.home?'vs':'@'} ${st.opp} ${fmtTime(st.g.ko)}`:'· No game on this week\'s slate'}</div>
    <div class="row small" style="margin-top:6px;gap:6px">${injPill(inj)}${inj?`<span class="mut">${esc(inj.detail)}</span>`:''}</div></div></div>
  <div class="tabs">${mks.map(k=>`<button data-m="${k}" class="${k===m?'on':''}">${MK[k].label}${S.lines[pid+'|'+k]?' •':''}</button>`).join('')}</div>
  <div class="card"><div class="row" style="flex-wrap:wrap;gap:12px">
    <div class="lineinp"><span class="mut small">LINE</span><input id="pline" type="number" step="0.5" value="${PS.line}">
      ${MK[m].alt.map(d=>`<button class="btn" data-alt="${d}">${d>0?'+':''}${d}</button>`).join('')}
      <button class="btn" data-alt="reset" title="Back to ${PS.src==='book'?'consensus book':'model'} line">${PS.src==='book'?'Book':'Model'} ${L?.line??''}</button></div>
    <span class="sp"></span>
    <div class="seg" id="pside"><button data-s="1" class="${PS.side>0?'on':''}">Over</button>${m!=='anytime_td'?`<button data-s="-1" class="${PS.side<0?'on':''}">Under</button>`:''}</div>
    <button class="star" id="pfav">★</button><button class="btn pri" id="pslip">+ Slip</button>
  </div><div id="pbody"></div></div>
  <div id="pextra"></div>`;
}
function renderPlayer(){
  const {pid,m}=PS, p=S.players[pid], M=MK[m];
  const a=analyze(pid,m,PS.line,PS.side,{without:PS.without});
  const sc=score(a);
  const season=S.stats.season;
  const games = PS.win==='SZN' ? a.games.filter(g=>g.season===season) : PS.win==='H2H' ? a.games.filter(g=>g.opp===a.opp) : a.games.slice(-(+PS.win||20));
  $('#pfav').classList.toggle('on',isFav(pid,m,PS.side));
  // chart
  const chart = barChart(games, M.f, PS.line);
  $('#pbody').innerHTML = `
   ${PS.without.length?`<div class="banner" style="margin:10px 0">Showing only games without: ${PS.without.map(t=>esc(S.players[t]?.name)).join(', ')} (${a.n} games)</div>`:''}
   <div style="margin:12px 0">${hrChips(a,['L3','L5','L10','SZN','H2H','HOME','AWAY'])}</div>
   <div class="kv">
     <div><span>L5 avg</span><b>${a.avgL5!=null?r1(a.avgL5):'–'}</b></div>
     <div><span>L10 avg</span><b>${a.avgL10!=null?r1(a.avgL10):'–'}</b></div>
     <div><span>${S.stats.season} avg</span><b>${a.avgSzn!=null?r1(a.avgSzn):'–'}</b></div>
     <div><span>L10 median</span><b>${a.medL10!=null?r1(a.medL10):'–'}</b></div>
     <div><span>Streak</span><b>${a.streak}</b></div>
     <div><span>Score</span><b>${sc.score}</b></div>
   </div>
   <details class="card small" style="margin:10px 0" open><summary style="cursor:pointer;font-weight:700">Score breakdown: ${sc.base} base ${sc.inj>=0?'+':''}${sc.inj} injuries = ${sc.score}</summary>
    <table style="margin-top:6px"><tr><th>Factor</th><th>Value</th><th>Weight</th><th>Points</th></tr>
    ${[['L10 hit rate','L10'],['L5 hit rate','L5'],['Season hit rate','SZN'],['vs opponent','H2H'],['Cushion vs line','EDGE'],['Matchup '+(sc.mu?sc.mu.grade:''),'MATCH'],['Category '+(PS.side>0?'Over':'Under')+' rate','CAT']].map(([l,k])=>`<tr><td>${l}</td><td>${pct(sc.parts[k])}</td><td>${Math.round(W[k]*100)}%</td><td>${r1(W[k]*sc.parts[k]*100)}</td></tr>`).join('')}
    ${sc.mu&&sc.mu.comps.length?`<tr><td colspan="4" class="small mut" style="white-space:normal;text-align:left">Matchup parts: ${sc.mu.comps.map(c=>`${esc(c.label)} ${Math.round(c.part*100)} (${esc(c.txt)})`).concat(sc.mu.rest.map(esc)).join(' · ')} → ${sc.mu.pts>=0?'+':''}${sc.mu.pts} pts vs a neutral matchup</td></tr>`:''}
    <tr><td><b>Key injuries</b></td><td colspan="2" class="mut" style="white-space:normal">${(()=>{const k=keyInj(pid); const sg=PS.side>0?1:-1; const n=k.notes.map(x=>`${esc(x.t)} ${x.v*sg>0?'+':''}${r1(x.v*sg)}`); if(k.self) n.push(`he is ${esc(k.selfSt)} ${k.self}`); return n.join('<br>')||'none affecting volume or coverage';})()}</td><td><b style="color:${sc.inj>0?'var(--green)':sc.inj<0?'var(--red)':'inherit'}">${sc.inj>0?'+':''}${sc.inj}</b></td></tr></table></details>
   <div class="row" style="flex-wrap:wrap"><h2 class="sp">${PS.win==='SZN'?season+' season':PS.win==='H2H'?'vs '+(a.opp||'opponent'):'Last '+games.length+' games'} vs ${PS.line}</h2>
   <div class="seg" id="pwin">${[['5','L5'],['10','L10'],['20','L20'],['SZN','Season'],['H2H','H2H']].map(([k,l])=>`<button data-w="${k}" class="${String(PS.win)===k?'on':''}">${l}</button>`).join('')}</div></div>${chart}
   <div class="legend"><span><b style="color:var(--green)">■</b> ${PS.side>0?'over':'under'} hit</span><span><b style="color:var(--red)">■</b> miss</span><span>- - line</span></div>`;
  // extra panels
  $('#pextra').innerHTML = [gameLog(a,p), kiPanel(pid), matchupPanel(a,p), S.slateTeam[p.team]?`<h2>Game betting splits</h2>${splitsCard(S.slateTeam[p.team].g)||'<div class="card small mut">No splits posted for this game yet.</div>'}`:'', booksPanel(pid,m), teammatePanel(pid), splitsPanel(a,p)].join('');
  bindPlayerExtra();
}
function barChart(games, f, line){
  if(!games.length) return `<div class="empty">No games.</div>`;
  const vals=games.map(f), max=Math.max(line*1.3, ...vals, 1);
  const W=760,H=220,pad=28,bw=(W-pad*2)/games.length;
  const y=v=>H-pad-(v/max)*(H-pad*2);
  const bars=games.map((g,i)=>{const v=vals[i], hit=PS.side>0?v>line:v<line, x=pad+i*bw+bw*.12, w=bw*.76, yy=y(v);
    return `<g><rect x="${x}" y="${yy}" width="${w}" height="${Math.max(H-pad-yy,1)}" rx="3" fill="${v===line?'#64748b':hit?'#22c55e':'#ef4444'}"><title>${g.season} W${g.week} ${g.home===1?'vs':'@'} ${g.opp}: ${v}</title></rect>
      <text x="${x+w/2}" y="${yy-4}" fill="#e6edf5" font-size="11" text-anchor="middle" font-weight="700">${v}</text>
      <text x="${x+w/2}" y="${H-pad+13}" fill="#8a9bb0" font-size="9.5" text-anchor="middle">${g.home===1?'':'@'}${g.opp}</text>
      <text x="${x+w/2}" y="${H-pad+24}" fill="#5b6b7f" font-size="8.5" text-anchor="middle">W${g.week}${g.season!==S.stats.season?"'"+String(g.season).slice(2):''}</text></g>`;}).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H+8}" role="img" aria-label="Recent games chart">${bars}
    <line x1="${pad}" x2="${W-pad}" y1="${y(line)}" y2="${y(line)}" stroke="#f59e0b" stroke-dasharray="6 4" stroke-width="2"/>
    <rect x="0" y="${y(line)-9}" width="${pad+8}" height="18" rx="4" fill="#f59e0b"/><text x="${(pad+8)/2}" y="${y(line)+4}" fill="#0b0f14" font-size="11" text-anchor="middle" font-weight="900">${line}</text></svg>`;
}
function matchupPanel(a,p){
  if(!a.opp) return '';
  const pos=dvpPos(a.m,p.pos), d=S.dvp[pos]?.[a.opp]||{};
  const ms=Object.keys(MK).filter(k=>MK[k].pos.includes(p.pos==='FB'?'RB':p.pos)&&d[k]);
  const oi=(S.injByTeam[a.opp]||[]).filter(i=>i.status && !/^active/i.test(i.status));
  const ti=(S.injByTeam[p.team]||[]).filter(i=>i.status && !/^active/i.test(i.status));
  const list = arr => arr.length? arr.slice(0,14).map(i=>`<div class="row small" style="padding:3px 0"><span class="pill ${BAD_STATUS.test(i.status)?'r':'a'}">${esc(i.status)}</span><b>${esc(i.name)}</b><span class="mut">${esc(i.pos||'')}</span></div>`).join('') : '<div class="mut small">None listed</div>';
  return `<h2>Matchup: ${a.opp} defense vs ${pos}</h2><div class="grid g2">
   <div class="card"><table><tr><th>Stat allowed / game</th><th>Value</th><th>Rank</th></tr>
   ${ms.map(k=>{const x=d[k]; const c=x.rank>=22?'g':x.rank<=10?'r':'a'; return `<tr><td>${MK[k].label}</td><td>${x.v}</td><td><span class="pill ${c}">${ordinal(x.rank)}</span></td></tr>`;}).join('')}
   </table><p class="small mut">Rank 1 = allows the least (toughest), 32 = allows the most (softest). ${S.stats.season} season, ${d.gp||0} games.</p></div>
   <div class="card"><div class="small mut" style="margin-bottom:4px">${a.opp} injury report</div>${list(oi)}<div class="small mut" style="margin:10px 0 4px">${p.team} injury report</div>${list(ti)}</div></div>`;
}
const impP = o => o==null ? null : (o>0 ? 100/(o+100) : -o/(-o+100));
const fairAm = q => q==null||q<=0||q>=1 ? null : (q>=.5 ? Math.round(-100*q/(1-q)) : Math.round(100*(1-q)/q));
function noVig(o,u){ const a=impP(o), b=impP(u); if(a==null||b==null) return null; const t=a+b; return {o:a/t, u:b/t, vig:t-1}; }
function booksPanel(pid,m){
  const b=S.lines[pid+'|'+m];
  const h=S.hist[pid+'|'+m]||S.hist[norm(S.players[pid].name)+'|'+m]||[];
  let html=`<h2>Sportsbook odds</h2>`;
  if(!b){ html+=`<div class="card small mut">No sportsbook lines loaded for this prop${S.status?.odds?.has_key?'':' (add ODDS_API_KEY to enable)'}. Using model line ${modelLine(pid,m)} (median of last 10).</div>`; return html; }
  const yn = m==='anytime_td';
  // consensus no-vig at the main line (average of each book's de-vigged probability)
  const nv = b.books.filter(l=>l.line===b.line).map(l=>noVig(l.over,l.under)).filter(Boolean);
  const cO = nv.length ? avg(nv.map(x=>x.o)) : null;
  const bestAt = {}; for(const l of b.books){ const k=l.line; bestAt[k] ??= {o:null,u:null};
    if(l.over!=null && (bestAt[k].o==null || toDec(l.over)>toDec(bestAt[k].o))) bestAt[k].o=l.over;
    if(l.under!=null && (bestAt[k].u==null || toDec(l.under)>toDec(bestAt[k].u))) bestAt[k].u=l.under; }
  const lines=[...b.books].sort((x,y)=>(x.line!==b.line)-(y.line!==b.line) || x.line-y.line || x.book.localeCompare(y.book));
  const ev = (price, q) => price==null||q==null ? '' : (()=>{ const e=q*toDec(price)-1; return `<div class="small ${e>0?'evp':'mut'}">${e>0?'+':''}${(e*100).toFixed(1)}% EV</div>`; })();
  html+=`<div class="card small" style="margin-bottom:8px">${nv.length?`Consensus no-vig at <b>${b.line}</b> (${nv.length} book${nv.length>1?'s':''}): ${yn?'Yes':'Over'} <b>${pct(cO)}</b> (fair ${fmtOdds(fairAm(cO))})${yn?'':` · Under <b>${pct(1-cO)}</b> (fair ${fmtOdds(fairAm(1-cO))})`}. EV below is each price vs this consensus fair probability.`:`Books only posted one side${yn?' (Yes only, typical for anytime TD)':''}, so no-vig fair odds can't be computed — implied probability shown instead.`}</div>
  <div class="tbl"><table class="odds"><tr><th>Book</th><th>Line</th><th>${yn?'Yes':'Over'}</th><th>Impl.</th>${yn?'':'<th>Under</th><th>Impl.</th>'}<th class="hide-m">Hold</th><th>Fair ${yn?'Y':'O'}/${yn?'N':'U'}</th></tr>${lines.map(l=>{
    const v=noVig(l.over,l.under), bo=bestAt[l.line], qO = l.line===b.line? cO : (v?.o??null);
    const cell=(x,best,q)=>`<td class="${x!=null&&x===best?'best':''}">${fmtOdds(x)}${l.line===b.line&&!yn?ev(x,q):''}</td>`;
    return `<tr class="${l.line!==b.line?'altl':''}"><td>${esc(l.book)}${l.line!==b.line?' <span class="pill a">alt</span>':''}</td><td>${yn?'Yes':l.line}</td>
      ${cell(l.over,bo.o,cO)}<td class="mut">${pct(impP(l.over))}</td>${yn?'':`${cell(l.under,bo.u,cO!=null?1-cO:null)}<td class="mut">${pct(impP(l.under))}</td>`}
      <td class="hide-m mut">${v?(v.vig*100).toFixed(1)+'%':'–'}</td><td>${v?`${fmtOdds(fairAm(v.o))} / ${fmtOdds(fairAm(v.u))}`:'–'}</td></tr>`;}).join('')}</table></div>
  <p class="small mut">Green = best price at that line. Impl. = implied probability including the book's margin; Hold = the book's margin on this line; Fair = no-vig odds from that book's two prices.</p>`;
  // line movement
  if(h.length>=2){
    const byT={}; h.forEach(([t,bk,l])=>(byT[t]??=[]).push(l));
    const pts=Object.entries(byT).sort().map(([t,ls])=>[t,median(ls)]);
    html+=`<h2>Line movement</h2><div class="card">${pts.length>=2?lineChart(pts):'<span class="mut small">Only one snapshot so far.</span>'}<div class="small mut">${pts.map(([t,l])=>`${fmtDT(t)}: ${l}`).join(' → ')}</div></div>`;
  } else html+=`<p class="small mut">Line movement: only one snapshot so far (free tier fetches each game once).</p>`;
  return html;
}
function lineChart(pts){
  const W=600,H=120,p=20, vs=pts.map(x=>x[1]), mn=Math.min(...vs)-1, mx=Math.max(...vs)+1;
  const X=i=>p+i*(W-2*p)/Math.max(pts.length-1,1), Y=v=>H-p-(v-mn)/(mx-mn)*(H-2*p);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="${pts.map((x,i)=>X(i)+','+Y(x[1])).join(' ')}"/>${pts.map((x,i)=>`<circle cx="${X(i)}" cy="${Y(x[1])}" r="4" fill="#38bdf8"/><text x="${X(i)}" y="${Y(x[1])-8}" fill="#e6edf5" font-size="11" text-anchor="middle">${x[1]}</text>`).join('')}</svg>`;
}
function teammatePanel(pid){
  const p=S.players[pid], season=S.stats.season;
  // teammates this season with real volume
  const mates=Object.values(S.players).filter(t=>t.team===p.team && t.id!==pid && ['QB','RB','WR','TE'].includes(t.pos)).map(t=>{
    const v=volume(t.id); return {t, v, w:v.att*0.6+v.car+v.tgt*1.2, inj:injuryOf(t)}; }).filter(x=>x.v.gp>=2 && x.w>=4).sort((a,b)=>b.w-a.w).slice(0,10);
  if(!mates.length) return '';
  return `<h2>Teammate out filter</h2><div class="card"><p class="small mut" style="margin-top:0">Recalculate hit rates using only games where the selected teammate(s) did not record a stat (didn't play or had no touches). Uses ${season-2}–${season} games.</p>
   <div class="chips">${mates.map(x=>`<button class="btn ${PS.without.includes(x.t.id)?'on':''}" data-without="${x.t.id}">${esc(x.t.name)} <span class="mut">${x.t.pos}</span>${warnIcon(x.t.id)}${x.inj?` <span class="pill ${BAD_STATUS.test(x.inj.status)?'r':'a'}">${esc(x.inj.status)}</span>`:''}</button>`).join('')}</div></div>`;
}
function splitsPanel(a,p){
  const f=MK[a.m].f, s=S.stats.season, G=a.games;
  const row=(lab,arr)=>{const v=arr.map(f), h=hitRate(v,a.line,a.side); return `<tr><td>${lab}</td><td>${arr.length}</td><td>${v.length?r1(avg(v)):'–'}</td><td>${v.length?median(v):'–'}</td><td><span class="chip ${cls(h?.r)}" style="flex-direction:row;gap:4px"><b>${h?pct(h.r):'–'}</b>${h?h.h+'/'+h.n:''}</span></td></tr>`;};
  const fav=g=>{const gm=S.gamesById[g.game]; if(!gm||gm.spread==null) return null; const homeFav=gm.spread>0; const isHome=g.team===gm.home; return isHome?homeFav:!homeFav;};
  return `<h2>Splits</h2><div class="tbl"><table><tr><th>Split</th><th>G</th><th>Avg</th><th>Med</th><th>Hit</th></tr>
   ${row(`${s} season`,G.filter(g=>g.season===s))}${row(`${s-1} season`,G.filter(g=>g.season===s-1))}${row(`${s-2} season`,G.filter(g=>g.season===s-2))}
   ${row('Home (2 seasons)',G.filter(g=>g.home===1&&g.season>=s-1))}${row('Away (2 seasons)',G.filter(g=>g.home===0&&g.season>=s-1))}
   ${row('As favorite',G.filter(g=>fav(g)===true))}${row('As underdog',G.filter(g=>fav(g)===false))}
   ${a.opp?row(`vs ${a.opp} (all)`,G.filter(g=>g.opp===a.opp)):''}
   ${a.dvp?row(`vs top-10 tough D (${s})`,G.filter(g=>g.season===s && (dvpOf(g.opp,a.m,p.pos)?.rank||99)<=10)):''}
   ${a.dvp?row(`vs bottom-11 soft D (${s})`,G.filter(g=>g.season===s && (dvpOf(g.opp,a.m,p.pos)?.rank||0)>=22)):''}
   </table></div>`;
}
const GL = {season:'all'};
function gameLog(a,p){
  const f=MK[a.m].f, pos=p.pos==='FB'?'RB':p.pos, season=S.stats.season, snaps=S.snaps?.[a.pid]||{};
  const cols = pos==='QB'
    ? [['completions','Cmp'],['attempts','Att'],['passing_yards','PaYd'],['passing_tds','PaTD'],['passing_interceptions','INT'],['carries','Car'],['rushing_yards','RuYd'],['rushing_tds','RuTD']]
    : pos==='RB'
    ? [['carries','Car'],['rushing_yards','RuYd'],['rushing_tds','RuTD'],['targets','Tgt'],['receptions','Rec'],['receiving_yards','ReYd'],['receiving_tds','ReTD']]
    : [['targets','Tgt'],['receptions','Rec'],['receiving_yards','ReYd'],['receiving_tds','ReTD'],['carries','Car'],['rushing_yards','RuYd']];
  const hasSnap = Object.keys(snaps).length>0;
  const seasons=[...new Set(a.games.map(g=>g.season))].sort((x,y)=>y-x);
  const G=[...a.games].reverse().filter(g=>GL.season==='all'||g.season===+GL.season);
  let hits=0, n=0;
  const rows=G.map(g=>{const v=f(g), hit=a.side>0?v>a.line:v<a.line, push=v===a.line, gm=S.gamesById[g.game];
    if(!push){n++; if(hit) hits++;}
    let res=''; if(gm&&gm.hs!=null){const my=g.team===gm.home?gm.hs:gm.as, th=g.team===gm.home?gm.as:gm.hs; res=`<span class="${my>th?'wl-w':my<th?'wl-l':''}">${my>th?'W':my<th?'L':'T'}</span> ${my}-${th}`;}
    const dt = gm?.date ? new Date(gm.date+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'}) : '';
    const sn = snaps[g.game];
    return `<tr class="${push?'push':hit?'hit':'miss'}"><td>${dt}<div class="small mut">${g.season!==season?"'"+String(g.season).slice(2)+' ':''}W${g.week}${gm&&gm.type&&gm.type!=='REG'?' '+gm.type:''}</div></td>
      <td>${g.home===1?'vs':g.home===0?'@':'vs'} <b>${g.opp}</b>${g.team!==p.team?`<div class="small mut">w/ ${g.team}</div>`:''}</td><td>${res}</td>
      ${hasSnap?`<td>${sn!=null?Math.round(sn*100)+'%':'<span class="mut">–</span>'}</td>`:''}
      ${cols.map(([c])=>`<td>${g[c]}</td>`).join('')}<td class="res"><b>${v}</b> ${push?'P':hit?'✓':'✗'}</td></tr>`;}).join('');
  return `<h2 id="gamelog">Game log — every game</h2>
   <div class="row small" style="flex-wrap:wrap;gap:8px;margin-bottom:8px"><div class="seg" id="glseason">${[['all','All'],...seasons.map(x=>[String(x),String(x)])].map(([k,l])=>`<button data-gl="${k}" class="${String(GL.season)===k?'on':''}">${l}</button>`).join('')}</div>
    <span class="mut">${MK[a.m].label} ${a.side>0?'over':'under'} ${a.line}: <b style="color:var(--text)">${hits}/${n}</b> (${n?Math.round(hits/n*100):0}%) in ${G.length} games shown · green = hit, red = miss${hasSnap?' · Snap% = offensive snap share (nflverse)':''}</span></div>
   <div class="tbl"><table class="glog"><tr><th>Date</th><th>Opp</th><th>Result</th>${hasSnap?'<th>Snap%</th>':''}${cols.map(c=>`<th>${c[1]}</th>`).join('')}<th>${MK[a.m].short} vs ${a.line}</th></tr>${rows||`<tr><td colspan="12" class="mut">No games</td></tr>`}</table></div>`;
}
function bindPlayer(){
  const pid=PS.pid;
  $$('.tabs button').forEach(b=>b.onclick=()=>{ location.hash=`#/player/${pid}?m=${b.dataset.m}`; });
  const setLine=v=>{PS.line=Math.max(0,Math.round(v*2)/2); $('#pline').value=PS.line; history.replaceState(null,'',`#/player/${pid}?m=${PS.m}&line=${PS.line}&side=${PS.side}`); renderPlayer();};
  $('#pline').onchange=e=>setLine(+e.target.value);
  $$('[data-alt]').forEach(b=>b.onclick=()=>{ if(b.dataset.alt==='reset') setLine(lineFor(pid,PS.m)?.line??0.5); else setLine(PS.line+ +b.dataset.alt); });
  $$('#pside button').forEach(b=>b.onclick=()=>{PS.side=+b.dataset.s; $$('#pside button').forEach(x=>x.classList.toggle('on',x===b)); renderPlayer();});
  $('#pfav').onclick=()=>{ const on=toggleFav(pid,PS.m,PS.line,PS.side); $('#pfav').classList.toggle('on',on); };
  $('#pslip').onclick=()=>addSlip(pid,PS.m,PS.line,PS.side);
  renderPlayer();
}
function bindPlayerExtra(){
  $$('#pwin button').forEach(b=>b.onclick=()=>{PS.win=b.dataset.w; renderPlayer();});
  $$('#glseason button').forEach(b=>b.onclick=()=>{GL.season=b.dataset.gl; const y=scrollY; renderPlayer(); scrollTo(0,y);});
  $$('[data-without]').forEach(b=>b.onclick=()=>{const t=b.dataset.without; PS.without=PS.without.includes(t)?PS.without.filter(x=>x!==t):[...PS.without,t]; renderPlayer();});
}

/* ----- defense ----- */
const DS = {pos:'WR', sort:'rec_yds', dir:-1, mode:'def'};
function viewDefense(){
  return `<h1>${DS.mode==='def'?'Defense vs Position':'Team Offense by Position'}</h1><p class="sub">${DS.mode==='def'?`${S.stats.season} per-game production allowed to each position. Rank 1 = toughest, 32 = softest (allows the most).`:`${S.stats.season} per-game production by each team's players at a position. Rank 1 = most productive.`}</p>
  <div class="seg" id="dmode"><button data-d="def" class="${DS.mode==='def'?'on':''}">Defense allowed</button><button data-d="off" class="${DS.mode==='off'?'on':''}">Offense produced</button></div>
  <div class="tabs" id="dpos">${S.POS_LIST.map(p=>`<button data-p="${p}" class="${DS.pos===p?'on':''}">${p}</button>`).join('')}</div><div id="dtable"></div>`;
}
function renderDefense(){
  const pos=DS.pos, ms=Object.keys(MK).filter(m=>MK[m].pos.includes(pos) && (pos==='QB' || !MK[m].dvp));
  if(!ms.includes(DS.sort)) DS.sort=ms[0];
  const src = DS.mode==='def'?S.dvp:S.off;
  const rows=S.dvpTeams.map(t=>({t,d:src[pos][t]})).filter(x=>x.d);
  rows.sort((a,b)=>DS.dir*((a.d[DS.sort]?.v??0)-(b.d[DS.sort]?.v??0)));
  const color=r=>{const x=DS.mode==='def'?(r-1)/31:(32-r)/31; const h=Math.round(0+x*130); return `hsl(${h} 70% 45% / .22)`;};
  $('#dtable').innerHTML=`<div class="tbl"><table class="heat"><tr><th>Team</th><th>GP</th>${ms.map(m=>`<th class="sort" data-s="${m}">${MK[m].label}${DS.sort===m?(DS.dir<0?' ▼':' ▲'):''}</th>`).join('')}</tr>
   ${rows.map(x=>`<tr><td><b>${x.t}</b>${S.slateTeam[x.t]?` <span class="mut small">vs ${S.slateTeam[x.t].opp}</span>`:''}</td><td>${x.d.gp}</td>${ms.map(m=>{const c=x.d[m]; return `<td class="v" style="background:${color(c.rank)}" title="Rank ${c.rank}/32">${c.v} <span class="mut small">${c.rank}</span></td>`;}).join('')}</tr>`).join('')}</table></div>
   <p class="small mut">Small number = rank. Green = favorable for overs, red = unfavorable.</p>`;
  $$('#dtable th.sort').forEach(th=>th.onclick=()=>{ if(DS.sort===th.dataset.s) DS.dir*=-1; else {DS.sort=th.dataset.s; DS.dir=-1;} renderDefense(); });
}
function bindDefense(){ $$('#dmode button').forEach(b=>b.onclick=()=>{DS.mode=b.dataset.d; route();}); $$('#dpos button').forEach(b=>b.onclick=()=>{DS.pos=b.dataset.p; $$('#dpos button').forEach(x=>x.classList.toggle('on',x===b)); renderDefense();}); renderDefense(); }

/* ----- trending ----- */
function viewTrending(){
  const now=Date.now(), live=S.board.filter(r=>new Date(r.g.ko).getTime()>now && !(r.inj&&BAD_STATUS.test(r.inj.status)) && r.recent);
  const streaks=[]; const up=[]; const down=[];
  for(const r of live){
    for(const sd of (r.m==='anytime_td'?[1]:[1,-1])){ const a=sd>0?r.over.a:r.under?.a; if(a&&a.streak>=4) streaks.push({r,sd,a}); }
    const a=r.over.a; if(r.m==='anytime_td'||a.avgSzn==null||(a.SZN?.n||0)<4) continue;
    const l3=avg((S.logs[r.pid]||[]).slice(-3).map(MK[r.m].f)); const d=(l3-a.avgSzn)/Math.max(a.avgSzn,1);
    (d>0?up:down).push({r,l3,d,a});
  }
  streaks.sort((x,y)=>y.a.streak-x.a.streak); up.sort((x,y)=>y.d-x.d); down.sort((x,y)=>x.d-y.d);
  const favCount={}; FAV.forEach(f=>{const k=f.pid+'|'+f.m; favCount[k]=(favCount[k]||0)+1;});
  const tr=(x,txt)=>`<tr class="golink" data-go="#/player/${x.r.pid}?m=${x.r.m}"><td><a href="#/player/${x.r.pid}?m=${x.r.m}"><b>${esc(x.r.p.name)}</b></a>${warnIcon(x.r.pid)} <span class="mut small">${x.r.p.pos} ${x.r.p.team}</span></td><td>${MK[x.r.m].label}</td><td>${txt}</td></tr>`;
  return `<h1>Trending</h1><p class="sub">Hot streaks and usage shifts on this week's slate.</p>
  <div class="grid g2">
   <div><h2>🔥 Longest active streaks vs line</h2><div class="tbl"><table><tr><th>Player</th><th>Prop</th><th>Streak</th></tr>${streaks.slice(0,20).map(x=>tr(x,`<span class="side ${x.sd>0?'o':'u'}">${x.r.m==='anytime_td'?'YES':x.sd>0?'O':'U'} ${x.r.m==='anytime_td'?'':x.r.line}</span> ${x.a.streak} straight`)).join('')||'<tr><td colspan=3 class="mut">None</td></tr>'}</table></div></div>
   <div><h2>📈 Trending up (L3 vs season avg)</h2><div class="tbl"><table><tr><th>Player</th><th>Prop</th><th>L3 / Season</th></tr>${up.slice(0,15).map(x=>tr(x,`<b style="color:var(--green)">${r1(x.l3)}</b> / ${r1(x.a.avgSzn)} (+${Math.round(x.d*100)}%)`)).join('')}</table></div></div>
   <div><h2>📉 Trending down</h2><div class="tbl"><table><tr><th>Player</th><th>Prop</th><th>L3 / Season</th></tr>${down.slice(0,15).map(x=>tr(x,`<b style="color:var(--red)">${r1(x.l3)}</b> / ${r1(x.a.avgSzn)} (${Math.round(x.d*100)}%)`)).join('')}</table></div></div>
   <div><h2>★ Your most-watched</h2><div class="card small">${FAV.length?FAV.slice(-10).reverse().map(f=>`<div style="padding:4px 0"><a href="#/player/${f.pid}?m=${f.m}"><b>${esc(S.players[f.pid]?.name)}</b></a> ${MK[f.m].label} ${f.side>0?'O':'U'} ${f.line}</div>`).join(''):'<span class="mut">Star props to build your watchlist.</span>'}</div></div>
  </div>`;
}

/* ----- favorites ----- */
function viewFavorites(){
  if(!FAV.length) return `<h1>Watchlist</h1><div class="empty card">No starred props yet. Tap ★ on any prop.</div>`;
  const cards=FAV.map(f=>{const p=S.players[f.pid]; if(!p) return ''; const cur=lineFor(f.pid,f.m); const line=cur?.line??f.line;
    const a=analyze(f.pid,f.m,line,f.side), sc=score(a), st=S.slateTeam[p.team];
    return `<div class="card pick" data-go="#/player/${f.pid}?m=${f.m}&line=${line}&side=${f.side}" tabindex="0" role="link"><div class="row">${headshot(p)}<div class="sp"><a class="pname" href="#/player/${f.pid}?m=${f.m}">${esc(p.name)}</a>${warnIcon(f.pid)}<div class="small mut">${p.pos} · ${p.team}${st?` ${st.home?'vs':'@'} ${st.opp} · ${fmtTime(st.g.ko)}`:' · not on slate'}</div></div><button class="star on" data-fav="${f.pid}|${f.m}|${f.line}|${f.side}">★</button></div>
      <div class="row" style="margin:8px 0"><span class="side ${f.side>0?'o':'u'}">${f.m==='anytime_td'?'YES':f.side>0?'OVER':'UNDER'}</span><b>${f.m==='anytime_td'?'':line} ${MK[f.m].label}</b>${line!==f.line?`<span class="pill a">saved at ${f.line}</span>`:''}<span class="sp"></span><b>${sc.score}</b></div>
      ${hrChips(a)}<div style="margin-top:8px"><button class="btn" data-slip="${f.pid}|${f.m}|${line}|${f.side}">+ Slip</button></div></div>`;}).join('');
  return `<h1>Watchlist</h1><p class="sub">${FAV.length} starred props (saved in this browser), re-scored against the latest line.</p><div class="grid g3">${cards}</div>`;
}

/* ----- slip ----- */
/* Export: neither PrizePicks nor Dabble offers a public, documented deep link that pre-fills picks.
   PrizePicks' board accepts projection IDs (as Pick Finder uses), but those IDs come only from PrizePicks'
   own projections API, which is bot-protected and not licensed for third-party use — so we don't fake it.
   Instead: open the app/site + copy a clean slip, or use the phone's share sheet. */
const APPS = {
  prizepicks:{name:'PrizePicks', url:'https://app.prizepicks.com/', more:'More', less:'Less'},
  dabble:{name:'Dabble', url:'https://www.dabble.com/', more:'Over', less:'Under'},
};
let SMODE = LS.get('smode','book'); // book | prizepicks | dabble
const PK_STAT = {pass_yds:'Pass Yards', pass_tds:'Pass TDs', completions:'Pass Completions', rush_yds:'Rush Yards', rec_yds:'Receiving Yards',
  receptions:'Receptions', anytime_td:'Rush+Rec TDs', rush_rec_yds:'Rush+Rec Yds', pass_att:'Pass Attempts', rush_att:'Rush Attempts', targets:'Targets', ints:'INTs Thrown'};
const legLine = s => SMODE==='book' ? s.line : (s.pk?.[SMODE] ?? s.line);
function slipText(){
  const app=APPS[SMODE];
  if(!app) return SLIP.map(s=>`${S.players[s.pid]?.name} ${s.m==='anytime_td'?'Anytime TD':(s.side>0?'Over ':'Under ')+s.line+' '+MK[s.m].label}`).join('\n');
  return `${app.name} picks (PropScout)\n` + SLIP.map((s,i)=>{const p=S.players[s.pid]; const st=S.slateTeam[p?.team];
    return `${i+1}. ${p?.name} (${p?.team}${st?` ${st.home?'vs':'@'} ${st.opp}`:''}) — ${PK_STAT[s.m]||MK[s.m].label} ${s.side>0?app.more:app.less} ${legLine(s)}`;}).join('\n');
}
function viewSlip(){
  if(!SLIP.length) return `<h1>Slip</h1><div class="empty card">Your slip is empty. Add props with “+ Slip”.</div>`;
  const pk = SMODE!=='book', app=APPS[SMODE];
  let dec=1, priced=true, prob=1;
  const items=SLIP.map((s,i)=>{const p=S.players[s.pid]; if(!p) return ''; const line=legLine(s); const a=analyze(s.pid,s.m,line,s.side); const b=S.lines[s.pid+'|'+s.m];
    const best = !pk && b && b.line===s.line ? (s.side>0?b.bestO:b.bestU) : null; const price = best ? (s.side>0?best.over:best.under) : null;
    if(price!=null) dec*=toDec(price); else priced=false; prob*= (a.L10?.r ?? .5);
    const sideLab = s.m==='anytime_td' ? 'YES' : pk ? (s.side>0?app.more:app.less) : (s.side>0?'O':'U');
    const pick = pk
      ? `<div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn sm" data-flip="${i}" title="Switch side"><span class="side ${s.side>0?'o':'u'}">${sideLab}</span></button><input class="pkl" type="number" step="0.5" min="0" data-pk="${i}" value="${line}" aria-label="${esc(app.name)} line"></div>${b&&b.line!==line?`<div class="small mut">book ${b.line}</div>`:''}`
      : `<span class="side ${s.side>0?'o':'u'}">${sideLab} ${s.m==='anytime_td'?'':s.line}</span>`;
    return `<tr><td><a href="#/player/${s.pid}?m=${s.m}"><b>${esc(p.name)}</b></a>${warnIcon(s.pid)}<div class="small mut">${p.team} · ${MK[s.m].label}</div></td><td>${pick}</td>
      ${pk?`<td>${hrMini(a.L5)}</td><td>${hrMini(a.L10)}</td><td class="hide-m">${hrMini(a.SZN)}</td>`:`<td>${price!=null?fmtOdds(price)+' <span class="mut small">'+esc(best.book)+'</span>':'<span class="mut">–</span>'}</td><td>${pct(a.L10?.r)}</td>`}<td><button class="btn" data-rm="${i}">✕</button></td></tr>`;}).join('');
  const head = pk ? `<th>Player</th><th>${esc(app.name)} pick & line</th><th>L5</th><th>L10</th><th class="hide-m">Season</th><th></th>` : `<th>Player</th><th>Pick</th><th>Best price</th><th>L10 hit</th><th></th>`;
  return `<h1>Slip builder</h1>
   <div class="seg" id="smode" style="margin-bottom:10px">${[['book','Sportsbook'],['prizepicks','PrizePicks'],['dabble','Dabble']].map(([k,l])=>`<button data-sm="${k}" class="${SMODE===k?'on':''}">${l}</button>`).join('')}</div>
   ${pk?`<p class="small mut" style="margin-top:0">${esc(app.name)} posts its own lines, which no free feed provides. Type the ${esc(app.name)} line on each leg (starts at the sportsbook line) and hit rates recalculate. Lines are saved in this browser.</p>`:''}
   <div class="tbl"><table><tr>${head}</tr>${items}</table></div>
   <div class="kv" style="margin-top:12px"><div><span>Legs</span><b>${SLIP.length}</b></div>
   ${pk?'':`<div><span>Parlay odds</span><b>${priced&&SLIP.length>1?fmtOdds(toAm(dec)):'–'}</b></div>`}
   <div><span>Naive hit prob (L10)</span><b>${pct(prob)}</b></div>
   ${pk?'':`<div><span>Implied prob</span><b>${priced?pct(1/dec):'–'}</b></div>`}</div>
   <p class="small mut">${pk?'"Naive" multiplies last-10 hit rates at your lines and ignores correlation.':'Parlay odds need a book price on every leg at the slip\'s line. "Naive" multiplies last-10 hit rates and ignores correlation.'}</p>
   <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
     ${pk?`<button class="btn pri" id="openapp">Copy & open ${esc(app.name)}</button>`:''}
     <button class="btn ${pk?'':'pri'}" id="copyslip">Copy slip</button>
     ${navigator.share?'<button class="btn" id="shareslip">Share…</button>':''}
     ${pk?'':`<button class="btn" data-sm2="prizepicks">→ PrizePicks</button><button class="btn" data-sm2="dabble">→ Dabble</button>`}
     <button class="btn" id="clearslip">Clear</button></div>
   ${pk?`<p class="small mut">No verified deep link pre-fills ${esc(app.name)} picks from outside the app, so this copies your slip and opens ${esc(app.name)}${SMODE==='prizepicks'?' (the app opens if installed, otherwise the web board)':' (app-only in the US: install it from your app store if the site doesn\'t hand off)'} — add each leg there from the list.</p>`:''}
   <pre class="card small" id="slipprev" style="white-space:pre-wrap;margin-top:10px">${esc(slipText())}</pre>`;
}
const hrMini = x => x ? `<span class="chip ${cls(x.r)}" style="flex-direction:row;gap:4px"><b>${pct(x.r)}</b><span class="small">${x.h}/${x.n}</span></span>` : '–';
async function copyText(t){ try{ await navigator.clipboard.writeText(t); return true; }catch{ const ta=document.createElement('textarea'); ta.value=t; ta.style.position='fixed'; ta.style.left='-9999px'; document.body.appendChild(ta); ta.select(); const ok=document.execCommand('copy'); ta.remove(); return ok; } }
function bindSlip(){
  $$('[data-rm]').forEach(b=>b.onclick=()=>{SLIP.splice(+b.dataset.rm,1); LS.set('slip',SLIP); updSlipCount(); route();});
  $$('[data-sm],[data-sm2]').forEach(b=>b.onclick=()=>{SMODE=b.dataset.sm||b.dataset.sm2; LS.set('smode',SMODE); route();});
  $$('[data-flip]').forEach(b=>b.onclick=()=>{const s=SLIP[+b.dataset.flip]; if(s.m==='anytime_td') return; s.side*=-1; LS.set('slip',SLIP); route();});
  $$('[data-pk]').forEach(inp=>inp.onchange=()=>{const s=SLIP[+inp.dataset.pk]; const v=Math.max(0,Math.round(+inp.value*2)/2); (s.pk ??= {})[SMODE]=v; LS.set('slip',SLIP); const y=scrollY; route(); scrollTo(0,y);});
  const c=$('#copyslip'); if(c) c.onclick=async()=>{ toast(await copyText(slipText())?'Slip copied':'Copy failed'); };
  const o=$('#openapp'); if(o) o.onclick=async()=>{ await copyText(slipText()); toast('Slip copied — opening '+APPS[SMODE].name); setTimeout(()=>window.open(APPS[SMODE].url,'_blank','noopener'),350); };
  const sh=$('#shareslip'); if(sh) sh.onclick=async()=>{ try{ await navigator.share({title:'PropScout slip', text:slipText()}); }catch(e){} };
  const x=$('#clearslip'); if(x) x.onclick=()=>{SLIP=[]; LS.set('slip',SLIP); updSlipCount(); route();};
}

/* ----- injuries ----- */
let IQ={team:'all',q:'',skill:true};
function viewInjuries(){
  const teams=Object.keys(S.injByTeam).sort();
  return `<h1>Injury report</h1><p class="sub">From ESPN, updated ${ago(S.inj.updated)}.</p>
  <div class="filters"><select id="iteam"><option value="all">All teams</option><option value="slate" ${IQ.team==='slate'?'selected':''}>This week's slate</option>${teams.map(t=>`<option ${IQ.team===t?'selected':''}>${t}</option>`).join('')}</select>
  <input id="iq" type="search" placeholder="Player" value="${esc(IQ.q)}"><label class="row small"><input type="checkbox" id="iskill" ${IQ.skill?'checked':''}> QB/RB/WR/TE only</label></div><div id="ilist"></div>`;
}
function renderInj(){
  const q=norm(IQ.q); const teams=Object.keys(S.injByTeam).sort().filter(t=>IQ.team==='all'||(IQ.team==='slate'?S.slateTeam[t]:t===IQ.team));
  $('#ilist').innerHTML=`<div class="grid g3">${teams.map(t=>{const items=S.injByTeam[t].filter(i=>(!IQ.skill||!S.SKILL||S.SKILL.includes(i.pos))&&(!q||norm(i.name).includes(q))); if(!items.length) return '';
    return `<div class="card"><div class="row"><b>${t}</b>${S.slateTeam[t]?`<span class="mut small">${S.slateTeam[t].home?'vs':'@'} ${S.slateTeam[t].opp}</span>`:''}</div>${items.map(i=>{const pid=Object.keys(S.players).find(k=>S.players[k].team===t&&norm(S.players[k].name)===norm(i.name));
      return `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><div class="row small"><span class="pill ${BAD_STATUS.test(i.status)?'r':'a'}">${esc(i.status)}</span>${pid?`<a href="#/player/${pid}"><b>${esc(i.name)}</b></a>`:`<b>${esc(i.name)}</b>`}<span class="mut">${esc(i.pos||'')}</span></div><div class="small mut">${esc(i.detail)}</div></div>`;}).join('')}</div>`;}).join('')}</div>`;
}
function bindInj(){ $('#iteam').onchange=e=>{IQ.team=e.target.value;renderInj();}; $('#iq').oninput=e=>{IQ.q=e.target.value;renderInj();}; $('#iskill').onchange=e=>{IQ.skill=e.target.checked;renderInj();}; renderInj(); }

/* ----- category hit rates ----- */
function viewCategories(){
  const c=S.cats||{cats:{}}; const ms=[...new Set([...Object.keys(CAT_PRIOR[S.SPORT]||{}), ...Object.keys(c.cats||{})])];
  const lab=m=>MK[m]?.label||m;
  const row=(m,side)=>{const k=side>0?'over':'under'; const x=c.cats?.[m]?.[k]||[0,0,0]; const cr=catRate(m,side); const n=x[0]+x[1];
    return `<tr><td>${esc(lab(m))}</td><td><span class="side ${side>0?'o':'u'}">${side>0?'Over':'Under'}</span></td><td>${x[0]}-${x[1]}${x[2]?`-${x[2]}P`:''}</td><td>${n?pct(x[0]/n):'–'}</td><td>${cr?pct(cr.prior):'<span class="mut">n/a</span>'}</td><td><b>${cr?pct(cr.rate):'–'}</b></td><td class="small mut" style="white-space:normal;text-align:left">${cr?esc(cr.src):'yes/no or 0.5 line: price carries it, no score factor'}</td></tr>`;};
  return `<h1>Category hit rates</h1><p class="sub">${S.SPORT.toUpperCase()} · every real sportsbook line we stored is graded after the game is final (push = exact line, DNP = void). ${c.graded||0} lines graded so far${c.updated?`, last ${ago(c.updated)}`:''}.</p>
  <div class="tbl"><table><tr><th>Market</th><th>Side</th><th>Our W-L</th><th>Our rate</th><th>Prior</th><th>Blended</th><th>Prior source</th></tr>${ms.map(m=>row(m,1)+(c.cats?.[m]?.under||CAT_PRIOR[S.SPORT]?.[m]?row(m,-1):'')).join('')}</table></div>
  <p class="small mut">Blended = (prior × ${CAT_N0} + our hits) / (${CAT_N0} + our graded), so a small sample can't swing it; it becomes mostly our own data after a few hundred lines. In the score it's worth 10%: a 54% category adds about 2 points, a 46% one subtracts about 2.</p>`;
}

/* ----- data status ----- */
function viewData(){
  const st=S.status||{}, o=st.odds||{};
  return `<h1>Data status</h1>
  <div class="kv"><div><span>Last refresh</span><b style="font-size:14px">${fmtDT(st.updated)}</b><span>${ago(st.updated)}</span></div>
  <div><span>Season</span><b>${st.season||'–'}</b></div><div><span>Players</span><b>${st.players||'–'}</b></div><div><span>Game rows</span><b>${st.rows||'–'}</b></div>
  <div><span>Games this week</span><b>${st.upcoming??'–'}</b></div><div><span>Odds key</span><b style="color:${o.has_key?'var(--green)':'var(--amber)'}">${o.has_key?'Set':'Missing'}</b></div>
  <div><span>Odds credits left</span><b>${o.remaining??'–'}</b><span>used ${o.used??'–'} / 500</span></div><div><span>Lines updated</span><b style="font-size:14px">${o.updated?fmtDT(o.updated):'never'}</b></div></div>
  <h2>Last run log</h2><div class="tbl"><table><tr><th>Source</th><th>Status</th><th>Message</th></tr>${(st.log||[]).map(l=>`<tr><td>${esc(l.source)}</td><td><span class="pill ${l.status==='ok'?'g':l.status==='error'?'r':'a'}">${esc(l.status)}</span></td><td style="text-align:left;white-space:normal">${esc(l.message)}</td></tr>`).join('')}</table></div>
  <h2>Sources</h2><div class="card small">
   <p><b>Player stats</b> — nflverse weekly player stats (free, no key), ${S.stats.season-2}–${S.stats.season}. Updated by nflverse overnight after games.</p>
   <p><b>Schedule & game lines</b> — nflverse games.csv (spread/total used for favorite/underdog split).</p>
   <p><b>Injuries</b> — ESPN public injuries feed; starters/key players from nflverse snap counts.</p><p><b>Betting splits</b> — DraftKings Sportsbook's free public splits page (dknetwork.draftkings.com): % bets and % handle for spread, total and moneyline. No free source publishes player-prop splits.</p>
   <p><b>Prop lines</b> — The Odds API (free tier: 500 credits/month). Each upcoming game is fetched once ~30h before kickoff for 7 markets (~7 credits/game), which fits the free tier. Without a key the app uses model lines.</p>
   <p><b>Refresh schedule</b> — GitHub Actions at about 7 AM, 1 PM and 6 PM ET daily.</p></div>`;
}
function viewMore(){
  return `<h1>More</h1><div class="card morelist" style="padding:0"><a href="#/trending">📈 Trending</a><a href="#/favorites">★ Watchlist</a><a href="#/injuries">🩹 Injury report</a><a href="#/categories">📊 Category hit rates</a><a href="#/data">⚙️ Data status</a><a href="${S.SPORT==='nfl'?'nhl/':'../'}">🔁 Switch to ${S.SPORT==='nfl'?'NHL':'NFL'}</a></div>`;
}

/* ---------- search ---------- */
function bindSearch(){
  const inp=$('#gsearch'), box=$('#gsearch-results'); let idx=-1;
  const run=()=>{ const q=norm(inp.value); if(q.length<2||!S.ready){box.hidden=true;return;}
    const season=S.stats.season;
    const res=Object.values(S.players).filter(p=>norm(p.name).includes(q)).sort((a,b)=>(b.last[0]-a.last[0])||(norm(a.name).indexOf(q)-norm(b.name).indexOf(q))).slice(0,10);
    box.innerHTML=res.map(p=>`<a href="#/player/${p.id}">${headshot(p)}<div><b>${esc(p.name)}</b>${kiAll(keyInj(p.id)).length?' ⚠️':''}<div class="small mut">${p.pos} · ${p.team}${p.last[0]<season?' · '+p.last[0]:''}</div></div></a>`).join('')||'<div class="empty small">No players</div>';
    box.hidden=false; idx=-1; };
  inp.oninput=run; inp.onfocus=run;
  inp.onkeydown=e=>{const items=$$('a',box); if(e.key==='ArrowDown'){idx=Math.min(idx+1,items.length-1);} else if(e.key==='ArrowUp'){idx=Math.max(idx-1,0);} else if(e.key==='Enter'){ (items[idx]||items[0])?.click(); return;} else if(e.key==='Escape'){box.hidden=true;return;} else return; e.preventDefault(); items.forEach((a,i)=>a.classList.toggle('act',i===idx)); };
  box.onclick=()=>{box.hidden=true; inp.value=''; inp.blur();};
  document.addEventListener('click',e=>{ if(!e.target.closest('.search-wrap')) box.hidden=true; });
}

/* ---------- router ---------- */
function route(){
  if(!S.ready) return;
  const h=location.hash.slice(1)||'/'; const [path,qs]=h.split('?'); const params=new URLSearchParams(qs||''); const parts=path.split('/').filter(Boolean);
  const r=parts[0]||'home'; const app=$('#app');
  $$('[data-r]').forEach(a=>a.classList.toggle('on',a.dataset.r===r || (r==='player'&&a.dataset.r==='board')));
  try{
    if(r==='home'){ app.innerHTML=viewHome(); bindHome(); }
    else if(r==='board'){ app.innerHTML=viewBoard(params); bindBoard(); }
    else if(r==='player'){ app.innerHTML=viewPlayer(parts[1],params); if(S.players[parts[1]]) bindPlayer(); }
    else if(r==='defense'){ app.innerHTML=viewDefense(); bindDefense(); }
    else if(r==='trending'){ app.innerHTML=viewTrending(); }
    else if(r==='favorites'){ app.innerHTML=viewFavorites(); bindCommon(app); }
    else if(r==='slip'){ app.innerHTML=viewSlip(); bindSlip(); }
    else if(r==='injuries'){ app.innerHTML=viewInjuries(); bindInj(); }
    else if(r==='data'){ app.innerHTML=viewData(); }
    else if(r==='categories'){ app.innerHTML=viewCategories(); }
    else if(r==='more'){ app.innerHTML=viewMore(); }
    else app.innerHTML=`<div class="empty card">Page not found. <a href="#/">Go home</a></div>`;
  }catch(e){ console.error(e); app.innerHTML=`<div class="banner err">Something went wrong rendering this page: ${esc(e.message)}</div>`; }
  if(r!=='player'||!route._same) window.scrollTo(0,0);
}
window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', async()=>{
  bindSearch(); updSlipCount();
  try{ await load(); banner(); route(); }
  catch(e){ console.error(e); $('#app').innerHTML=`<div class="banner err">Couldn't load data (${esc(e.message)}). The first data refresh may not have run yet — try again in a few minutes.</div>`; }
});
/* ⚠️ popover: hover on desktop, tap on mobile (cards clip overflow, so it's a fixed-position layer) */
(function(){
  let tip=null, cur=null;
  const hide=()=>{ if(tip){tip.remove(); tip=null; cur=null;} };
  const show=el=>{ if(cur===el) return; hide(); const src=el.querySelector('.tip'); if(!src) return;
    tip=document.createElement('div'); tip.id='kitip'; tip.innerHTML='<b>⚠️ Key injuries</b>'+src.innerHTML; document.body.appendChild(tip); cur=el;
    const r=el.getBoundingClientRect(), w=tip.offsetWidth, h=tip.offsetHeight;
    let x=Math.min(Math.max(8,r.left+r.width/2-w/2), innerWidth-w-8), y=r.bottom+6; if(y+h>innerHeight-8) y=Math.max(8,r.top-h-6);
    tip.style.left=x+'px'; tip.style.top=y+'px'; };
  document.addEventListener('mouseover',e=>{ const w=e.target.closest?.('.warn'); if(w && matchMedia('(hover:hover)').matches) show(w); else if(!w && cur && matchMedia('(hover:hover)').matches) hide(); });
  document.addEventListener('click',e=>{ const w=e.target.closest?.('.warn'); if(w){ e.preventDefault(); e.stopPropagation(); (cur===w && !matchMedia('(hover:hover)').matches)?hide():show(w); } else hide(); }, true);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') hide(); if(e.key==='Enter' && document.activeElement?.classList.contains('warn')) show(document.activeElement); });
  addEventListener('scroll',hide,{passive:true}); addEventListener('hashchange',hide);
})();

/* tap/click anywhere on a player card or row -> his player page (game log); buttons, links, inputs and ⚠️ keep their own action */
document.addEventListener('click', e=>{
  const c=e.target.closest?.('[data-go]'); if(!c) return;
  if(e.target.closest('button,a,input,select,label,textarea,.warn,summary')) return;
  location.hash=c.dataset.go;
});
document.addEventListener('keydown', e=>{ if(e.key==='Enter' && e.target?.dataset?.go && !e.target.closest('button,a,input')) location.hash=e.target.dataset.go; });
