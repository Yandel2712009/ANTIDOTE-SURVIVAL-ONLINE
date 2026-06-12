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

function saveData(){ fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
function publicTeams(){
  const out = {};
  for(const [code,t] of Object.entries(db.teams)){
    out[code] = { code:t.code, mode:t.mode, leader:t.leader, max:t.max, members:t.members || [] };
  }
  return out;
}
function state(){ return { leaders: db.leaders.slice(0,10), chat: db.chat.slice(-40), teams: publicTeams() }; }
function emitState(){ io.emit('state', state()); saveData(); }
function cleanName(name){ return String(name||'Jugador').replace(/[<>]/g,'').trim().slice(0,14) || 'Jugador'; }
function cleanText(text){ return String(text||'').replace(/[<>]/g,'').trim().slice(0,120); }
function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do { code=''; for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)]; }
  while(db.teams[code]);
  return code;
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
    mode = ['SOLO','DUO','ESCUADRA'].includes(mode) ? mode : 'DUO';
    const max = mode === 'SOLO' ? 1 : (mode === 'DUO' ? 2 : 4);
    // Si ya era líder de otro equipo, cerrarlo.
    for(const [code,t] of Object.entries(db.teams)){
      if(t.leaderSocket === socket.id) delete db.teams[code];
      else t.members = (t.members||[]).filter(m => m.socketId !== socket.id);
    }
    const code = makeCode();
    const team = { code, mode, max, leader:name, leaderSocket:socket.id, members:[{name, socketId:socket.id}] };
    db.teams[code] = team;
    socket.join(code);
    socket.emit('team:joined', publicTeams()[code]);
    emitState();
  });

  socket.on('team:join', ({code}) => {
    code = String(code||'').trim().toUpperCase();
    const team = db.teams[code];
    const name = cleanName(socket.data.name);
    if(!team) return socket.emit('toast', 'Ese código no existe');
    if(team.members.length >= team.max && !team.members.some(m=>m.socketId===socket.id)) return socket.emit('toast', 'Equipo lleno');
    if(!team.members.some(m=>m.socketId===socket.id)) team.members.push({name, socketId:socket.id});
    socket.join(code);
    io.to(code).emit('team:joined', publicTeams()[code]);
    emitState();
  });

  socket.on('team:leave', ({code}) => leaveTeam(socket, code, true));

  socket.on('score:submit', s => {
    const name = cleanName(socket.data.name || s.name);
    const kills = Math.max(0, Math.floor(Number(s.kills||0)));
    const coins = Math.max(0, Math.floor(Number(s.coins||0)));
    const wave = Math.max(1, Math.floor(Number(s.wave||1)));
    if(kills <= 0) return;
    const existing = db.leaders.find(x => x.name === name);
    if(existing){
      if(kills > existing.kills){ existing.kills = kills; existing.coins = coins; existing.wave = wave; existing.updated = Date.now(); }
    } else {
      db.leaders.push({ name, kills, coins, wave, updated: Date.now() });
    }
    db.leaders.sort((a,b)=>b.kills-a.kills);
    db.leaders = db.leaders.slice(0,10);
    emitState();
  });

  socket.on('disconnect', () => {
    delete db.players[socket.id];
    for(const code of Object.keys(db.teams)) leaveTeam(socket, code, false);
    emitState();
  });
});

function leaveTeam(socket, code, notify){
  code = String(code||'').trim().toUpperCase();
  const team = db.teams[code];
  if(!team) return;
  if(team.leaderSocket === socket.id){
    io.to(code).emit('team:closed', 'El líder salió: equipo cerrado');
    delete db.teams[code];
  } else {
    team.members = (team.members||[]).filter(m => m.socketId !== socket.id);
    socket.leave(code);
    if(notify) socket.emit('team:closed', 'Saliste del equipo');
    io.to(code).emit('team:joined', publicTeams()[code]);
  }
}

server.listen(PORT, () => console.log(`ANTIDOTE SURVIVAL ONLINE listo en http://localhost:${PORT}`));
