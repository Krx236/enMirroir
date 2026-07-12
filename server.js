// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public')); // Sert le fichier index.html

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // Autorise toutes les connexions pour les tests
});

// Stockage en mémoire des salons
const rooms = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`Nouveau joueur connecté : ${socket.id}`);

  // --- CRÉATION DE SALON ---
  socket.on('createRoom', (playerName) => {
    if (!playerName) return;
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    rooms.set(code, {
      id: code,
      players: [],
      turnQueue: [],
      turnIndex: 0,
      count: 10,
      isStarted: false
    });

    socket.join(code);
    rooms.get(code).players.push({
      id: socket.id,
      name: playerName,
      score: 0,
      shield: true,
      boomerang: true,
      questions: [],
      ready: false
    });

    socket.emit('roomCreated', { code, playerIndex: 0 });
    console.log(`Salon ${code} créé par ${playerName}`);
  });

  // --- REJOINDRE UN SALON ---
  socket.on('joinRoom', ({ code, playerName }) => {
    const roomCode = code.trim().toUpperCase();
    const room = rooms.get(roomCode);
    
    if (!room) return socket.emit('error', 'Salon introuvable.');
    if (room.players.length >= 2) return socket.emit('error', 'Le salon est plein.');
    if (room.isStarted) return socket.emit('error', 'La partie a déjà commencé.');

    socket.join(roomCode);
    room.players.push({
      id: socket.id,
      name: playerName,
      score: 0,
      shield: true,
      boomerang: true,
      questions: [],
      ready: false
    });

    const playerIndex = 1;
    socket.emit('roomJoined', { 
      playerIndex, 
      hostName: room.players[0].name,
      count: room.count 
    });
    
    // Prévenir l'hôte que quelqu'un a rejoint
    socket.to(roomCode).emit('playerJoined', { name: playerName });
    console.log(`${playerName} a rejoint le salon ${roomCode}`);
  });

  // --- CONFIGURATION (NOMBRE DE QUESTIONS) ---
  socket.on('setConfig', ({ code, count }) => {
    const room = rooms.get(code);
    if (room && room.players[0].id === socket.id) {
      room.count = count;
      socket.to(code).emit('configUpdated', { count });
    }
  });

  // --- ENVOI DES QUESTIONS ---
  socket.on('submitQuestions', ({ code, questions }) => {
    const room = rooms.get(code);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.questions = questions;
      player.ready = true;
      
      // Prévenir l'autre joueur
      socket.to(code).emit('opponentReady', { name: player.name });

      // Vérifier si les deux sont prêts
      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        startGame(room);
      }
    }
  });

  // --- ACTION DANS LE JEU ---
  socket.on('gameAction', ({ code, action, payload }) => {
    const room = rooms.get(code);
    if (!room || !room.isStarted) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const turn = room.turnQueue[room.turnIndex];
    if (!turn) return;

    // 1. LE RÉPONDANT RÉPOND
    if (action === 'answer') {
      if (playerIndex !== turn.responder) return; // Seul le répondant peut faire ça
      
      if (payload.joker === 'shield') {
        room.players[turn.responder].shield = false;
        io.to(code).emit('turnResult', { type: 'shield', playerIndex: turn.responder });
        advanceTurn(room);
      } 
      else if (payload.joker === 'boomerang') {
        room.players[turn.responder].boomerang = false;
        // Inversion : l'asker devient répondant pour ce tour
        turn.boomerang = true;
        turn.evaluator = turn.responder; // C'est celui qui a lancé le boom qui évalue
        io.to(code).emit('turnResult', { type: 'boomerang' });
      } 
      else {
        // Réponse normale
        io.to(code).emit('turnResult', { type: 'evaluate', evaluatorIndex: turn.asker });
      }
    }

    // 2. L'ÉVALUATEUR ÉVALUE
    else if (action === 'evaluate') {
      let evaluatorIdx;
      if (turn.boomerang) evaluatorIdx = turn.evaluator;
      else evaluatorIdx = turn.asker;
      
      if (playerIndex !== evaluatorIdx) return; // Seul l'évaluateur peut faire ça

      const points = payload.points;
      let scorerIdx;
      if (turn.boomerang) scorerIdx = turn.asker; // L'asker qui a répondu à son boom
      else scorerIdx = turn.responder; // Le répondant normal

      room.players[scorerIdx].score += points;
      
      io.to(code).emit('turnResult', { 
        type: 'scored', 
        points, 
        scorerIndex: scorerIdx, 
        scorerName: room.players[scorerIdx].name 
      });
      
      advanceTurn(room);
    }
  });

  // --- DÉCONNEXION ---
  socket.on('disconnect', () => {
    console.log(`Déconnexion : ${socket.id}`);
    for (const [code, room] of rooms.entries()) {
      const pIndex = room.players.findIndex(p => p.id === socket.id);
      if (pIndex !== -1) {
        socket.to(code).emit('playerDisconnected', { name: room.players[pIndex].name });
        rooms.delete(code); // Détruire le salon si quelqu'un quitte
        break;
      }
    }
  });
});

function startGame(room) {
  room.isStarted = true;
  room.turnQueue = [];
  for (let i = 0; i < room.count; i++) {
    room.turnQueue.push({ asker: 0, responder: 1, qi: i });
    room.turnQueue.push({ asker: 1, responder: 0, qi: i });
  }
  room.turnIndex = 0;
  io.to(room.id).emit('gameStart', { 
    players: room.players.map(p => ({ name: p.name, score: 0, shield: true, boomerang: true })),
    totalTurns: room.turnQueue.length 
  });
}

function advanceTurn(room) {
  room.turnIndex++;
  if (room.turnIndex >= room.turnQueue.length) {
    io.to(room.id).emit('gameOver', { 
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  } else {
    // Petit délai pour laisser l'animation de score se jouer
    setTimeout(() => {
      io.to(room.id).emit('nextTurn', { turnIndex: room.turnIndex });
    }, 1500);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur EnMiroir lancé sur le port ${PORT}`);
});
