import { h, mount } from '../util/dom.js?v=20260711i';
import { login } from '../services/auth.js?v=20260711i';

export function renderLogin() {
  const errBox = h('div', { class: 'err' }, '');
  const emailInput = h('input', { type: 'email', placeholder: 'tu@email.com', autofocus: true });
  const passInput = h('input', { type: 'password', placeholder: '••••••••' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');

  async function submit(e) {
    e.preventDefault();
    errBox.textContent = '';
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Entrando…';
    try {
      await login(emailInput.value.trim(), passInput.value);
    } catch (err) {
      errBox.textContent = parseAuthErr(err);
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }

  const card = h('div', { class: 'login-card' }, [
    h('h1', {}, 'Compras'),
    h('p', { class: 'sub' }, 'Departamento de compras · sogrub-suite'),
    h('form', { onSubmit: submit }, [
      h('div', { class: 'field' }, [h('label', {}, 'Correo'), emailInput]),
      h('div', { class: 'field' }, [h('label', {}, 'Contraseña'), passInput]),
      btn,
      errBox
    ])
  ]);

  mount('#app', h('div', { class: 'login-shell' }, card));
}

function parseAuthErr(err) {
  const msg = err?.message || '';
  if (msg.includes('invalid-credential') || msg.includes('wrong-password') || msg.includes('user-not-found'))
    return 'Credenciales incorrectas.';
  if (msg.includes('too-many-requests')) return 'Demasiados intentos. Espera unos minutos.';
  if (msg.includes('network')) return 'Sin conexión a Firebase.';
  return msg.replace('Firebase: ', '');
}
