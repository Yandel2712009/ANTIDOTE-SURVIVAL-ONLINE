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
  catch { return { leaders: [], chat: [{name:'Sistema', text:'ANTIDOTE ONLINE activo.'}], players: {}, teams: {} }; }
}
let db = loadData();
db.leaders ||= [];
db.chat ||= [];
db.players ||= {};
db.teams ||= {};
const matches = {};

const weapons = {
  pistol:{name:'Pistola',dmg:24,rate:230,bullets:1,speed:.044},
  smg:{name:'SMG',dmg:15,rate:70,bullets:1,speed:.046},
  rifle:{name:'Rifle',dmg:28,rate:120,bullets:1,speed:.048},
  shotgun:{name:'Escopeta',dmg:18,rate:500,bullets:6,speed:.043,spread:.16},
  ak:{name:'AK Roja',dmg:34,rate:135,bullets:1,speed:.048},
  laser:{name:'Láser',dmg:42,rate:190,bullets:1,speed:.052},
  rpg:{name:'RPG',dmg:120,rate:850,bullets:1,speed:.032,r:.012},
  minigun:{name:'Minigun',dmg:12,rate:42,bullets:1,speed:.050}
};
function save(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }catch(e){} }
function cleanName(v){ return String(v||'Jugador').replace(/[<>]/g,'').trim().slice(0,14) || 'Jugador'; }
function cleanText(v){ return String(v||'').replace(/[<>]/g,'').trim().slice(0,120); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, Number(v)||0)); }
function code(){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c=''; do{c=''; for(let i=0;i<6;i++) c+=chars[Math.floor(Math.random()*chars.length)];}while(db.teams[c]); return c; }
function findTeamBySocket(id){ for(const [c,t] of Object.entries(db.teams)){ if((t.members||[]).some(m=>m.socketId===id)) return {code:c, team:t}; } return null; }
function publicTeams(){
  const out={};
  for(const [c,t] of Object.entries(db.teams)) out[c]={code:c,mode:t.mode,max:t.max,leader:t.leader,leaderSocket:t.leaderSocket,started:!!t.started,matchId:t.matchId||null,members:(t.members||[]).map(m=>m.name)};
  return out;
}
function state(){ return { leaders: db.leaders.slice(0,10), chat: db.chat.slice(-50), teams: publicTeams() }; }
function emitState(){ io.emit('state', state()); save(); }
function rng(seed){ let s=seed>>>0; return ()=>((s=(s*1664525+1013904223)>>>0)/4294967296); }
function submitScore(name,kills,coins,wave){
  name=cleanName(name); kills=Math.floor(kills||0); coins=Math.floor(coins||0); wave=Math.floor(wave||1);
  if(kills<=0) return;
  const old=db.leaders.find(p=>p.name===name);
  if(old){ if(kills>old.kills){ old.kills=kills; old.coins=coins; old.wave=wave; old.updated=Date.now(); } }
  else db.leaders.push({name,kills,coins,wave,updated:Date.now()});
  db.leaders.sort((a,b)=>b.kills-a.kills); db.leaders=db.leaders.slice(0,10);
}

function createMatch(team){
  const seed = Math.floor(Math.random()*2147483647);
  const matchId = 'M-' + team.code + '-' + Date.now().toString(36).toUpperCase();
  const match = { matchId, teamCode:team.code, mode:team.mode, seed, rand:rng(seed), wave:1, nextZ:1, nextB:1, nextShot:1, createdAt:Date.now(), players:{}, zombies:[], bullets:[], bossShots:[], ended:false };
  const spots=[{x:.50,y:.50},{x:.54,y:.50},{x:.46,y:.50},{x:.50,y:.54}];
  (team.members||[]).forEach((m,i)=>{
    match.players[m.socketId]={id:m.socketId,name:m.name,x:spots[i]?.x||.5,y:spots[i]?.y||.5,hp:100,maxHp:100,weapon:'pistol',kills:0,coins:0,alive:true,aimX:.8,aimY:.5,lastFire:0,shooting:false};
  });
  spawnWave(match);
  matches[matchId]=match;
  team.started=true; team.matchId=matchId;
  return match;
}
function spawnZombie(match,boss=false){
  const r=match.rand, edge=Math.floor(r()*4);
  const x=edge<2?r():(edge===2?-.06:1.06);
  const y=edge>=2?r():(edge===0?-.06:1.06);
  const hp=boss?240+match.wave*45:28+match.wave*5;
  match.zombies.push({id:'z'+(match.nextZ++),x,y,hp,max:hp,boss,r:boss?.033:.018,s:boss?.00115:(.00185+r()*.00065),lastFire:0});
}
function spawnWave(match){
  match.zombies=[]; match.bossShots=[]; match.bullets=[];
  const n=5+match.wave*2;
  for(let i=0;i<n;i++) spawnZombie(match,false);
  if(match.wave%3===0) spawnZombie(match,true);
}
function compact(match){
  return {
    matchId:match.matchId, teamCode:match.teamCode, wave:match.wave, seed:match.seed,
    players:Object.values(match.players).map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,weapon:p.weapon,kills:p.kills,coins:p.coins,alive:p.alive})),
    zombies:match.zombies.map(z=>({id:z.id,x:z.x,y:z.y,hp:z.hp,max:z.max,boss:z.boss,r:z.r})),
    bullets:match.bullets.map(b=>({id:b.id,x:b.x,y:b.y,r:b.r||.005,owner:b.owner})),
    bossShots:match.bossShots.map(b=>({id:b.id,x:b.x,y:b.y})),
    time:Date.now()
  };
}
function fire(match,p){
  const w=weapons[p.weapon]||weapons.pistol;
  const now=Date.now();
  if(now-(p.lastFire||0)<w.rate) return;
  p.lastFire=now;
  const a=Math.atan2(p.aimY-p.y,p.aimX-p.x);
  const bullets=w.bullets||1, spread=w.spread||.13;
  for(let i=0;i<bullets;i++){
    const off=(i-(bullets-1)/2)*spread;
    match.bullets.push({id:'b'+(match.nextB++),owner:p.id,x:p.x,y:p.y,vx:Math.cos(a+off)*(w.speed||.022),vy:Math.sin(a+off)*(w.speed||.022),dmg:w.dmg,life:80,r:w.r||.005});
  }
}
function tick(match){
  if(match.ended) return;
  const alive=Object.values(match.players).filter(p=>p.alive);
  if(alive.length===0){
    match.ended=true;
    for(const p of Object.values(match.players)) submitScore(p.name,p.kills,p.coins,match.wave);
    emitState();
    return;
  }
  for(const p of alive) if(p.shooting) fire(match,p);

  for(const b of match.bullets){ b.x+=b.vx; b.y+=b.vy; b.life--; }
  match.bullets=match.bullets.filter(b=>b.life>0 && b.x>-.12 && b.y>-.12 && b.x<1.12 && b.y<1.12);

  for(const z of match.zombies){
    let target=alive[0], best=999;
    for(const p of alive){ const d=Math.hypot(p.x-z.x,p.y-z.y); if(d<best){best=d; target=p;} }
    if(!target) continue;
    const a=Math.atan2(target.y-z.y,target.x-z.x);
    z.x+=Math.cos(a)*z.s; z.y+=Math.sin(a)*z.s;
    if(z.boss && Date.now()-(z.lastFire||0)>1250){
      z.lastFire=Date.now();
      match.bossShots.push({id:'bs'+(match.nextShot++),x:z.x,y:z.y,vx:Math.cos(a)*.011,vy:Math.sin(a)*.011,life:155});
    }
    if(best<z.r+.022){
      const dmg=z.boss?Math.min(.18+match.wave*.018,.45):Math.min(.12+match.wave*.006,.28);
      target.hp-=dmg;
      z.x-=Math.cos(a)*.01; z.y-=Math.sin(a)*.01;
      if(target.hp<=0){ target.hp=0; target.alive=false; submitScore(target.name,target.kills,target.coins,match.wave); }
    }
  }
  for(const s of match.bossShots){
    s.x+=s.vx; s.y+=s.vy; s.life--;
    for(const p of alive){
      if(p.alive && Math.hypot(p.x-s.x,p.y-s.y)<.026){
        const dmg=Math.min(3.5+match.wave*.35,10);
        p.hp-=dmg; s.life=0;
        if(p.hp<=0){ p.hp=0; p.alive=false; submitScore(p.name,p.kills,p.coins,match.wave); }
      }
    }
  }
  match.bossShots=match.bossShots.filter(s=>s.life>0 && s.x>-.08 && s.y>-.08 && s.x<1.08 && s.y<1.08);

  for(const b of match.bullets){
    if(b.life<=0) continue;
    for(const z of match.zombies){
      if(z.hp>0 && Math.hypot(b.x-z.x,b.y-z.y)<z.r+(b.r||.005)){
        z.hp-=b.dmg; b.life=0;
        if(z.hp<=0){
          const p=match.players[b.owner];
          if(p){ p.kills++; const earn=z.boss?Math.min(35+match.wave*2,70):Math.min(4+Math.floor(match.wave/4)*2,12); p.coins+=earn; }
        }
        break;
      }
    }
  }
  match.bullets=match.bullets.filter(b=>b.life>0);
  match.zombies=match.zombies.filter(z=>z.hp>0);
  if(match.zombies.length===0){ match.wave++; spawnWave(match); io.to(match.teamCode).emit('toast','🌊 Oleada '+match.wave); }
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket=>{
  socket.emit('state', state());
  socket.on('player:update', p=>{
    const name=cleanName(p.name);
    if(!socket.data.name) socket.data.name=name;
    db.players[socket.id]={name:socket.data.name,online:true};
    socket.emit('profile:locked', socket.data.name);
    emitState();
  });
  socket.on('chat:send', msg=>{
    const text=cleanText(msg.text); if(!text) return;
    const name=cleanName(socket.data.name || msg.name);
    db.chat.push({name,text,time:Date.now()}); db.chat=db.chat.slice(-80); emitState();
  });
  socket.on('team:create', ({mode})=>{
    const current=findTeamBySocket(socket.id);
    if(current) return socket.emit('toast','Ya estás en un equipo. Sal primero.');
    mode=['SOLO','DUO','ESCUADRA'].includes(mode)?mode:'DUO';
    const max=mode==='SOLO'?1:(mode==='DUO'?2:4);
    const name=cleanName(socket.data.name);
    const c=code();
    db.teams[c]={code:c,mode,max,leader:name,leaderSocket:socket.id,members:[{name,socketId:socket.id}],started:false,matchId:null};
    socket.join(c);
    io.to(c).emit('team:joined', publicTeams()[c]);
    socket.emit('toast','Equipo creado: '+c);
    emitState();
  });
  socket.on('team:join', ({code:c})=>{
    c=String(c||'').trim().toUpperCase();
    const current=findTeamBySocket(socket.id);
    if(current && current.code!==c) return socket.emit('toast','Ya estás en un equipo. Sal primero.');
    const team=db.teams[c];
    if(!team) return socket.emit('toast','Ese código no existe');
    if(team.started) return socket.emit('toast','La partida ya inició');
    if(team.members.length>=team.max && !team.members.some(m=>m.socketId===socket.id)) return socket.emit('toast','Equipo lleno');
    const name=cleanName(socket.data.name);
    if(!team.members.some(m=>m.socketId===socket.id)) team.members.push({name,socketId:socket.id});
    socket.join(c);
    io.to(c).emit('team:joined', publicTeams()[c]);
    emitState();
  });
  socket.on('team:start', ({code:c})=>{
    c=String(c||'').trim().toUpperCase();
    const team=db.teams[c];
    if(!team) return socket.emit('toast','Ese equipo no existe');
    if(team.leaderSocket!==socket.id) return socket.emit('toast','Solo el líder inicia');
    if(team.started && team.matchId && matches[team.matchId]) return io.to(c).emit('match:start',{matchId:team.matchId,teamCode:c,mode:team.mode,seed:matches[team.matchId].seed,members:team.members.map(m=>m.name)});
    const match=createMatch(team);
    const payload={matchId:match.matchId,teamCode:c,mode:team.mode,seed:match.seed,members:team.members.map(m=>m.name)};
    io.to(c).emit('match:start', payload);
    io.to(c).emit('match:state', compact(match));
    emitState();
  });
  socket.on('solo:start', ()=>{
    const name=cleanName(socket.data.name);
    const c='SOLO'+socket.id.slice(0,4).toUpperCase()+Date.now().toString(36).slice(-3).toUpperCase();
    db.teams[c]={code:c,mode:'SOLO',max:1,leader:name,leaderSocket:socket.id,members:[{name,socketId:socket.id}],started:false,matchId:null};
    socket.join(c);
    const match=createMatch(db.teams[c]);
    socket.emit('match:start',{matchId:match.matchId,teamCode:c,mode:'SOLO',seed:match.seed,members:[name]});
    socket.emit('match:state', compact(match));
  });
  socket.on('team:leave', ({code:c})=>leaveTeam(socket,c,true));
  socket.on('match:input', input=>{
    const match=matches[String(input?.matchId||'')]; if(!match) return;
    const p=match.players[socket.id]; if(!p || !p.alive) return;
    p.x=clamp(input.x,.02,.98); p.y=clamp(input.y,.08,.98);
    p.aimX=clamp(input.aimX,0,1); p.aimY=clamp(input.aimY,0,1);
    p.weapon=String(input.weapon||'pistol').slice(0,20);
    p.shooting=!!input.shooting;
  });
  socket.on('score:submit', s=>{ submitScore(cleanName(socket.data.name||s.name),s.kills,s.coins,s.wave); emitState(); });
  socket.on('disconnect', ()=>{
    delete db.players[socket.id];
    for(const c of Object.keys(db.teams)) leaveTeam(socket,c,false);
    emitState();
  });
});
function leaveTeam(socket,c,notify){
  c=String(c||'').trim().toUpperCase(); const team=db.teams[c]; if(!team) return;
  if(team.leaderSocket===socket.id){
    io.to(c).emit('team:closed','El líder salió: equipo cerrado');
    if(team.matchId) delete matches[team.matchId];
    delete db.teams[c];
  }else{
    team.members=(team.members||[]).filter(m=>m.socketId!==socket.id);
    if(team.matchId && matches[team.matchId]) delete matches[team.matchId].players[socket.id];
    socket.leave(c);
    if(notify) socket.emit('team:closed','Saliste del equipo');
    io.to(c).emit('team:joined', publicTeams()[c]);
  }
}
setInterval(()=>{
  for(const match of Object.values(matches)){
    tick(match);
    io.to(match.teamCode).emit('match:state', compact(match));
  }
}, 33);
server.listen(PORT, ()=>console.log(`ANTIDOTE SURVIVAL ONLINE listo en http://localhost:${PORT}`));
