// Firebase web config for project "claude-session-dashboard".
// apiKey is NOT a secret — Security Rules are the real gate (see firestore.rules).
export const firebaseConfig = {
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  storageBucket: 'claude-session-dashboard.firebasestorage.app',
  messagingSenderId: '554148503524',
  appId: '1:554148503524:web:01228763f9d7ca882571f1',
  // Default RTDB URL convention; created when the user enables Realtime Database.
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
};

/** When true, clients should connect to the local Emulator Suite, not the cloud. */
export const USE_EMULATORS =
  (typeof process !== 'undefined' && process.env?.USE_FIREBASE_EMULATORS === '1') ||
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_USE_EMULATORS === '1');

export const EMULATOR_HOSTS = {
  auth: 'http://127.0.0.1:9099',
  firestore: { host: '127.0.0.1', port: 8080 },
  database: { host: '127.0.0.1', port: 9000 },
};
