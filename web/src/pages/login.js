import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

export async function render({ view }) {
  clear(view);

  const username = h('input', { type: 'text', autocomplete: 'username', placeholder: 'usuário', required: true });
  const password = h('input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: 'senha',
    required: true,
  });
  const error = h('p', { class: 'error-text' });

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        const { ok } = await api.login(username.value, password.value);
        if (!ok) {
          error.textContent = 'Credenciais inválidas. Tente novamente.';
          return;
        }
        navigate('/admin');
      },
    },
    h('h2', null, 'Entrar no painel'),
    h('div', { class: 'field' }, h('label', null, 'Usuário'), username),
    h('div', { class: 'field' }, h('label', null, 'Senha'), password),
    error,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Entrar'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/') }, 'Cancelar')
    )
  );

  view.append(
    h(
      'div',
      { class: 'container' },
      h('div', { style: { maxWidth: '420px', margin: '0 auto' } }, form)
    )
  );
  username.focus();
}
