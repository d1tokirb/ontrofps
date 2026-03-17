const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // Allows connections from your Vercel/live frontend
        methods: ["GET", "POST"]
    }
});
const path = require('path');

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Keep track of connected players
const players = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Initial structure for new player
    players[socket.id] = {
        id: socket.id,
        name: 'Guest',
        x: 0, 
        y: 10, 
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        hp: 100,
        color: Math.random() * 0xffffff // Random color for fun
    };

    // When a user successfully joins from the main menu
    socket.on('joinGame', (name) => {
        if(name) players[socket.id].name = name;
        
        // Let the new player know about all current players
        socket.emit('initPlayers', players);
        
        // Notify others that a new player joined
        socket.broadcast.emit('playerJoined', players[socket.id]);
        console.log(`Player joined: ${name} (${socket.id})`);
    });

    // Receive movement updates from client
    socket.on('updatePosition', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].rx = data.rx;
            players[socket.id].ry = data.ry;
            players[socket.id].rz = data.rz;
            
            // Broadcast the movement to everyone else
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // Handle being shot
    socket.on('hitPlayer', (data) => {
        const targetId = data.id;
        const damage = data.damage;
        
        if (players[targetId]) {
            players[targetId].hp -= damage;
            io.emit('playerHit', { id: targetId, hp: players[targetId].hp, damage: damage });
            
            if (players[targetId].hp <= 0) {
                // Handle death
                players[targetId].hp = 100; // Reset HP
                // In a real game, you would spawn them somewhere else and announce the kill
                io.emit('playerDied', { victim: targetId, killer: socket.id });
                // Reset position remotely
                io.to(targetId).emit('respawn');
            }
        }
    });
    
    // Pass shooting effects (sound/particles) instantly across network
    socket.on('shootEffect', (data) => {
        socket.broadcast.emit('playShootEffect', { id: socket.id, weapon: data.weapon });
    });

    socket.on('playerRespawned', () => {
        socket.broadcast.emit('playerRespawned', socket.id);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        // Tell everyone this player left
        io.emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 8000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser.`);
});
