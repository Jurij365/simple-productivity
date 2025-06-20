// === App State & Configuration ===
const DB_NAME = 'FocusTrackerDB';
const DB_VERSION = 1;
const STORE_NAME = 'dailyData';
let db;

// In-memory state variables.
let totalFocusedMs = 0;
let totalDistractedMs = 0;
let currentState = null; // 'focus', 'distract', or null
let lastStateChangeTimestamp = null; // A JavaScript Date object

let currentUser = null;
let firestoreListener = null;
let tickInterval = null;

// --- UI Element References ---
const greenBtn = document.getElementById('greenBtn');
const redBtn = document.getElementById('redBtn');
const stopBtn = document.getElementById('stopBtn');
const focusTimeEl = document.getElementById('focusTime');
const distractTimeEl = document.getElementById('distractTime');
const focusPercentEl = document.getElementById('focusPercent');
const bodyEl = document.body;
const googleSignInBtn = document.getElementById('googleSignInBtn');
const logoutButton = document.getElementById('logoutButton');
const userInfoEl = document.getElementById('userInfo');
const syncMessageEl = document.getElementById('syncMessage');


// === 1. Application Initialization ===
function initializeApp() {
  // Register auth listener and handle redirect immediately, before DB setup.
  auth.onAuthStateChanged(handleAuthStateChange);
  handleRedirectResult();

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'date' });
    }
  };
  request.onsuccess = e => {
    db = e.target.result;
    // If auth state is already known to be logged out, we can now load local data.
    if (!currentUser) {
        handleLoggedOutUser();
    }
  };
  request.onerror = e => {
      console.error('IndexedDB error:', e.target.errorCode);
      // DB failed to open (e.g., private browsing). App will run in memory-only mode.
      // We still need to ensure the UI starts correctly for a logged-out user.
      if (!currentUser) {
          handleLoggedOutUser();
      }
  };
}

// === 2. Core State Controller: The Authentication Router ===
function handleAuthStateChange(user) {
  if (firestoreListener) firestoreListener();
  if (tickInterval) clearInterval(tickInterval);
  resetStateInMemory();

  currentUser = user;
  updateAuthUI(user);

  if (user) {
    handleLoggedInUser(user);
  } else {
    // Will use DB if available, otherwise will just start the ticker.
    handleLoggedOutUser();
  }
}

// === 3a. Logged-Out User Logic (Local-First) ===
function handleLoggedOutUser() {
  // If IndexedDB is not available (e.g., private browsing), just start the UI.
  if (!db) {
    startTick();
    return;
  }

  const todayKey = getTodayKey();
  const tx = db.transaction([STORE_NAME], 'readonly');
  const req = tx.objectStore(STORE_NAME).get(todayKey);
  req.onsuccess = e => {
    const data = e.target.result;
    if (data) {
      totalFocusedMs = data.totalFocusedMs || 0;
      totalDistractedMs = data.totalDistractedMs || 0;
      currentState = data.currentState || null;
      lastStateChangeTimestamp = data.lastStateChangeTimestamp ? new Date(data.lastStateChangeTimestamp) : null;
    }
    startTick();
  };
  req.onerror = () => {
    console.error("Could not read from IndexedDB.");
    startTick(); // Start UI anyway.
  };
}

// === 3b. Logged-In User Logic (Cloud-First & Authoritative) ===
function handleLoggedInUser(user) {
  const recordRef = firestore.collection('users').doc(user.uid).collection('records').doc(getTodayKey());

  firestoreListener = recordRef.onSnapshot(async doc => {
    syncMessageEl.style.display = 'block';
    const serverData = doc.data();
    
    const migrationDataJSON = sessionStorage.getItem('dataToMigrate');
    if (migrationDataJSON) {
        const dataToMigrate = JSON.parse(migrationDataJSON);
        sessionStorage.removeItem('dataToMigrate');

        const migratedData = {
            totalFocusedMs: (serverData?.totalFocusedMs || 0) + dataToMigrate.totalFocusedMs,
            totalDistractedMs: (serverData?.totalDistractedMs || 0) + dataToMigrate.totalDistractedMs,
            currentState: dataToMigrate.currentState,
            lastStateChangeTimestamp: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await recordRef.set(migratedData, { merge: true });
        await deleteLocalRecord(getTodayKey());
        return; 
    }

    if (serverData) {
      totalFocusedMs = serverData.totalFocusedMs || 0;
      totalDistractedMs = serverData.totalDistractedMs || 0;
      currentState = serverData.currentState || null;
      lastStateChangeTimestamp = serverData.lastStateChangeTimestamp?.toDate();
    } else {
      await recordRef.set(getCurrentStateAsObject(false, true));
    }
    
    startTick();
    syncMessageEl.style.display = 'none';
  }, error => {
      console.error("Firestore listener failed:", error);
      syncMessageEl.textContent = "Cloud connection error.";
  });
}

// === 4. User Actions & State Changes ===
async function handleStateChange(newState) {
  if (currentState && lastStateChangeTimestamp) {
    const elapsed = Date.now() - lastStateChangeTimestamp.getTime();
    if (currentState === 'focus') totalFocusedMs += elapsed;
    if (currentState === 'distract') totalDistractedMs += elapsed;
  }

  currentState = newState;
  lastStateChangeTimestamp = new Date();

  if (currentUser) {
    const recordRef = firestore.collection('users').doc(currentUser.uid).collection('records').doc(getTodayKey());
    await recordRef.set(getCurrentStateAsObject(false, true), { merge: true });
  } else {
    // Guard against no DB. State changes will be in-memory only.
    if (!db) return; 
    const tx = db.transaction([STORE_NAME], 'readwrite');
    tx.objectStore(STORE_NAME).put(getCurrentStateAsObject(true));
  }
}

// === 5. The Login Process (with Redirect) ===
googleSignInBtn.addEventListener('click', async () => {
    // First, check for local data and stage it for migration.
    if (db) {
        try {
            const localData = await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE_NAME], 'readonly');
                const req = tx.objectStore(STORE_NAME).get(getTodayKey());
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = (e) => reject(e.target.error);
            });

            if (localData && (localData.totalFocusedMs > 0 || localData.totalDistractedMs > 0)) {
                sessionStorage.setItem('dataToMigrate', JSON.stringify({
                    totalFocusedMs: localData.totalFocusedMs,
                    totalDistractedMs: localData.totalDistractedMs,
                    currentState: localData.currentState
                }));
            }
        } catch (error) {
            console.error("Could not read local data before sign-in:", error);
        }
    }
    
    // Finally, trigger the sign-in flow. Use a popup on mobile browsers
    // because the redirect flow can fail to pass the auth result back.
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        if (isMobileDevice()) {
            await auth.signInWithPopup(provider);
        } else {
            await auth.signInWithRedirect(provider);
        }
    } catch (error) {
        console.error("Google sign-in failed:", error);
    }
});

async function handleRedirectResult() {
    try {
        await auth.getRedirectResult();
    } catch (error) {
        console.error("Error handling redirect result:", error);
    }
}

logoutButton.addEventListener('click', () => auth.signOut());

// === 6. UI & Display Logic ===
function updateDisplay() {
  let displayFocus = totalFocusedMs;
  let displayDistract = totalDistractedMs;

  if (currentState && lastStateChangeTimestamp) {
    const elapsed = Date.now() - lastStateChangeTimestamp.getTime();
    if (currentState === 'focus') displayFocus += elapsed;
    if (currentState === 'distract') displayDistract += elapsed;
  }

  focusTimeEl.textContent = formatTime(displayFocus);
  distractTimeEl.textContent = formatTime(displayDistract);
  const total = displayFocus + displayDistract;
  focusPercentEl.textContent = `${total > 0 ? (displayFocus / total * 100).toFixed(1) : '0.0'}%`;
  
  setVisualState(currentState);
}

function setVisualState(state) {
  bodyEl.classList.toggle('focus-active', state === 'focus');
  bodyEl.classList.toggle('distract-active', state === 'distract');
  greenBtn.classList.toggle('active-btn', state === 'focus');
  redBtn.classList.toggle('active-btn', state === 'distract');
  greenBtn.classList.toggle('inactive-btn', state === 'distract');
  redBtn.classList.toggle('inactive-btn', state === 'focus');
  stopBtn.style.display = state ? 'block' : 'none';
}

function updateAuthUI(user) {
  googleSignInBtn.style.display = user ? 'none' : 'block';
  logoutButton.style.display = user ? 'block' : 'none';
  userInfoEl.textContent = user ? `Hi, ${user.displayName?.split(' ')[0]}` : '';
}

// === 7. Utility Functions ===
function startTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(updateDisplay, 1000);
}

function resetStateInMemory() {
  totalFocusedMs = 0;
  totalDistractedMs = 0;
  currentState = null;
  lastStateChangeTimestamp = null;
}

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function getTodayKey() { return new Date().toISOString().slice(0, 10); }

function getCurrentStateAsObject(forLocalDb = false, forFirestore = false) {
    const state = {
        date: getTodayKey(),
        totalFocusedMs,
        totalDistractedMs,
        currentState,
        lastStateChangeTimestamp: null
    };

    if (forLocalDb && lastStateChangeTimestamp) {
        state.lastStateChangeTimestamp = lastStateChangeTimestamp.toISOString();
    }
    if (forFirestore) {
        state.lastStateChangeTimestamp = firebase.firestore.FieldValue.serverTimestamp();
    }
    return state;
}

function isMobileDevice() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
        return navigator.userAgentData.mobile;
    }
    return /android|iphone|ipad|ipod|iemobile|mobile/i.test(navigator.userAgent);
}

async function deleteLocalRecord(dateKey) {
    if (!db) return;
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        tx.objectStore(STORE_NAME).delete(dateKey);
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

// Add event listeners for the buttons
greenBtn.addEventListener('click', () => handleStateChange('focus'));
redBtn.addEventListener('click', () => handleStateChange('distract'));
stopBtn.addEventListener('click', () => handleStateChange(null));

// --- Kick off the application ---
initializeApp();
