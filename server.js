const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { leaders: [], chat: [{name:'Sistema', text:'Chat global online activo.'}], players: {}, teams: {} }; }
}
let db = loadData();
db.leaders ||= [];
db.chat ||= [];
db.players ||= {};
db.teams ||= {};
const matches = {};

function saveData(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }catch(e){} }
function publicTeams(){
  const out = {};
  for(const [code,t] of Object.entries(db.teams)){
    out[code] = { code:t.code, mode:t.mode, leader:t.leader, max:t.max, started: !!t.started, matchId:t.match?.matchId || null, members:(t.members || []).map(m => m.name || String(m)) };
  }
  return out;
}
function state(){ return { leaders: db.leaders.slice(0,10), chat: db.chat.slice(-40), teams: publicTeams() }; }
function emitState(){ io.emit('state', state()); saveData(); }
function cleanName(name){ return String(name||'Jugador').replace(/[<>]/g,'').trim().slice(0,14) || 'Jugador'; }
function cleanText(text){ return String(text||'').replace(/[<>]/g,'').trim().slice(0,120); }
function findTeamBySocket(socketId){
  for(const [code,t] of Object.entries(db.teams)){
    if((t.members||[]).some(m=>m.socketId===socketId)) return {code,t};
  }
  return null;
}
function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do { code=''; for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)]; }
  while(db.teams[code]);
  return code;
}
function rng(seed){ let s=seed>>>0; return ()=>((s=(s*1664525+1013904223)>>>0)/4294967296); }
const weapons={
  pistol:{dmg:24,rate:260,bullets:1}, smg:{dmg:15,rate:75,bullets:1}, rifle:{dmg:26,rate:120,bullets:1},
  shotgun:{dmg:19,rate:560,bullets:6}, ak:{dmg:34,rate:155,bullets:1}, laser:{dmg:42,rate:210,bullets:1},
  rpg:{dmg:120,rate:950,bullets:1}, minigun:{dmg:12,rate:45,bullets:1}
};
function clamp(v,a,b){ return Math.max(a, Math.min(b, Number(v)||0)); }
function spawnOne(match,boss=false){
  const r = match.rand;
  const edge = Math.floor(r()*4);
  const x = edge<2 ? r() : (edge===2 ? -0.06 : 1.06);
  const y = edge>=2 ? r() : (edge===0 ? -0.06 : 1.06);
  const hp = boss ? 220 + match.wave*38 : 24 + match.wave*4;
  match.zombies.push({ id:'z'+(match.nextZ++), x,y,hp,max:hp,boss, r: boss?0.032:0.017, s: boss?0.00095:(0.0016+r()*0.0007), lastFire:0 });
}
function spawnWave(match){
  match.zombies = [];
  match.bossShots = [];
  const boss = match.wave % 3 === 0;
  const n = 5 + match.wave*2;
  for(let i=0;i<n;i++) spawnOne(match,false);
  if(boss) spawnOne(match,true);
}
function createMatch(team){
  const seed = Math.floor(Math.random()*2147483647);
  const matchId = 'MATCH-' + team.code + '-' + Date.now().toString(36).toUpperCase();
  const match = { matchId, teamCode:team.code, mode:team.mode, seed, rand:rng(seed), wave:1, createdAt:Date.now(), nextZ:1, nextB:1, zombies:[], bullets:[], bossShots:[], players:{}, lastBroadcast:0 };
  const spots = [{x:.50,y:.50},{x:.54,y:.50},{x:.46,y:.50},{x:.50,y:.54}];
  (team.members||[]).forEach((m,i)=>{ match.players[m.socketId]={ id:m.socketId, name:m.name, x:spots[i]?.x||.5, y:spots[i]?.y||.5, hp:100, maxHp:100, weapon:'pistol', kills:0, coins:0, alive:true, aimX:.8, aimY:.5, lastShot:0 }; });
  spawnWave(match);
  matches[matchId]=match;
  return match;
}
function compactMatch(match){
  return {
    matchId:match.matchId, teamCode:match.teamCode, wave:match.wave,
    players:Object.values(match.players).map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,weapon:p.weapon,kills:p.kills,coins:p.coins,alive:p.alive})),
    zombies:match.zombies.map(z=>({id:z.id,x:z.x,y:z.y,hp:z.hp,max:z.max,boss:z.boss,r:z.r})),
    bullets:match.bullets.map(b=>({id:b.id,x:b.x,y:b.y,r:b.r||0.005})),
    bossShots:match.bossShots.map(b=>({id:b.id,x:b.x,y:b.y})),
    time:Date.now()
  };
}
function submitScore(name,kills,coins,wave){
  name=cleanName(name); kills=Math.max(0,Math.floor(kills||0)); coins=Math.max(0,Math.floor(coins||0)); wave=Math.max(1,Math.floor(wave||1));
  if(kills<=0) return;
  const existing=db.leaders.find(x=>x.name===name);
  if(existing){ if(kills>existing.kills){ existing.kills=kills; existing.coins=coins; existing.wave=wave; existing.updated=Date.now(); } }
  else db.leaders.push({name,kills,coins,wave,updated:Date.now()});
  db.leaders.sort((a,b)=>b.kills-a.kills); db.leaders=db.leaders.slice(0,10);
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  socket.emit('state', state());

  socket.on('player:update', p => {
    const name = cleanName(p.name);
    socket.data.name = socket.data.name || name;
    db.players[socket.id] = { name: socket.data.name, coins: Number(p.coins||0), kills: Number(p.kills||0), bestWave: Number(p.bestWave||0), online: true };
    socket.emit('profile:locked', socket.data.name);
    emitState();
  });

  socket.on('chat:send', msg => {
    const name = cleanName(socket.data.name || msg.name);
    const text = cleanText(msg.text);
    if(!text) return;
    db.chat.push({ name, text, time: Date.now() });
    db.chat = db.chat.slice(-80);
    emitState();
  });

  socket.on('team:create', ({mode}) => {
    const name = cleanName(socket.data.name);
    const current = findTeamBySocket(socket.id);
    if(current) return socket.emit('toast', 'Ya estás en un equipo. Sal primero para crear otro.');
    mode = ['SOLO','DUO','ESCUADRA'].includes(mode) ? mode : 'DUO';
    const max = mode === 'SOLO' ? 1 : (mode === 'DUO' ? 2 : 4);
    const code = makeCode();
    const team = { code, mode, max, leader:name, leaderSocket:socket.id, members:[{name, socketId:socket.id}] };
    db.teams[code] = team;
    socket.join(code);
    socket.emit('team:joined', publicTeams()[code]);
    socket.emit('toast', 'Equipo creado. Código: '+code);
    emitState();
  });

  socket.on('team:join', ({code}) => {
    code = String(code||'').trim().toUpperCase();
    const current = findTeamBySocket(socket.id);
    if(current && current.code !== code) return socket.emit('toast', 'Ya estás en un equipo. Sal primero para unirte a otro.');
    const team = db.teams[code];
    const name = cleanName(socket.data.name);
    if(!team) return socket.emit('toast', 'Ese código no existe');
    if(team.started) return socket.emit('toast', 'La partida ya inició');
    if(team.members.length >= team.max && !team.members.some(m=>m.socketId===socket.id)) return socket.emit('toast', 'Equipo lleno');
    if(!team.members.some(m=>m.socketId===socket.id)) team.members.push({name, socketId:socket.id});
    socket.join(code);
    io.to(code).emit('team:joined', publicTeams()[code]);
    emitState();
  });

  socket.on('team:start', ({code}) => {
    code = String(code||'').trim().toUpperCase();
    const team = db.teams[code];
    if(!team) return socket.emit('toast', 'Ese equipo ya no existe');
    if(team.leaderSocket !== socket.id) return socket.emit('toast', 'Solo el líder puede iniciar la partida');
    const match = createMatch(team);
    team.started = true;
    team.match = { matchId:match.matchId, teamCode:code, mode:team.mode, seed:match.seed, wave:1, members:(team.members||[]).map(m=>m.name) };
    io.to(code).emit('match:start', team.match);
    io.to(code).emit('match:state', compactMatch(match));
    emitState();
  });

  socket.on('team:leave', ({code}) => leaveTeam(socket, code, true));

  socket.on('match:input', p => {
    const matchId=String(p?.matchId||''); const match=matches[matchId]; if(!match) return;
    const player=match.players[socket.id]; if(!player || !player.alive) return;
    player.x=clamp(p.x,.02,.98); player.y=clamp(p.y,.08,.98); player.weapon=String(p.weapon||'pistol').slice(0,20);
    player.aimX=clamp(p.aimX,0,1); player.aimY=clamp(p.aimY,0,1);
    if(p.shooting) fireBullet(match, player);
  });

  socket.on('score:submit', s => { submitScore(socket.data.name||s.name, s.kills, s.coins, s.wave); emitState(); });

  socket.on('disconnect', () => {
    delete db.players[socket.id];
    for(const code of Object.keys(db.teams)) leaveTeam(socket, code, false);
    emitState();
  });
});

function fireBullet(match,p){
  const w=weapons[p.weapon]||weapons.pistol;
  const now=Date.now();
  if(now-(p.lastShot||0)<w.rate) return;
  p.lastShot=now;
  const a=Math.atan2(p.aimY-p.y,p.aimX-p.x);
  for(let i=0;i<w.bullets;i++){
    const spread=(i-(w.bullets-1)/2)*0.13;
    match.bullets.push({ id:'b'+(match.nextB++), owner:p.id, x:p.x, y:p.y, vx:Math.cos(a+spread)*0.018, vy:Math.sin(a+spread)*0.018, dmg:w.dmg, life:70, r:p.weapon==='rpg'?0.010:0.005 });
  }
}
function tickMatch(match){
  const alive=Object.values(match.players).filter(p=>p.alive);
  if(alive.length===0) return;
  for(const b of match.bullets){ b.x+=b.vx; b.y+=b.vy; b.life--; }
  match.bullets=match.bullets.filter(b=>b.life>0&&b.x>-0.1&&b.y>-0.1&&b.x<1.1&&b.y<1.1);
  for(const b of match.bossShots){ b.x+=b.vx; b.y+=b.vy; b.life--; for(const p of alive){ if(Math.hypot(p.x-b.x,p.y-b.y)<0.028){ p.hp-=Math.min(4+match.wave*.45,13); b.life=0; if(p.hp<=0){p.hp=0;p.alive=false;} } } }
  match.bossShots=match.bossShots.filter(b=>b.life>0);
  for(const z of match.zombies){
    let target=alive[0], best=999;
    for(const p of alive){ const d=Math.hypot(p.x-z.x,p.y-z.y); if(d<best){best=d;target=p;} }
    if(target){
      const a=Math.atan2(target.y-z.y,target.x-z.x); z.x+=Math.cos(a)*z.s; z.y+=Math.sin(a)*z.s;
      if(z.boss && Date.now()-(z.lastFire||0)>1150){ z.lastFire=Date.now(); match.bossShots.push({id:'bs'+(match.nextB++),x:z.x,y:z.y,vx:Math.cos(a)*0.007,vy:Math.sin(a)*0.007,life:160}); }
      if(best<z.r+0.020){ const dmg=z.boss?Math.min(.22+match.wave*.025,.62):Math.min(.22+match.wave*.008,.38); target.hp-=dmg; if(target.hp<=0){target.hp=0;target.alive=false;} z.x-=Math.cos(a)*0.012; z.y-=Math.sin(a)*0.012; }
    }
  }
  for(const b of match.bullets){
    if(b.life<=0) continue;
    for(const z of match.zombies){
      if(z.hp>0 && Math.hypot(b.x-z.x,b.y-z.y)<z.r+(b.r||0.005)){
        z.hp-=b.dmg; b.life=0;
        if(z.hp<=0){
          const p=match.players[b.owner]; if(p){ p.kills++; const earn=z.boss?Math.min(45+match.wave*3,95):Math.min(6+Math.floor(match.wave/3)*2,18); p.coins+=earn; }
        }
        break;
      }
    }
  }
  match.bullets=match.bullets.filter(b=>b.life>0);
  match.zombies=match.zombies.filter(z=>z.hp>0);
  if(match.zombies.length===0){ match.wave++; spawnWave(match); }
}
setInterval(()=>{
  for(const match of Object.values(matches)){
    tickMatch(match);
    io.to(match.teamCode).emit('match:state', compactMatch(match));
  }
}, 50);

function leaveTeam(socket, code, notify){
  code = String(code||'').trim().toUpperCase();
  const team = db.teams[code];
  if(!team) return;
  if(team.leaderSocket === socket.id){
    io.to(code).emit('team:closed', 'El líder salió: equipo cerrado');
    if(team.match?.matchId) delete matches[team.match.matchId];
    delete db.teams[code];
  } else {
    team.members = (team.members||[]).filter(m => m.socketId !== socket.id);
    if(team.match?.matchId && matches[team.match.matchId]) delete matches[team.match.matchId].players[socket.id];
    socket.leave(code);
    if(notify) socket.emit('team:closed', 'Saliste del equipo');
    io.to(code).emit('team:joined', publicTeams()[code]);
  }
}

server.listen(PORT, () => console.log(`ANTIDOTE SURVIVAL ONLINE listo en http://localhost:${PORT}`));
