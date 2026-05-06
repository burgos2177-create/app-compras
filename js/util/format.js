const fmtMxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum0 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const fmtPct = new Intl.NumberFormat('es-MX', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 });

export const money = (n) => fmtMxn.format(Number(n) || 0);
export const num = (n, dec = 2) => Number.isFinite(n) ? new Intl.NumberFormat('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n) : '—';
export const num2 = (n) => fmtNum.format(Number(n) || 0);
export const num0 = (n) => fmtNum0.format(Number(n) || 0);
export const pct = (n) => Number.isFinite(n) ? fmtPct.format(n) : '—';

export function dateISO(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return '';
  return x.toISOString().slice(0, 10);
}
export function dateMx(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return '';
  return x.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fromInputDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function reqFolio(numero) {
  return `R-${String(numero || 0).padStart(4, '0')}`;
}
export function ocFolio(numero) {
  return `OC-${String(numero || 0).padStart(4, '0')}`;
}
