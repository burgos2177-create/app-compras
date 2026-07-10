import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { auth, firebaseConfig } from './firebase.js?v=20260619';
import { rread, rset, rupdate } from './db.js?v=20260619';

// Mismo patrón que app-materiales: signUp via REST para no perder la sesión
// del admin. La fuente única de usuarios está en /legacy/estimaciones/users.
const REST = 'https://identitytoolkit.googleapis.com/v1/accounts';

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export function logout() { return signOut(auth); }
export function onAuth(cb) { return onAuthStateChanged(auth, cb); }

export async function getUserProfile(uid) {
  return await rread(`/legacy/estimaciones/users/${uid}`);
}

export async function createUser({ email, password, displayName, role = 'comprador' }) {
  const r = await fetch(`${REST}:signUp?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Error creando usuario');
  const uid = data.localId;
  await rset(`/legacy/estimaciones/users/${uid}`, {
    email, displayName: displayName || email,
    role, createdAt: Date.now()
  });
  return { uid, email, displayName, role };
}

export async function updateUserRole(uid, role) {
  await rupdate(`/legacy/estimaciones/users/${uid}`, { role });
}

export async function setUserAssignment(uid, obraId, assigned) {
  await rset(`/legacy/estimaciones/users/${uid}/obrasAsignadas/${obraId}`, assigned ? true : null);
}
