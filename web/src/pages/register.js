import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

export async function render({ view }) {
  clear(view);

  const me = await api.me().catch(() => ({ ok: false }));
  const isAdmin = me.ok && me.data?.user?.role === 'admin';

  if (!isAdmin) {
    view.append(
      h(
        'div',
        { class: 'container' },
        h(
          'div',
          { style: { maxWidth: '420px', margin: '0 auto' } },
          h('h2', null, 'Acesso restrito'),
          h('p', null, 'Apenas administradores podem registrar novos usuários.'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/admin') }, 'Voltar')
        )
      )
    );
    return;
  }

  const username = h('input', { type: 'text', autocomplete: 'username', placeholder: 'usuário', required: true });
  const password = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: 'senha (mín. 8 caracteres)',
    required: true,
  });
  const confirm = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: 'confirmar senha',
    required: true,
  });
  const role = h(
    'select',
    null,
    h('option', { value: 'author' }, 'Autor'),
    h('option', { value: 'admin' }, 'Administrador')
  );
  const error = h('p', { class: 'error-text' });
  const success = h('p', { class: 'success-text' });

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        success.textContent = '';
        if (password.value !== confirm.value) {
          error.textContent = 'As senhas não conferem.';
          return;
        }
        const { ok, status, data } = await api.register(username.value.trim(), password.value, role.value);
        if (!ok) {
          if (status === 409) error.textContent = 'Este usuário já existe.';
          else if (status === 400 && Array.isArray(data?.details)) {
            error.textContent = data.details.map((d) => d.message).join(' ');
          } else {
            error.textContent = 'Não foi possível registrar. Tente novamente.';
          }
          return;
        }
        success.textContent = `Usuário "${data.user.username}" criado com sucesso como ${data.user.role}.`;
        username.value = '';
        password.value = '';
        confirm.value = '';
      },
    },
    h('h2', null, 'Registrar usuário'),
    h('p', null, 'Cria uma nova conta. O auto-cadastro está desativado; apenas administradores podem registrar usuários.'),
    h('div', { class: 'field' }, h('label', null, 'Usuário'), username),
    h('div', { class: 'field' }, h('label', null, 'Senha'), password),
    h('div', { class: 'field' }, h('label', null, 'Confirmar senha'), confirm),
    h('div', { class: 'field' }, h('label', null, 'Função'), role),
    error,
    success,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Registrar'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/admin') }, 'Voltar')
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
