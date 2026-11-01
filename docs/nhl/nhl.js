/* PropScout NHL: hockey config + overrides on top of the shared app.js (loaded first). */
'use strict';
S.SPORT='nhl'; S.POS_LIST=['F','D','G']; S.SKILL=null;
S.slateLabel = () => { const d=[...new Set(S.slate.map(g=>g.date))]; return d.length>1?'Today & tomorrow':'Today'; };
for(const k of Object.keys(MK)) delete MK[k];
Object.assign(MK, {
  sog:    {label:'Shots on Goal', short:'SOG', pos:['F','D'], dvp:null, f:g=>g.sog, alt:[-1,1], book:true},
  points: {label:'Points', short:'PTS', pos:['F','D'], dvp:null, f:g=>g.points, alt:[1], book:true},
  goals:  {label:'Goals', short:'G', pos:['F','D'], dvp:null, f:g=>g.goals, alt:[1]},
  assists:{label:'Assists', short:'A', pos:['F','D'], dvp:null, f:g=>g.assists, alt:[1]},
  ppp:    {label:'PP Points', short:'PPP', pos:['F','D'], dvp:null, f:g=>g.ppp??0, alt:[1]},
  blk:    {label:'Blocked Shots', short:'BLK', pos:['F','D'], dvp:null, f:g=>g.blk, alt:[-1,1]},
  hits:   {label:'Hits', short:'HIT', pos:['F','D'], dvp:null, f:g=>g.hits, alt:[-1,1]},
  saves:  {label:'Saves', short:'SV', pos:['G'], dvp:null, f:g=>g.saves, alt:[-3,-1,1,3]},
  ga:     {label:'Goals Against', short:'GA', pos:['G'], dvp:null, f:g=>g.ga, alt:[-1,1]},
});
BOARD_MK.splice(0, BOARD_MK.length, 'sog','points','goals','assists','blk','saves');
for(const k of Object.keys(VOL)) delete VOL[k];
Object.assign(VOL, {sog:p=>p.toi>=12, points:p=>p.toi>=14, goals:p=>p.toi>=14, assists:p=>p.toi>=14, ppp:p=>p.toi>=15,
  blk:p=>p.toi>=15, hits:p=>p.toi>=12, saves:p=>p.startRate>=.5, ga:p=>p.startRate>=.5});
Object.assign(PK_STAT, {sog:'Shots On Goal', points:'Points', goals:'Goals', assists:'Assists', ppp:'Power Play Points', blk:'Blocked Shots', hits:'Hits', saves:'Goalie Saves', ga:'Goals Allowed'});
for(const k of Object.keys(KI_OWN)) delete KI_OWN[k]; for(const k of Object.keys(KI_OPP)) delete KI_OPP[k];
Object.assign(KI_OWN, {F:['F','D'], D:['D','F'], G:['D']});
Object.assign(KI_OPP, {F:['G','D'], D:['G','D'], G:['F']});

/* Hockey injury factor (points on 0-100, for the Over; reversed for the Under). Fresh absences only;
   Day-To-Day / Questionable count 40%. Capped at +-12; -6 if he himself is DTD/Questionable. */
const NHL_KI = {
  skater:{ ownKey:+2,    // top-6 F / top-4 D teammate out: more TOI and PP time
           ownPP1:-1.5,  // PP1 teammate out: weaker power play (applied on top of ownKey)
           oppG:+5,      // opposing starting goalie out: backup in net
           oppD:+2.5 },  // opposing top-4 D out
  goalie:{ oppF:-2,      // opposing top-6 F out: fewer shots
           ownD:+2.5 },  // own top-4 D out: more shots against
};
function keyInj(pid){
  if(_ki[pid]) return _ki[pid];
  const p=S.players[pid], st=S.slateTeam[p?.team], res={own:[], opp:[], pts:0, notes:[], self:0};
  if(!p) return (_ki[pid]=res);
  const isG=p.pos==='G';
  const pick=(team, grps, side)=>(S.injByTeam[team]||[]).filter(i=>i.key && grps.includes(i.grp) && KI_STATUS.test(i.status||'') && i.pid!==pid)
    .map(i=>{ let v=0;
      if(i.fresh){ if(isG){ if(side==='opp'&&i.grp==='F') v=NHL_KI.goalie.oppF; if(side==='own'&&i.grp==='D') v=NHL_KI.goalie.ownD; }
        else if(side==='own'){ if(i.grp!=='G') v=NHL_KI.skater.ownKey+(i.pp1?NHL_KI.skater.ownPP1:0); }
        else { if(i.grp==='G') v=NHL_KI.skater.oppG; else if(i.grp==='D') v=NHL_KI.skater.oppD; } }
      return {...i, side, pts:v*kiW(i.status)}; })
    .sort((a,b)=>Math.abs(b.pts)-Math.abs(a.pts));
  res.own=pick(p.team, KI_OWN[p.pos]||[], 'own'); if(st) res.opp=pick(st.opp, KI_OPP[p.pos]||[], 'opp');
  let t=0; for(const i of [...res.own,...res.opp]) t+=i.pts;
  res.pts=Math.max(-KI_CAP, Math.min(KI_CAP, r1(t)));
  for(const i of [...res.own,...res.opp]) if(i.pts) res.notes.push({t:`${i.side==='own'?p.team:st.opp} ${i.grp} ${i.name} ${kiShort(i.status)} (${kiUse(i)})`, v:i.pts});
  const me=injuryOf(p); res.self = me && /^(questionable|day-to-day)/i.test(me.status||'') ? KI_SELF_Q : 0; res.selfSt=me?.status;
  return (_ki[pid]=res);
}
const _kiPanel = kiPanel;
kiPanel = pid => _kiPanel(pid).replace('Key = season snap share above a starter threshold (nflverse snap counts).',
  'Key = top-6 F / top-4 D by average TOI (last 10 games), starting G by starts, PP1 = team\'s top-5 in PP points (NHL API).')
  .replace('(usage & volume)','(TOI, PP time, shots against)').replace('(who covers him)','(goalie and top-4 D)');

async function load(){
  const [stats, games, inj, props, hist, status] = await Promise.all([
    getJSON('stats.json'), getJSON('games.json'), getJSON('injuries.json',{items:[]}),
    getJSON('props.json',{lines:[]}), getJSON('line_history.json',{}), getJSON('status.json',{})]);
  Object.assign(S,{stats,games,inj,props,hist,status});
  S.cats = await getJSON('results.json',{cats:{}}); S.snaps={};
  S.splits = await getJSON('splits.json',{games:[]}); S.splitBy={}; for(const g of S.splits.games||[]) S.splitBy[g.away+'@'+g.home] ??= g;
  S.players = stats.players;
  for(const g of games.games) S.gamesById[g.id]=g;
  for(const [pid, rows] of Object.entries(stats.logs)){
    const cols = S.players[pid]?.pos==='G' ? stats.gcols : stats.cols;
    S.logs[pid] = rows.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
  }
  for(const i of inj.items||[]){ S.injByName[norm(i.name)+'|'+i.team]=i; S.injByName[norm(i.name)] ??= i; (S.injByTeam[i.team] ??= []).push(i); }
  S.slate = games.upcoming || [];
  for(const g of S.slate){ if(S.slateTeam[g.home]) continue; S.slateTeam[g.home]={g,opp:g.away,home:true}; S.slateTeam[g.away]={g,opp:g.home,home:false}; }
  buildDvP(); buildLines(); buildBoard();
  S.ready = true;
}
function volume(pid){
  const season=S.stats.season, rows=(S.logs[pid]||[]).filter(g=>g.season===season), n=rows.length||1, l10=rows.slice(-10);
  return {gp:rows.length, toi:rows.reduce((s,g)=>s+(g.toi||0),0)/n, sog:rows.reduce((s,g)=>s+(g.sog||0),0)/n,
    startRate: l10.length? l10.filter(g=>g.start).length/l10.length : 0, att:0, car:0, tgt:0};
}
/* goalie matchup box on skater pages */
function probableG(team){
  const season=S.stats.season;
  const gs=Object.values(S.players).filter(p=>p.pos==='G' && p.team===team).map(p=>{const r=(S.logs[p.id]||[]).filter(g=>g.season===season);
    const l=r.slice(-6); const sa=r.reduce((s,g)=>s+g.sa,0), sv=r.reduce((s,g)=>s+g.saves,0), toi=r.reduce((s,g)=>s+g.toi,0);
    return {p, starts:l.filter(g=>g.start).length, last:r.length?r[r.length-1].date:'', svp:sa?sv/sa:null, gaa:toi?(sa-sv)*60/toi:null, gp:r.length, inj:injuryOf(p)};})
    .filter(x=>x.gp).sort((a,b)=>b.starts-a.starts||(a.last<b.last?1:-1));
  return gs;
}
const _matchup = matchupPanel;
matchupPanel = (a,p) => {
  let box='';
  if(a.opp){ const gs=probableG(p.pos==='G'?p.team:a.opp).slice(0,3);
    if(gs.length) box=`<h2>${p.pos==='G'?'Goalie depth':'Goalie matchup'} · ${p.pos==='G'?p.team:a.opp}</h2><div class="card small">${gs.map((x,i)=>`<div class="row" style="padding:3px 0">${i===0&&!(x.inj&&BAD_STATUS.test(x.inj.status))?'<span class="pill g">likely starter</span>':''}<a href="#/player/${x.p.id}?m=saves"><b>${esc(x.p.name)}</b></a>${warnIcon(x.p.id)} <span class="mut">${x.gp} GP · ${x.starts}/6 recent starts · SV% ${x.svp!=null?x.svp.toFixed(3).slice(1):'–'} · GAA ${x.gaa!=null?x.gaa.toFixed(2):'–'}</span>${x.inj?injPill(x.inj):''}</div>`).join('')}<p class="mut" style="margin:6px 0 0">Likely starter = most starts in the team's last 6 games (no confirmed-starter feed is free). Confirm before puck drop.</p></div>`; }
  return _matchup(a,p).replace(' defense vs ', ' vs ') + box;
};
function teammatePanel(pid){
  const p=S.players[pid], season=S.stats.season;
  const mates=Object.values(S.players).filter(t=>t.team===p.team && t.id!==pid && t.pos!=='G').map(t=>({t, v:volume(t.id), inj:injuryOf(t)}))
    .filter(x=>x.v.gp>=2).sort((a,b)=>b.v.toi-a.v.toi).slice(0,12);
  if(!mates.length) return '';
  return `<h2>Teammate out filter</h2><div class="card"><p class="small mut" style="margin-top:0">Recalculate hit rates using only games where the selected teammate(s) did not play. Sorted by TOI. Uses ${season-1}–${season} games.</p>
   <div class="chips">${mates.map(x=>`<button class="btn ${PS.without.includes(x.t.id)?'on':''}" data-without="${x.t.id}">${esc(x.t.name)} <span class="mut">${x.t.pcode||x.t.pos} ${r1(x.v.toi)}m</span>${warnIcon(x.t.id)}${x.inj?` <span class="pill ${BAD_STATUS.test(x.inj.status)?'r':'a'}">${esc(x.inj.status)}</span>`:''}</button>`).join('')}</div></div>`;
}
function gameLog(a,p){
  const f=MK[a.m].f, season=S.stats.season, isG=p.pos==='G';
  const cols = isG ? [['saves','SV'],['sa','SA'],['ga','GA'],['toi','TOI']] :
    [['toi','TOI'],['goals','G'],['assists','A'],['points','P'],['sog','SOG'],['ppg','PPG'],['ppp','PPP'],['blk','BLK'],['hits','HIT'],['pim','PIM']];
  const seasons=[...new Set(a.games.map(g=>g.season))].sort((x,y)=>y-x);
  const G=[...a.games].reverse().filter(g=>GL.season==='all'||g.season===+GL.season);
  let hits=0,n=0;
  const rows=G.map(g=>{const v=f(g), hit=a.side>0?v>a.line:v<a.line, push=v===a.line, gm=S.gamesById[g.game];
    if(!push){n++; if(hit) hits++;}
    let res=''; if(gm&&gm.hs!=null){const my=g.team===gm.home?gm.hs:gm.as, th=g.team===gm.home?gm.as:gm.hs; res=`<span class="${my>th?'wl-w':'wl-l'}">${my>th?'W':'L'}</span> ${my}-${th}`;}
    const dt=g.date?new Date(g.date+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'}):'';
    const ex = isG ? `<td>${g.sa?(g.saves/g.sa).toFixed(3).slice(1):'–'}</td><td>${g.start?'✓':''}</td>` : '';
    return `<tr class="${push?'push':hit?'hit':'miss'}"><td>${dt}<div class="small mut">${g.season!==season?"'"+String(g.season).slice(2)+'-'+String(g.season+1).slice(2):''}${gm?.type==='POST'?' PO':''}</div></td>
      <td>${g.home===1?'vs':'@'} <b>${g.opp}</b>${g.team!==p.team?`<div class="small mut">w/ ${g.team}</div>`:''}</td><td>${res}</td>
      ${cols.map(([c])=>`<td>${g[c]??'–'}</td>`).join('')}${ex}<td class="res"><b>${v}</b> ${push?'P':hit?'✓':'✗'}</td></tr>`;}).join('');
  return `<h2 id="gamelog">Game log — every game</h2>
   <div class="row small" style="flex-wrap:wrap;gap:8px;margin-bottom:8px"><div class="seg" id="glseason">${[['all','All'],...seasons.map(x=>[String(x),x+'-'+String(x+1).slice(2)])].map(([k,l])=>`<button data-gl="${k}" class="${String(GL.season)===k?'on':''}">${l}</button>`).join('')}</div>
    <span class="mut">${MK[a.m].label} ${a.side>0?'over':'under'} ${a.line}: <b style="color:var(--text)">${hits}/${n}</b> (${n?Math.round(hits/n*100):0}%) in ${G.length} games · green = hit, red = miss · TOI in minutes</span></div>
   <div class="tbl"><table class="glog"><tr><th>Date</th><th>Opp</th><th>Result</th>${cols.map(c=>`<th>${c[1]}</th>`).join('')}${isG?'<th>SV%</th><th>GS</th>':''}<th>${MK[a.m].short} vs ${a.line}</th></tr>${rows||'<tr><td colspan="14" class="mut">No games</td></tr>'}</table></div>`;
}
function banner(){
  const el=$('#banner'), st=S.status||{}, o=st.odds||{}; let h='';
  const age = st.updated ? (Date.now()-new Date(st.updated))/3600000 : 99;
  if(age>14) h+=`<div class="banner err">NHL data is ${Math.round(age)}h old — the scheduled refresh may be failing. See the Data page.</div>`;
  const booked=new Set((S.props.lines||[]).map(l=>l.event)).size;
  if(!sessionStorage.ps_nhl_nob) h+=`<div class="banner">${booked?`Real sportsbook lines loaded for <b>${booked}</b> of ${S.slate.length} games (shots on goal + points).`:'No real NHL sportsbook lines for this slate.'} Other games and markets use <b>model lines</b> (the .5 line that splits his last 10 ~50/50), labeled “model line”. NHL lines share the free 500-credit/month Odds API plan with the NFL, so NHL only gets credits the NFL slate doesn't need (this month: ${o.nhl_used??0}/${o.nhl_cap??'–'} used, NFL reserve ${o.nfl_reserve??'–'}). <button class="btn" style="margin-left:6px" onclick="this.parentNode.remove();sessionStorage.ps_nhl_nob=1">Dismiss</button></div>`;
  el.innerHTML=h;
}
function viewData(){
  const st=S.status||{}, o=st.odds||{};
  return `<h1>Data status · NHL</h1>
  <div class="kv"><div><span>Last refresh</span><b style="font-size:14px">${fmtDT(st.updated)}</b><span>${ago(st.updated)}</span></div>
  <div><span>Season</span><b>${st.season?st.season+'-'+String(st.season+1).slice(2):'–'}</b></div><div><span>Players</span><b>${st.players||'–'}</b></div><div><span>Game rows</span><b>${st.rows||'–'}</b></div>
  <div><span>Games on slate</span><b>${st.upcoming??'–'}</b></div><div><span>Odds credits left (shared)</span><b>${o.remaining??'–'}</b><span>of 500/month</span></div>
  <div><span>NHL credits this month</span><b>${o.nhl_used??0} / ${o.nhl_cap??'–'}</b><span>NFL reserve ${o.nfl_reserve??'–'}</span></div><div><span>Lines updated</span><b style="font-size:14px">${o.updated?fmtDT(o.updated):'never'}</b></div></div>
  <h2>Last run log</h2><div class="tbl"><table><tr><th>Source</th><th>Status</th><th>Message</th></tr>${(st.log||[]).map(l=>`<tr><td>${esc(l.source)}</td><td><span class="pill ${l.status==='ok'?'g':l.status==='error'?'r':'a'}">${esc(l.status)}</span></td><td style="text-align:left;white-space:normal">${esc(l.message)}</td></tr>`).join('')}</table></div>
  <h2>Sources</h2><div class="card small">
   <p><b>Stats, schedule, rosters</b> — NHL public API (api-web.nhle.com): every boxscore of ${(st.season||2026)-1}-${String(st.season||2026).slice(2)} and this season (goals, assists, points, shots, TOI, PP goals, blocks, hits, PIM; goalie saves, shots against, goals against), plus PP points from player game logs.</p>
   <p><b>Injuries</b> — ESPN NHL injuries feed. Key players = top-6 F / top-4 D by TOI, starting G by starts, PP1 by PP points.</p>
   <p><b>Betting splits</b> — DraftKings' free public splits page (NHL moneyline, puck line, total). No free source has player-prop splits.</p>
   <p><b>Prop lines</b> — The Odds API, shots on goal + points only (2 credits/game), fetched once per game within ~8h of puck drop, marquee games first, only from credits the NFL slate won't need this month (cap ${o.nhl_cap??60}/month). Everything else uses model lines.</p>
   <p><b>Refresh schedule</b> — about 7 AM, 1 PM and 6 PM ET daily.</p></div>`;
}
const _viewHome = viewHome;
viewHome = () => _viewHome().replace(/Then a <b>key-injury adjustment<\/b>[\s\S]*?−6 if he himself is Questionable\./,
  'Then a <b>key-injury adjustment</b> (capped ±12): +2 per top-6 F / top-4 D teammate out (more TOI), −1.5 more if that teammate is on PP1, +5 when the opposing starting goalie is out, +2.5 per opposing top-4 D out; for goalie props −2 per opposing top-6 F out and +2.5 per own top-4 D out. Day-To-Day/Questionable count 40%, only fresh absences count, −6 if he himself is Day-To-Day.')
  .replace('Players listed Out/Doubtful/IR, players who missed their team\'s last two games, and games already started are excluded.','Players listed Out/IR, players who missed their team\'s last two games, and games already started are excluded.');
Object.assign(DS, {pos:'F', sort:'sog'});
/* 0.5 model lines (points/goals/assists/blocks) are lopsided and their real price would be heavily juiced,
   so without a book line only the Over side is ranked. */
const _buildBoard = buildBoard;
buildBoard = () => { _buildBoard(); for(const r of S.board){ if(r.src==='model' && r.line===0.5 && r.under){ r.under=null; r.best=r.over; } } };
/* matchup hooks: opposing goalie quality (save% of the likely starter) and rest / back-to-backs */
S.matchSpecial = (a,p) => {
  if(p.pos==='G' || !['goals','points','assists','ppp'].includes(a.m) || !a.opp) return null;
  const g=probableG(a.opp).find(x=>!(x.inj&&BAD_STATUS.test(x.inj.status))); if(!g||g.svp==null||g.gp<2) return null;
  return {label:'Opposing goalie', part:.5+(.900-g.svp)*8, txt:`${g.p.name} likely in net, SV% ${g.svp.toFixed(3).slice(1)} (GSAx isn't in any free feed)`};
};
function playedDayBefore(team, date){
  const d=new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()-1); const y=d.toISOString().slice(0,10);
  return S.games.games.some(g=>g.date===y && (g.home===team||g.away===team));
}
S.matchRest = (a,p) => {
  const st=S.slateTeam[p.team]; if(!st) return null; const date=st.g.date;
  const own=playedDayBefore(p.team,date), opp=playedDayBefore(st.opp,date); if(!own&&!opp) return null;
  let adj=0, t=[]; if(own){ adj-=.08; t.push(`${p.team} on a back-to-back${p.pos==='G'?' (backup goalie often starts)':''}`); }
  if(opp){ adj+=.06; t.push(`${st.opp} on a back-to-back`); }
  return {adj, txt:t.join(', ')};
};

/* bar-chart popover stat lines */
statLine = (g, p, m) => {
  const n=x=>x??0, mmss=t=>t==null?'–':Math.floor(t)+':'+String(Math.round((t%1)*60)).padStart(2,'0');
  if(p.pos==='G') return [['Goalie', `${n(g.saves)} SV / ${n(g.sa)} SA · ${n(g.ga)} GA · ${g.sa?(g.saves/g.sa).toFixed(3).slice(1):'–'} SV% · ${mmss(g.toi)} TOI${g.start?' · started':''}${g.win?' · W':''}`]];
  return [['Skater', `${n(g.sog)} SOG · ${n(g.goals)} G · ${n(g.assists)} A · ${n(g.points)} P · ${mmss(g.toi)} TOI`],
          ['Also', `${n(g.ppg)} PPG · ${n(g.ppp)} PPP · ${n(g.blk)} BLK · ${n(g.hits)} HIT · ${n(g.pim)} PIM`]];
};
