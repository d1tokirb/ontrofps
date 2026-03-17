// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyBv3CaldvoCVqHeJTgX0NK67IWLgS5yhD8",
    authDomain: "fps-game-5856d.firebaseapp.com",
    projectId: "fps-game-5856d",
    storageBucket: "fps-game-5856d.firebasestorage.app",
    messagingSenderId: "928856366705",
    appId: "1:928856366705:web:e68399377f51ab690205d0",
    measurementId: "G-V2MCFECZJ0"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

// DOM Elements
const authSection = document.getElementById('auth-section');
const playSection = document.getElementById('play-section');
const userDisplayName = document.getElementById('user-display-name');
const playerNameInput = document.getElementById('player-name');
const authError = document.getElementById('auth-error');

const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');

const loginBtn = document.getElementById('login-btn');
const signupBtn = document.getElementById('signup-btn');
const googleLoginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');

// Listen for auth state changes
auth.onAuthStateChanged(user => {
    if (user) {
        // User is signed in.
        authSection.classList.add('hidden');
        playSection.classList.remove('hidden');
        
        // Add a small animation effect
        playSection.style.animation = 'none';
        playSection.offsetHeight; /* trigger reflow */
        playSection.style.animation = "slideInRight 0.5s cubic-bezier(0.25, 0.8, 0.25, 1) forwards";
        
        let dName = user.displayName || user.email.split('@')[0];
        userDisplayName.innerText = dName;
        playerNameInput.value = dName;
    } else {
        // No user is signed in.
        authSection.classList.remove('hidden');
        playSection.classList.add('hidden');
        
        authSection.style.animation = 'none';
        authSection.offsetHeight; /* trigger reflow */
        authSection.style.animation = "slideInRight 0.5s cubic-bezier(0.25, 0.8, 0.25, 1) forwards";
    }
});

function showError(msg) {
    authError.innerText = msg;
    authError.style.display = 'block';
}

loginBtn.addEventListener('click', () => {
    const email = emailInput.value;
    const password = passwordInput.value;
    if(!email || !password) return showError("Email and password required.");
    
    authError.style.display = 'none';
    auth.signInWithEmailAndPassword(email, password)
        .catch(error => showError(error.message));
});

signupBtn.addEventListener('click', () => {
    const email = emailInput.value;
    const password = passwordInput.value;
    if(!email || !password) return showError("Email and password required.");

    authError.style.display = 'none';
    auth.createUserWithEmailAndPassword(email, password)
        .catch(error => showError(error.message));
});

googleLoginBtn.addEventListener('click', () => {
    authError.style.display = 'none';
    auth.signInWithPopup(googleProvider)
        .catch(error => showError(error.message));
});

logoutBtn.addEventListener('click', () => {
    auth.signOut();
});
