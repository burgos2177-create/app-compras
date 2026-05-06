// Firebase config — proyecto unificado sogrub-suite (decisión 2026-04-28).
// Esta app escribe sus datos bajo /shared/compras/* y lee usuarios + obras
// desde /legacy/estimaciones/*. El catálogo de conceptos vive en
// /shared/catalogos/{obraId} y las requisiciones de almacén en
// /shared/materiales/obras/{obraId}/requisiciones — ambos solo lectura desde acá.

export const firebaseConfig = {
  apiKey: "AIzaSyBjOrl1JW4Y383diRe4WO4rX5IF23UEN0k",
  authDomain: "sogrub-suite.firebaseapp.com",
  databaseURL: "https://sogrub-suite-default-rtdb.firebaseio.com",
  projectId: "sogrub-suite",
  storageBucket: "sogrub-suite.firebasestorage.app",
  messagingSenderId: "330378687274",
  appId: "1:330378687274:web:8be51640a6d9d7006ca453",
  measurementId: "G-98BM4PNBPP"
};

// Base path donde vive todo el dato de esta app dentro del RTDB compartido.
// Paths relativos en db.js se resuelven bajo este prefijo.
// Para escapes (lectura de /legacy/estimaciones/*, /shared/catalogos/*,
// /shared/materiales/*, /shared/buzon, /legacy/bitacora/*) usar paths con
// "/" inicial — se interpretan como absolutos.
export const APP_BASE_PATH = "shared/compras";
