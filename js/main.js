import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

let camera, scene, renderer, controls;
const objects = []; // Buildings and static walls for collision
const shootableObjects = []; // Shootable meshes (future players)
let raycaster;

// Settings State
let globalSettings = {
    fov: 75,
    sens: 1.0,      // maps to pointerSpeed = sens * 0.003
    volume: 1.0,
    shadows: true,
    chColor: '#ffffff'
};

// HUD Elements
const healthBarFill = document.getElementById('health-bar-fill');
const healthText = document.getElementById('health-text');
const ammoUI = document.getElementById('ammo-ui');
const killfeed = document.getElementById('killfeed');
const weaponUIElement = document.getElementById('weapon-ui');

// Leaderboard
const leaderboardEl = document.getElementById('leaderboard');
const leaderboardData = {}; // id -> { name, kills }

function updateLeaderboard() {
    const sorted = Object.entries(leaderboardData).sort((a, b) => b[1].kills - a[1].kills);
    leaderboardEl.innerHTML = '<div class="lb-header">LEADERBOARD</div>' +
        sorted.map(([id, d]) =>
            `<div class="lb-row${id === myId ? ' lb-me' : ''}">
                <span class="lb-name">${d.name}</span>
                <span class="lb-kills">${d.kills}</span>
            </div>`
        ).join('');
}

// UI Menus and Settings Modals
const settingsModal = document.getElementById('settings-modal');
const settingsOpenBtn = document.getElementById('settings-open-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');

const fovSlider = document.getElementById('fov-slider');
const fovVal = document.getElementById('fov-val');
const sensSlider = document.getElementById('sens-slider');
const sensVal = document.getElementById('sens-val');
const volLabel = document.getElementById('vol-val');
const volSlider = document.getElementById('vol-slider');
const volVal = document.getElementById('vol-val');
const shadowsCheck = document.getElementById('shadows-check');
const chColorPicker = document.getElementById('ch-color-picker');

// Setup interactions
settingsOpenBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
});
settingsCloseBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

[fovSlider, sensSlider, volSlider, shadowsCheck, chColorPicker].forEach(el => {
    el.addEventListener('input', updateSettings);
});

function updateSettings() {
    globalSettings.fov = parseInt(fovSlider.value);
    fovVal.innerText = globalSettings.fov;
    if(camera) {
        camera.fov = globalSettings.fov;
        camera.updateProjectionMatrix();
    }

    globalSettings.sens = parseFloat(sensSlider.value);
    sensVal.innerText = globalSettings.sens.toFixed(1);
    if (controls) controls.pointerSpeed = globalSettings.sens;
    
    globalSettings.volume = parseInt(volSlider.value) / 100;
    volVal.innerText = parseInt(volSlider.value);
    
    globalSettings.shadows = shadowsCheck.checked;
    
    globalSettings.chColor = chColorPicker.value;
    document.documentElement.style.setProperty('--ch-color', globalSettings.chColor);

    if(renderer) {
        renderer.shadowMap.enabled = globalSettings.shadows;
        scene.traverse((child) => {
            if(child.isMesh) {
                child.castShadow = globalSettings.shadows;
                child.receiveShadow = globalSettings.shadows;
                child.material.needsUpdate = true;
            }
        });
    }
}

// Multiplayer Variables
const otherPlayers = {}; // Store Three.js groups of other players
let socket;
let myId = null;
let isPlaying = false;

let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let isSprinting = false;
let canJump = false;

let prevTime = performance.now();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Weapons System
let currentWeapon = 0;
const weapons = [];
const weaponStats = [
    { name: 'PISTOL', damage: 18, fireRate: 300, sound: 'pistol', spread: 0, maxAmmo: 12, ammo: 12, auto: false },
    { name: 'ASSAULT RIFLE', damage: 11, fireRate: 100, sound: 'rifle', spread: 0.02, maxAmmo: 30, ammo: 30, auto: true },
    { name: 'SHOTGUN', damage: 8, fireRate: 800, sound: 'shotgun', spread: 0.1, pellets: 8, maxAmmo: 8, ammo: 8, auto: false },
    { name: 'SMG', damage: 8, fireRate: 65, sound: 'pistol', spread: 0.04, maxAmmo: 40, ammo: 40, auto: true },
    { name: 'SNIPER', damage: 70, fireRate: 1200, sound: 'shotgun', spread: 0, maxAmmo: 5, ammo: 5, auto: false }
];
let lastFireTime = 0;
let autoFireInterval = null;
let isMouseDown = false;
let isScoped = false;

let myPlayerName = '';
let isDead = false;

// Spawn points spread across the city, away from buildings
const SPAWN_POINTS = [
    [0, 0], [100, 100], [-100, 100], [100, -100], [-100, -100],
    [200, 0], [-200, 0], [0, 200], [0, -200],
    [150, 150], [-150, 150], [150, -150], [-150, -150],
    [300, 100], [-300, 100], [300, -100], [-300, -100],
];

function getRandomSpawn() {
    const [x, z] = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    return { x, y: 7, z };
}

// Gun effects
let muzzleLight = null;
let muzzleFlashMesh = null;
const hitMarkerEl = document.getElementById('hit-marker');
let hitMarkerTimeout = null;

function showHitMarker() {
    hitMarkerEl.classList.add('active');
    clearTimeout(hitMarkerTimeout);
    hitMarkerTimeout = setTimeout(() => hitMarkerEl.classList.remove('active'), 120);
}

function triggerMuzzleFlash() {
    // Dynamically align flash with gun tip depending on ADS state
    const targetX = isScoped ? 0 : 1.5;
    const targetY = isScoped ? -1.0 : (currentWeapon === 0 ? -1.2 : (currentWeapon === 1 ? -1.3 : (currentWeapon === 2 ? -1.5 : (currentWeapon === 3 ? -1.3 : -1.4))));
    
    if (muzzleLight) {
        muzzleLight.position.x = targetX;
        muzzleLight.position.y = targetY + 0.4;
        muzzleLight.intensity = 5;
        setTimeout(() => { if (muzzleLight) muzzleLight.intensity = 0; }, 60);
    }
    if (muzzleFlashMesh) {
        muzzleFlashMesh.position.x = targetX;
        muzzleFlashMesh.position.y = targetY;
        muzzleFlashMesh.material.opacity = 0.9;
        muzzleFlashMesh.rotation.z = Math.random() * Math.PI * 2;
        muzzleFlashMesh.scale.set(0.8 + Math.random()*0.5, 0.8 + Math.random()*0.5, 1);
        setTimeout(() => { if (muzzleFlashMesh) muzzleFlashMesh.material.opacity = 0; }, 60);
    }
}

function createBulletTracer(start, end) {
    const dist = start.distanceTo(end);
    const geo = new THREE.CylinderGeometry(0.12, 0.12, dist, 8);
    geo.translate(0, dist / 2, 0);
    geo.rotateX(Math.PI / 2); // align to Z axis so lookAt works
    
    const mat = new THREE.MeshBasicMaterial({ 
        color: 0xffea00, 
        transparent: true, 
        opacity: 0.9, 
        blending: THREE.AdditiveBlending 
    });
    
    const tracer = new THREE.Mesh(geo, mat);
    tracer.position.copy(start);
    tracer.lookAt(end);
    scene.add(tracer);

    let opacity = 0.9;
    const fade = setInterval(() => {
        opacity -= 0.1;
        mat.opacity = opacity;
        tracer.scale.set(opacity, 1, opacity);
        if (opacity <= 0) {
            clearInterval(fade);
            scene.remove(tracer);
            geo.dispose();
            mat.dispose();
        }
    }, 16);
}

// Audio setup
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playShootSound(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    if (type === 'pistol') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(300, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.2 * globalSettings.volume, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    } else if (type === 'rifle') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        gainNode.gain.setValueAtTime(0.3 * globalSettings.volume, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    } else if (type === 'shotgun') {
        // Use sawtooth + some noise approximation for shotgun
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(10, audioCtx.currentTime + 0.2);
        gainNode.gain.setValueAtTime(0.4 * globalSettings.volume, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    }

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
}

function playHitSound(isHeadshot) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = 'sine';
    
    if (isHeadshot) {
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.6 * globalSettings.volume, audioCtx.currentTime);
    } else {
        osc.frequency.setValueAtTime(400, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.3 * globalSettings.volume, audioCtx.currentTime);
    }
    
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

// Ensure the game only starts after connecting
const startBtn = document.getElementById('start-btn');
const mainMenu = document.getElementById('main-menu-container');
const playerNameInput = document.getElementById('player-name');
const connectionStatus = document.getElementById('connection-status');
const uiElements = ['crosshair', 'instructions', 'hud-top', 'hud-bottom'];

startBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim() || 'Guest';
    myPlayerName = name;
    if(typeof io !== 'undefined') {
        // ======= DEPLOYMENT CONFIG =======
        // 1. Deploy 'server.js' to Railway.app
        // 2. Paste your Railway URL below:
        const RAILWAY_URL = "https://ontrofps-production.up.railway.app"; 
        
        const socketUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
            ? undefined // Defaults to current origin (good for local dev)
            : RAILWAY_URL;
            
        socket = io(socketUrl);
        setupMultiplayer(name);
    } else {
        connectionStatus.innerText = "Error: Cannot connect to server. Check logs.";
        connectionStatus.style.color = "red";
    }
});

function setupMultiplayer(name) {
    connectionStatus.innerText = "Connecting...";
    
    socket.on('connect', () => {
        myId = socket.id;
        socket.emit('joinGame', name);
        leaderboardData[myId] = { name: name, kills: 0 };
        updateLeaderboard();

        // Hide menu, show UI, start rendering mechanics
        mainMenu.style.display = 'none';
        uiElements.forEach(id => document.getElementById(id).style.display = 'block');

        isPlaying = true;
        init();
        animate();
    });

    socket.on('initPlayers', (serverPlayers) => {
        for (let id in serverPlayers) {
            if (id !== myId) addOtherPlayer(serverPlayers[id]);
        }
    });

    socket.on('playerJoined', (playerData) => {
        addOtherPlayer(playerData);
    });

    socket.on('playerMoved', (playerData) => {
        if (otherPlayers[playerData.id]) {
            const bot = otherPlayers[playerData.id];
            bot.group.position.set(playerData.x, playerData.y - 7, playerData.z);
            bot.group.rotation.y = playerData.ry;
        }
    });

    socket.on('playerRespawned', (id) => {
        if (otherPlayers[id]) {
            otherPlayers[id].dead = false;
            otherPlayers[id].group.visible = true;
            otherPlayers[id].tag.style.display = 'block';
        }
    });

    socket.on('playerLeft', (id) => {
        if (otherPlayers[id]) {
            scene.remove(otherPlayers[id].group);
            otherPlayers[id].tag.remove();
            otherPlayers[id].meshes.forEach(m => {
                const idx = shootableObjects.indexOf(m);
                if(idx > -1) shootableObjects.splice(idx, 1);
            });
            delete otherPlayers[id];
            delete leaderboardData[id];
            updateLeaderboard();
        }
    });

    socket.on('playerHit', (data) => {
        if (data.id === myId) {
            // I got hit
            // Update local health UI
            const hpWidth = Math.max(0, data.hp) + '%';
            healthBarFill.style.width = hpWidth;
            healthText.innerText = Math.max(0, data.hp);
            
            // Flash health bar red
            healthBarFill.style.background = "linear-gradient(90deg, #ff0000, #ff5252)";
            setTimeout(() => {
                healthBarFill.style.background = "linear-gradient(90deg, #4CAF50, #8BC34A)";
            }, 300);

            // Flash screen red using the persistent overlay
            const dmgFlash = document.getElementById('damage-flash');
            dmgFlash.classList.add('active');
            setTimeout(() => dmgFlash.classList.remove('active'), 180);
        }
    });

    socket.on('playerDied', (data) => {
        // Update leaderboard kill count
        if (leaderboardData[data.killer]) {
            leaderboardData[data.killer].kills++;
            updateLeaderboard();
        }

        // Hide the dead player's model
        if (otherPlayers[data.victim]) {
            otherPlayers[data.victim].dead = true;
            otherPlayers[data.victim].group.visible = false;
            otherPlayers[data.victim].tag.style.display = 'none';
        }

        if (data.killer === myId) {
            const victimName = otherPlayers[data.victim] ? otherPlayers[data.victim].name : 'a player';
            const killMsg = document.createElement('div');
            killMsg.className = 'kill-entry';
            killMsg.innerText = `⚡ You eliminated ${victimName}`;
            killfeed.appendChild(killMsg);
            setTimeout(() => { killMsg.remove(); }, 3500);
        }
    });

    socket.on('respawn', (data) => {
        const killerName = data && data.killer && leaderboardData[data.killer]
            ? leaderboardData[data.killer].name
            : '';
        showDeathScreen(killerName);
    });

    socket.on('playShootEffect', (data) => {
        const stats = weaponStats.find(w => w.name === data.weapon) || weaponStats[0];
        playShootSound(stats.sound);
    });
}

function showDeathScreen(killerName) {
    const deathScreen = document.getElementById('death-screen');
    const killerText = document.getElementById('death-killer-text');
    const barFill = document.getElementById('death-bar-fill');
    const countdownEl = document.getElementById('respawn-countdown');
    const respawnBtn = document.getElementById('death-respawn-btn');
    const menuBtn = document.getElementById('death-menu-btn');

    killerText.innerText = killerName ? `Eliminated by ${killerName}` : '';
    isDead = true;
    moveForward = moveBackward = moveLeft = moveRight = isSprinting = false;
    if (autoFireInterval) { clearInterval(autoFireInterval); autoFireInterval = null; }
    isMouseDown = false;
    if (controls) controls.unlock();
    deathScreen.classList.remove('hidden');

    // Reset and animate countdown bar
    let countdown = 5;
    barFill.style.transition = 'none';
    barFill.style.width = '100%';
    requestAnimationFrame(() => {
        barFill.style.transition = `width ${countdown}s linear`;
        barFill.style.width = '0%';
    });
    countdownEl.innerText = countdown;

    let resolved = false;
    function resolve(action) {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        deathScreen.classList.add('hidden');
        if (action === 'menu') {
            window.location.reload();
        } else {
            doRespawn();
        }
    }

    const interval = setInterval(() => {
        countdown--;
        countdownEl.innerText = countdown;
        if (countdown <= 0) resolve('respawn');
    }, 1000);

    // Clone buttons to clear old listeners
    const newRespawn = respawnBtn.cloneNode(true);
    const newMenu = menuBtn.cloneNode(true);
    respawnBtn.replaceWith(newRespawn);
    menuBtn.replaceWith(newMenu);
    newRespawn.addEventListener('click', () => resolve('respawn'));
    newMenu.addEventListener('click', () => resolve('menu'));
}

function doRespawn() {
    if (!controls) return;
    isDead = false;
    const spawn = getRandomSpawn();
    controls.getObject().position.set(spawn.x, spawn.y, spawn.z);
    velocity.set(0, 0, 0);
    healthBarFill.style.width = '100%';
    healthText.innerText = '100';
    weaponStats.forEach(w => w.ammo = w.maxAmmo);
    updateAmmoUI();
    if (socket) socket.emit('playerRespawned');
    controls.lock();
}

function addOtherPlayer(data) {
    if(!scene) return;

    const botGroup = new THREE.Group();
    const color = data.color || 0x3333ff;

    const bodyMat = new THREE.MeshPhongMaterial({ color: color });
    const skinMat = new THREE.MeshPhongMaterial({ color: 0xffccaa });
    const pantsMat = new THREE.MeshPhongMaterial({ color: 0x222233 });
    const bootMat = new THREE.MeshPhongMaterial({ color: 0x111111 });

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.6, 1.1), bodyMat);
    torso.position.y = 5.3;
    torso.castShadow = true;

    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), skinMat);
    head.position.y = 7.25;
    head.castShadow = true;

    // Visor
    const visor = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, 0.12), new THREE.MeshPhongMaterial({ color: 0x112233 }));
    visor.position.set(0, 0.1, -0.82);
    head.add(visor);

    // Left arm — hangs at side
    const upperArmGeo = new THREE.BoxGeometry(0.65, 1.4, 0.65);
    const foreArmGeo  = new THREE.BoxGeometry(0.55, 1.2, 0.55);
    const leftUpperArm = new THREE.Mesh(upperArmGeo, bodyMat);
    leftUpperArm.position.set(-1.55, 5.4, 0);
    leftUpperArm.castShadow = true;
    const leftForeArm = new THREE.Mesh(foreArmGeo, skinMat);
    leftForeArm.position.set(-1.55, 4.1, 0);
    leftForeArm.castShadow = true;

    // Right arm — extended forward holding gun (group pivoted at shoulder)
    // Right arm — straight out forward, holding gun
    const rightArmGroup = new THREE.Group();
    rightArmGroup.position.set(1.45, 5.5, 0); // shoulder pivot
    rightArmGroup.rotation.x = Math.PI / 2;   // arm pointing straight forward (-Z)

    const rightUpperArm = new THREE.Mesh(upperArmGeo, bodyMat);
    rightUpperArm.position.set(0, -0.7, 0);
    rightUpperArm.castShadow = true;
    rightArmGroup.add(rightUpperArm);

    const rightElbow = new THREE.Group();
    rightElbow.position.set(0, -1.4, 0);
    rightElbow.rotation.x = 0; // fully straight
    rightArmGroup.add(rightElbow);

    const rightForeArm = new THREE.Mesh(foreArmGeo, skinMat);
    rightForeArm.position.set(0, -0.6, 0);
    rightForeArm.castShadow = true;
    rightElbow.add(rightForeArm);

    // Gun at wrist — barrel pointing along -Y (which is forward after arm rotation)
    const gunMat    = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });
    const gunAccent = new THREE.MeshPhongMaterial({ color: 0x383838 });
    const wristGun  = new THREE.Group();
    wristGun.position.set(0, -1.35, 0);

    const gunGrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.52), gunMat);
    gunGrip.position.set(0, -0.1, 0.18);
    const gunSlide = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.88, 0.22), gunAccent);
    gunSlide.position.set(0, -0.3, 0);
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.55, 8), gunMat);
    gunBarrel.position.set(0, -0.75, 0);
    wristGun.add(gunGrip, gunSlide, gunBarrel);
    rightElbow.add(wristGun);

    // Upper legs
    const upperLegGeo = new THREE.BoxGeometry(0.9, 1.6, 0.9);
    const leftUpperLeg = new THREE.Mesh(upperLegGeo, pantsMat);
    leftUpperLeg.position.set(-0.62, 3.15, 0);
    leftUpperLeg.castShadow = true;

    const rightUpperLeg = new THREE.Mesh(upperLegGeo, pantsMat);
    rightUpperLeg.position.set(0.62, 3.15, 0);
    rightUpperLeg.castShadow = true;

    // Lower legs
    const lowerLegGeo = new THREE.BoxGeometry(0.8, 1.6, 0.8);
    const leftLowerLeg = new THREE.Mesh(lowerLegGeo, pantsMat);
    leftLowerLeg.position.set(-0.62, 1.55, 0);
    leftLowerLeg.castShadow = true;

    const rightLowerLeg = new THREE.Mesh(lowerLegGeo, pantsMat);
    rightLowerLeg.position.set(0.62, 1.55, 0);
    rightLowerLeg.castShadow = true;

    // Boots
    const bootGeo = new THREE.BoxGeometry(0.9, 0.6, 1.1);
    const leftBoot = new THREE.Mesh(bootGeo, bootMat);
    leftBoot.position.set(-0.62, 0.3, 0.1);

    const rightBoot = new THREE.Mesh(bootGeo, bootMat);
    rightBoot.position.set(0.62, 0.3, 0.1);

    botGroup.add(torso, head, leftUpperArm, leftForeArm, rightArmGroup,
        leftUpperLeg, rightUpperLeg, leftLowerLeg, rightLowerLeg, leftBoot, rightBoot);

    // Subtract eye height (7) so feet are on the ground
    botGroup.position.set(data.x, data.y - 7, data.z);
    scene.add(botGroup);

    const tag = document.createElement('div');
    tag.innerText = data.name;
    tag.style.position = 'absolute';
    tag.style.color = 'white';
    tag.style.fontFamily = "'Rajdhani', sans-serif";
    tag.style.fontWeight = '600';
    tag.style.fontSize = '14px';
    tag.style.letterSpacing = '1px';
    tag.style.textShadow = '0 1px 4px rgba(0,0,0,0.9)';
    tag.style.pointerEvents = 'none';
    tag.style.transform = 'translate(-50%, -50%)';
    tag.style.display = 'none';
    document.body.appendChild(tag);

    const userData = { isPlayer: true, id: data.id };
    const shootableParts = [torso, head, leftUpperArm, rightUpperArm, leftForeArm, rightForeArm,
        leftUpperLeg, rightUpperLeg, leftLowerLeg, rightLowerLeg];
    shootableParts.forEach(m => { m.userData = { ...userData, isHead: m === head }; });
    shootableObjects.push(...shootableParts);

    otherPlayers[data.id] = { group: botGroup, meshes: shootableParts, tag: tag, name: data.name, dead: false };

    leaderboardData[data.id] = { name: data.name, kills: 0 };
    updateLeaderboard();
}

// Initial calls moved inside setupMultiplayer
// init();
// animate();

function createGuns() {
    // Shared metallic material
    const metalMat = new THREE.MeshStandardMaterial({
        color: 0x444444, 
        roughness: 0.4, 
        metalness: 0.8
    });
    const darkMat = new THREE.MeshStandardMaterial({
        color: 0x111111, 
        roughness: 0.7, 
        metalness: 0.2
    });
    const accentMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        roughness: 0.2,
        metalness: 0.95
    });

    // 0: Pistol (Detailed)
    const pistolGroup = new THREE.Group();
    // Slide/Barrel
    const pBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 2.2), metalMat);
    pBarrel.position.set(0, 0, -1);
    // Grip
    const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.0, 0.6), darkMat);
    pGrip.position.set(0, -0.6, 0.2);
    pGrip.rotation.x = -0.2;
    // Trigger guard
    const pGuard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.5), darkMat);
    pGuard.position.set(0, -0.4, -0.4);
    // Iron sights
    const pSight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.2), accentMat);
    pSight.position.set(0, 0.27, -1.9);
    
    pistolGroup.add(pBarrel, pGrip, pGuard, pSight);
    pistolGroup.position.set(1.5, -1.2, -2.5);
    pistolGroup.scale.set(0.8, 0.8, 0.8);
    weapons.push(pistolGroup);

    // 1: Assault Rifle (Detailed)
    const rifleGroup = new THREE.Group();
    // Main Body
    const rBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 3), darkMat);
    rBody.position.set(0, 0, 0);
    // Barrel extending
    const rBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.5, 8), metalMat);
    rBarrel.rotation.x = Math.PI / 2;
    rBarrel.position.set(0, 0.1, -2.5);
    // Magazine
    const rMag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 0.7), metalMat);
    rMag.position.set(0, -0.8, -0.3);
    rMag.rotation.x = 0.1;
    // Stock
    const rStock = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.8, 2), darkMat);
    rStock.position.set(0, -0.1, 2.5);
    // Scope Rail & Scope
    const rRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 1.5), metalMat);
    rRail.position.set(0, 0.4, 0);
    const rScope = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.8, 12), darkMat);
    rScope.rotation.x = Math.PI / 2;
    rScope.position.set(0, 0.6, 0);
    const rScopeLens = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.81, 12), new THREE.MeshStandardMaterial({color: 0x1a2a3a, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7}));
    rScopeLens.rotation.x = Math.PI / 2;
    rScopeLens.position.set(0, 0.6, 0);

    rifleGroup.add(rBody, rBarrel, rMag, rStock, rRail, rScope, rScopeLens);
    rifleGroup.position.set(1.5, -1.3, -2.5);
    rifleGroup.scale.set(0.7, 0.7, 0.7);
    weapons.push(rifleGroup);

    // 2: Shotgun (Detailed)
    const shotgunGroup = new THREE.Group();
    // Receiver
    const sReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 2.5), darkMat);
    sReceiver.position.set(0, 0, 0.5);
    // Main Barrel
    const sBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3.5, 12), metalMat);
    sBarrel.rotation.x = Math.PI / 2;
    sBarrel.position.set(0, 0.1, -2.5);
    // Under barrel tube
    const sTube = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.0, 12), darkMat);
    sTube.rotation.x = Math.PI / 2;
    sTube.position.set(0, -0.2, -2.2);
    // Pump handle
    const sPump = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.2, 8), accentMat);
    sPump.rotation.x = Math.PI / 2;
    sPump.position.set(0, -0.2, -1.5);
    // Stock
    const sStock = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 2), darkMat);
    sStock.position.set(0, -0.2, 2.5);
    sStock.rotation.x = -0.1;

    shotgunGroup.add(sReceiver, sBarrel, sTube, sPump, sStock);
    shotgunGroup.position.set(1.5, -1.5, -2.5);
    shotgunGroup.scale.set(0.7, 0.7, 0.7);
    weapons.push(shotgunGroup);

    // 3: SMG (Compact)
    const smgGroup = new THREE.Group();
    const smgBody = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 2.0), darkMat);
    smgBody.position.set(0, 0, 0);
    const smgBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 8), metalMat);
    smgBarrel.rotation.x = Math.PI / 2;
    smgBarrel.position.set(0, 0.05, -1.8);
    const smgMag = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.0, 0.5), metalMat);
    smgMag.position.set(0, -0.7, -0.2);
    smgMag.rotation.x = 0.15;
    const smgGrip = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.35), darkMat);
    smgGrip.position.set(0, -0.5, 0.6);
    smgGrip.rotation.x = -0.2;
    const smgSuppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 10), accentMat);
    smgSuppressor.rotation.x = Math.PI / 2;
    smgSuppressor.position.set(0, 0.05, -3.0);
    const smgStock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 1.2), metalMat);
    smgStock.position.set(0, 0.1, 1.6);
    smgGroup.add(smgBody, smgBarrel, smgMag, smgGrip, smgSuppressor, smgStock);
    smgGroup.position.set(1.5, -1.3, -2.5);
    smgGroup.scale.set(0.75, 0.75, 0.75);
    weapons.push(smgGroup);

    // 4: Sniper Rifle (Overhauled)
    const sniperGroup = new THREE.Group();
    
    // Polymer Stock & Grip
    const snStock = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.2, 1.8), darkMat);
    snStock.position.set(0, -0.2, 2.8);
    
    const snCheekRest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.8), metalMat);
    snCheekRest.position.set(0, 0.4, 2.5);
    
    // Main Receiver
    const snBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 2.5), metalMat);
    snBody.position.set(0, 0, 0.5);
    
    // Long Fluted Barrel
    const snBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 5.0, 10), darkMat);
    snBarrel.rotation.x = Math.PI / 2;
    snBarrel.position.set(0, 0.15, -3.2);
    
    // Large Muzzle Brake
    const snMuzzle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.6), accentMat);
    snMuzzle.position.set(0, 0.15, -5.8);
    
    // Complex Tactical Scope
    const snScopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.0, 12), darkMat);
    snScopeTube.rotation.x = Math.PI / 2;
    snScopeTube.position.set(0, 0.7, 0);
    
    const snScopeBellFront = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.12, 0.8, 12), darkMat);
    snScopeBellFront.rotation.x = Math.PI / 2;
    snScopeBellFront.position.set(0, 0.7, -1.2);
    
    const snScopeBellBack = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 0.5, 12), darkMat);
    snScopeBellBack.rotation.x = Math.PI / 2;
    snScopeBellBack.position.set(0, 0.7, 1.2);

    const snLens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.25, 0.1, 12),
        new THREE.MeshStandardMaterial({color: 0x1a2e4a, roughness: 0.1, metalness: 0.9, transparent: true, opacity: 0.6})
    );
    snLens.rotation.x = Math.PI / 2;
    snLens.position.set(0, 0.7, -1.6);
    
    // Bolt Action Handle
    const snBoltHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), metalMat);
    snBoltHandle.rotation.z = Math.PI / 2;
    snBoltHandle.position.set(0.35, 0.1, 0.5);
    
    const snBoltKnob = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), darkMat);
    snBoltKnob.position.set(0.6, 0.1, 0.5);

    // Bipod legs
    const snBipodMount = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.3), metalMat);
    snBipodMount.position.set(0, -0.2, -2.5);
    
    const snLegL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 8), darkMat);
    snLegL.position.set(-0.3, -0.8, -2.5);
    snLegL.rotation.z = 0.4;
    
    const snLegR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 8), darkMat);
    snLegR.position.set(0.3, -0.8, -2.5);
    snLegR.rotation.z = -0.4;

    sniperGroup.add(snStock, snCheekRest, snBody, snBarrel, snMuzzle, snScopeTube, snScopeBellFront, snScopeBellBack, snLens, snBoltHandle, snBoltKnob, snBipodMount, snLegL, snLegR);
    sniperGroup.position.set(1.5, -1.4, -2.5);
    sniperGroup.scale.set(0.48, 0.48, 0.48);
    weapons.push(sniperGroup);

    switchWeapon(0);
}

function updateAmmoUI() {
    const stats = weaponStats[currentWeapon];
    ammoUI.innerText = `${stats.ammo} / ${stats.maxAmmo}`;
    if (stats.ammo <= 0) {
        ammoUI.style.color = '#ff5252';
    } else {
        ammoUI.style.color = 'white';
    }
}

function switchWeapon(index) {
    if(index < 0 || index >= weapons.length) return;
    weapons.forEach(w => camera.remove(w));
    currentWeapon = index;
    camera.add(weapons[currentWeapon]);
    weaponUIElement.innerText = weaponStats[index].name;
    updateAmmoUI();
}

// Bot spawning removed. Reserved for player spawning logic via multiplayer.

function buildCity() {
    const mGray   = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8, metalness: 0.1 });
    const mBlue   = new THREE.MeshStandardMaterial({ color: 0x667799, roughness: 0.7, metalness: 0.2 });
    const mBrown  = new THREE.MeshStandardMaterial({ color: 0x886644, roughness: 0.85, metalness: 0.05 });
    const mCover  = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9, metalness: 0.0 });
    const mWall   = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.9, metalness: 0.0 });
    const geo1    = new THREE.BoxGeometry(1, 1, 1);

    function addBox(cx, cz, w, d, h, mat) {
        const m = new THREE.Mesh(geo1, mat);
        m.scale.set(w, h, d);
        m.position.set(cx, h * 0.5, cz);
        m.castShadow = globalSettings.shadows;
        m.receiveShadow = globalSettings.shadows;
        scene.add(m);
        objects.push(m);
    }

    // Boundary walls
    [[0, 410, 820, 20, 80], [0, -410, 820, 20, 80],
     [410, 0, 20, 820, 80], [-410, 0, 20, 820, 80]].forEach(([cx,cz,w,d,h]) => addBox(cx,cz,w,d,h,mWall));

    // Buildings [cx, cz, w, d, h, matIndex]
    const buildings = [
        [80, 80, 30, 30, 60, 0],   [-80, 80, 25, 25, 45, 1],
        [80, -80, 30, 25, 50, 2],  [-80, -80, 25, 30, 55, 0],
        [0, 130, 40, 20, 35, 1],   [0, -130, 35, 20, 40, 2],
        [160, 0, 25, 25, 70, 0],   [-160, 0, 30, 25, 65, 1],
        [160, 130, 20, 20, 45, 2], [-160, 130, 20, 20, 50, 0],
        [160, -130, 20, 20, 55, 1],[-160, -130, 20, 20, 40, 2],
        [240, 80, 30, 30, 80, 0],  [-240, 80, 25, 25, 60, 1],
        [240, -80, 25, 30, 70, 2], [-240, -80, 30, 25, 65, 0],
        [280, 0, 20, 60, 50, 1],   [-280, 0, 20, 60, 45, 2],
        [0, 240, 60, 20, 55, 0],   [0, -240, 60, 20, 60, 1],
        [120, 0, 15, 15, 30, 2],   [-120, 0, 15, 15, 25, 0],
        [60, 200, 20, 20, 35, 1],  [-60, 200, 20, 20, 40, 2],
        [60, -200, 20, 20, 30, 0], [-60, -200, 20, 20, 45, 1],
        [340, 200, 25, 25, 65, 2], [-340, 200, 25, 25, 50, 0],
        [340, -200, 20, 20, 45, 1],[-340, -200, 20, 20, 55, 2],
    ];
    const mats = [mGray, mBlue, mBrown];
    buildings.forEach(([cx,cz,w,d,h,mi]) => addBox(cx,cz,w,d,h,mats[mi]));

    // Low cover barriers
    [[0,0,8,8,4],[40,40,6,10,4],[-40,40,6,10,4],[40,-40,6,10,4],[-40,-40,6,10,4],
     [120,120,10,4,5],[-120,120,10,4,5],[120,-120,10,4,5],[-120,-120,10,4,5],
     [200,40,4,8,4],[-200,40,4,8,4],[200,-40,4,8,4],[-200,-40,4,8,4],
     [50,0,4,8,4],[-50,0,4,8,4],[0,60,8,4,4],[0,-60,8,4,4],
    ].forEach(([cx,cz,w,d,h]) => addBox(cx,cz,w,d,h,mCover));
}

function init() {
    camera = new THREE.PerspectiveCamera(globalSettings.fov, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.y = 7;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.FogExp2(0x87ceeb, 0.0015);

    const skyLight = new THREE.HemisphereLight(0xffffff, 0xaabb88, 1.2);
    scene.add(skyLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(200, 500, 100);
    dirLight.castShadow = globalSettings.shadows;
    dirLight.shadow.camera.top = 500;
    dirLight.shadow.camera.bottom = -500;
    dirLight.shadow.camera.left = -500;
    dirLight.shadow.camera.right = 500;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 10;
    dirLight.shadow.camera.far = 1200;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xaaccff, 0.4);
    fillLight.position.set(-300, 200, -100);
    scene.add(fillLight);

    controls = new PointerLockControls(camera, document.body);
    controls.pointerSpeed = globalSettings.sens;

    // Muzzle flash point light (attached to camera so it moves with player)
    muzzleLight = new THREE.PointLight(0xffaa44, 0, 12);
    muzzleLight.position.set(0, -0.5, -3);
    camera.add(muzzleLight);

    // Muzzle flash visual mesh (thick bright plane near gun tip)
    const flashGeo = new THREE.PlaneGeometry(3, 3);
    const flashMat = new THREE.MeshBasicMaterial({ 
        color: 0xffd500, 
        transparent: true, 
        opacity: 0, 
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
    muzzleFlashMesh.position.set(1.5, -1.2, -4.5); // roughly at gun tip
    camera.add(muzzleFlashMesh);

    const instructions = document.getElementById('instructions');
    const resumeBtn = document.getElementById('resume-btn');
    const exitBtn = document.getElementById('exit-btn');

    resumeBtn.addEventListener('click', function () {
        if(isPlaying) controls.lock();
    });

    exitBtn.addEventListener('click', function () {
        window.location.reload();
    });

    controls.addEventListener('lock', function () {
        instructions.style.display = 'none';
    });

    controls.addEventListener('unlock', function () {
        if(isPlaying && !isDead) instructions.style.display = 'flex';
    });

    scene.add(controls.getObject());

    const onKeyDown = function (event) {
        switch (event.code) {
            case 'ShiftLeft': case 'ShiftRight': isSprinting = true; break;
            case 'ArrowUp': case 'KeyW': moveForward = true; break;
            case 'ArrowLeft': case 'KeyA': moveLeft = true; break;
            case 'ArrowDown': case 'KeyS': moveBackward = true; break;
            case 'ArrowRight': case 'KeyD': moveRight = true; break;
            case 'Space':
                if (canJump === true) velocity.y += 180;
                canJump = false;
                break;
            case 'Digit1': switchWeapon(0); break;
            case 'Digit2': switchWeapon(1); break;
            case 'Digit3': switchWeapon(2); break;
            case 'Digit4': switchWeapon(3); break;
            case 'Digit5': switchWeapon(4); break;
        }
    };

    const onKeyUp = function (event) {
        switch (event.code) {
            case 'ShiftLeft': case 'ShiftRight': isSprinting = false; break;
            case 'ArrowUp': case 'KeyW': moveForward = false; break;
            case 'ArrowLeft': case 'KeyA': moveLeft = false; break;
            case 'ArrowDown': case 'KeyS': moveBackward = false; break;
            case 'ArrowRight': case 'KeyD': moveRight = false; break;
        }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', e => e.preventDefault());

    raycaster = new THREE.Raycaster();

    const floorGeometry = new THREE.PlaneGeometry(2000, 2000);
    floorGeometry.rotateX(-Math.PI / 2);
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x999988,
        roughness: 0.95,
        metalness: 0.0
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.receiveShadow = globalSettings.shadows;
    scene.add(floor);

    const gridHelper = new THREE.GridHelper(2000, 100, 0x777766, 0x666655);
    gridHelper.position.y = 0.1;
    gridHelper.material.opacity = 0.3;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);

    buildCity();
    createGuns();

    // No initial bots (reserved for multiplayer)

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // Reload on R
    document.addEventListener('keydown', (e) => {
        if(e.code === 'KeyR' && controls.isLocked) {
            const stats = weaponStats[currentWeapon];
            if(stats.ammo < stats.maxAmmo) {
                stats.ammo = stats.maxAmmo;
                updateAmmoUI();
                
                const weaponGroup = weapons[currentWeapon];
                weaponGroup.rotation.x = -1.0;
                weaponGroup.position.y = -2;
                setTimeout(() => {
                    weaponGroup.rotation.x = 0;
                    weaponGroup.position.y = -1.5; // Default y coordinate
                }, 500);
            }
        }
    });

    window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function handleShoot() {
    const stats = weaponStats[currentWeapon];
    if (stats.ammo <= 0) {
        // Play click sound (empty)
        return; 
    }

    stats.ammo--;
    updateAmmoUI();

    playShootSound(stats.sound);
    triggerMuzzleFlash();

    // Animate recoil
    const weaponGroup = weapons[currentWeapon];
    weaponGroup.position.z = -1.5;
    weaponGroup.rotation.x = 0.1;
    setTimeout(() => {
        weaponGroup.position.z = -2;
        weaponGroup.rotation.x = 0;
    }, 100);

    const bullets = stats.pellets || 1;
    for(let i=0; i<bullets; i++) {
        // Apply spread
        const dir = new THREE.Vector3(0, 0, -1);
        if(stats.spread > 0) {
            dir.x += (Math.random() - 0.5) * stats.spread;
            dir.y += (Math.random() - 0.5) * stats.spread;
        }
        dir.transformDirection(camera.matrixWorld);
        
        raycaster.set(camera.getWorldPosition(new THREE.Vector3()), dir);
        
        // We only intersect shootable objects (other players) or buildings
        const combined = [...shootableObjects, ...objects];
        const intersects = raycaster.intersectObjects(combined, false);
        
        const origin = camera.getWorldPosition(new THREE.Vector3());

        if (intersects.length > 0) {
            const hit = intersects[0];
            const target = hit.object;
            const userData = target.userData;

            createBulletTracer(origin, hit.point);

            if (userData.isPlayer) {
                playHitSound(userData.isHead);
                showHitMarker();
                const dmg = userData.isHead ? stats.damage * 2 : stats.damage;
                socket.emit('hitPlayer', { id: userData.id, damage: dmg });
            }
        } else {
            // Tracer to max range when nothing hit
            const farPoint = origin.clone().add(dir.clone().multiplyScalar(600));
            createBulletTracer(origin, farPoint);
        }
    }
}

function onMouseDown(event) {
    if (!controls.isLocked || isDead) return;
    
    if (event.button === 0) { // Left Click
        isMouseDown = true;
        const now = performance.now();
        const stats = weaponStats[currentWeapon];
        if (now - lastFireTime >= stats.fireRate) {
            lastFireTime = now;
            handleShoot();
        }
        if (stats.auto && !autoFireInterval) {
            autoFireInterval = setInterval(() => {
                if (!isMouseDown || !controls.isLocked) {
                    clearInterval(autoFireInterval);
                    autoFireInterval = null;
                    return;
                }
                const s = weaponStats[currentWeapon];
                if (s.auto && s.ammo > 0) {
                    handleShoot();
                } else {
                    clearInterval(autoFireInterval);
                    autoFireInterval = null;
                }
            }, stats.fireRate);
        }
    } else if (event.button === 2) { // Right Click
        isScoped = true;
    }
}

function onMouseUp(event) {
    if (event.button === 0) {
        isMouseDown = false;
        if (autoFireInterval) {
            clearInterval(autoFireInterval);
            autoFireInterval = null;
        }
    } else if (event.button === 2) {
        isScoped = false;
    }
}

function getFloorHeight(px, pz) {
    let h = 0;
    for (const obj of objects) {
        const minX = obj.position.x - obj.scale.x / 2;
        const maxX = obj.position.x + obj.scale.x / 2;
        const minZ = obj.position.z - obj.scale.z / 2;
        const maxZ = obj.position.z + obj.scale.z / 2;
        if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
            h = Math.max(h, obj.position.y + obj.scale.y / 2);
        }
    }
    return h;
}

function checkCollision(position) {
    const px = position.x;
    const pz = position.z;
    const feetY = position.y - 7; // camera is at eye height 7
    const radius = 3;

    for (const obj of objects) {
        const objTop = obj.position.y + obj.scale.y / 2;
        // Skip if player's feet are at or above this object's top (they're standing on it)
        if (feetY >= objTop - 0.5) continue;

        const minX = obj.position.x - obj.scale.x / 2 - radius;
        const maxX = obj.position.x + obj.scale.x / 2 + radius;
        const minZ = obj.position.z - obj.scale.z / 2 - radius;
        const maxZ = obj.position.z + obj.scale.z / 2 + radius;

        if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
            return true;
        }
    }
    return false;
}

// Placeholder for updating other players in multiplayer
function updatePlayers(delta) {
    // Logic to interpolate other players' movements
}

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const delta = (time - prevTime) / 1000;

    if (controls.isLocked === true) {
        // FOV / ADS Interpolation
        const targetFov = isScoped ? (currentWeapon === 4 ? 25 : 45) : globalSettings.fov;
        if (Math.abs(camera.fov - targetFov) > 0.1) {
            camera.fov += (targetFov - camera.fov) * 15 * delta;
            camera.updateProjectionMatrix();
        }

        // Weapon Positioning Interpolation (ADS)
        const weaponGroup = weapons[currentWeapon];
        if (weaponGroup) {
            const targetX = isScoped ? 0 : 1.5;
            const targetY = isScoped ? -1.0 : (currentWeapon === 0 ? -1.2 : (currentWeapon === 1 ? -1.3 : (currentWeapon === 2 ? -1.5 : (currentWeapon === 3 ? -1.3 : -1.4))));
            weaponGroup.position.x += (targetX - weaponGroup.position.x) * 15 * delta;
            weaponGroup.position.y += (targetY - weaponGroup.position.y) * 15 * delta;
            
            // Sensitivity scaling
            const scopedSensMult = currentWeapon === 4 ? 0.3 : 0.6;
            controls.pointerSpeed = isScoped ? globalSettings.sens * scopedSensMult : globalSettings.sens;

            // Scope Overlay for Sniper
            const scopeEl = document.getElementById('sniper-scope');
            const crosshairEl = document.getElementById('crosshair');
            if (currentWeapon === 4 && isScoped && camera.fov < 30) {
                weaponGroup.visible = false;
                scopeEl.style.display = 'flex';
                crosshairEl.style.display = 'none';
            } else {
                weaponGroup.visible = true;
                scopeEl.style.display = 'none';
                if (controls.isLocked) crosshairEl.style.display = 'block';
            }
        }

        velocity.x -= velocity.x * 10.0 * delta;
        velocity.z -= velocity.z * 10.0 * delta;
        velocity.y -= 9.8 * 60.0 * delta;

        direction.z = Number(moveForward) - Number(moveBackward);
        direction.x = Number(moveRight) - Number(moveLeft);
        direction.normalize();

        const speed = isSprinting ? 750.0 : 400.0;
        if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
        if (moveLeft || moveRight) velocity.x -= direction.x * speed * delta;

        // ROBUST SLIDING COLLISION
        const playerObj = controls.getObject();
        const currentX = playerObj.position.x;
        const currentZ = playerObj.position.z;

        // Attempt to move along X axis
        controls.moveRight(-velocity.x * delta);
        if (checkCollision(playerObj.position)) {
            playerObj.position.x = currentX; 
            velocity.x = 0;
        }

        // Attempt to move along Z axis
        controls.moveForward(-velocity.z * delta);
        if (checkCollision(playerObj.position)) {
            playerObj.position.z = currentZ; 
            velocity.z = 0;
        }

        // Vertical movement
        playerObj.position.y += (velocity.y * delta);
        const floorY = getFloorHeight(playerObj.position.x, playerObj.position.z) + 7;
        if (playerObj.position.y < floorY) {
            velocity.y = 0;
            playerObj.position.y = floorY;
            canJump = true;
        }
        
        // Broadcast my position
        if (socket && playerObj) {
            const pos = playerObj.position;
            const rot = camera.rotation; 
            socket.emit('updatePosition', {
                x: pos.x, y: pos.y, z: pos.z,
                rx: rot.x, ry: rot.y, rz: rot.z
            });
        }
    }

    // Update nametags
    if (camera) {
        for (let id in otherPlayers) {
            const p = otherPlayers[id];
            const pos = p.group.position.clone();
            pos.y += 9; // above head
            pos.project(camera);
            
            if (pos.z < 1) { // In front of camera
                const x = (pos.x * .5 + .5) * window.innerWidth;
                const y = (pos.y * -.5 + .5) * window.innerHeight;
                p.tag.style.display = 'block';
                p.tag.style.left = `${x}px`;
                p.tag.style.top = `${y}px`;
                
                // Scale text based on distance
                const dist = controls.getObject().position.distanceTo(p.group.position);
                p.tag.style.fontSize = `${Math.max(10, 300 / dist)}px`;
            } else {
                p.tag.style.display = 'none';
            }
        }
    }

    prevTime = time;
    renderer.render(scene, camera);
}
