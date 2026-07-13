import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { formatDate } from '../lib/format.js';

const ROLE_LABEL = { admin: 'Administrador', author: 'Autor' };

function buildAvatar(username, avatar) {
  if (avatar) return h('img', { class: 'avatar-lg', src: avatar, alt: 'foto de perfil' });
  return h('div', { class: 'avatar-lg avatar-fallback' }, (username || '?').charAt(0).toUpperCase());
}

export async function render({ view }) {
  clear(view);

  const me = await api.me().catch(() => ({ ok: false }));
  if (!me.ok || !me.data?.user) {
    navigate('/login');
    return;
  }
  const { username, role, avatar, created_at } = me.data.user;

  // --- Avatar + upload control ---
  const avatarWrap = h('div', { class: 'avatar-wrap' }, buildAvatar(username, avatar));
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    style: { display: 'none' },
  });
  const avatarError = h('p', { class: 'error-text' });
  const avatarSuccess = h('p', { class: 'success-text' });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    avatarError.textContent = '';
    avatarSuccess.textContent = '';
    const { ok, status, data } = await api.uploadAvatar(file);
    if (!ok) {
      avatarError.textContent =
        status === 415
          ? 'Formato de imagem não suportado.'
          : status === 413
            ? 'Imagem muito grande (máx. 5 MB).'
            : 'Falha ao enviar a imagem.';
      return;
    }
    avatarSuccess.textContent = 'Foto atualizada.';
    avatarWrap.replaceChildren(buildAvatar(username, data.avatar));
    fileInput.value = '';
  });

  const avatarCard = h(
    'div',
    { class: 'profile-card avatar-card' },
    avatarWrap,
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => fileInput.click() }, 'Alterar foto'),
    fileInput,
    avatarError,
    avatarSuccess
  );

  // --- Profile summary ---
  const summary = h(
    'div',
    { class: 'profile-card' },
    h('h2', null, 'Meu perfil'),
    h(
      'dl',
      { class: 'profile-fields' },
      h('dt', null, 'Usuário'),
      h('dd', null, username),
      h('dt', null, 'Função'),
      h('dd', null, ROLE_LABEL[role] || role),
      h('dt', null, 'Membro desde'),
      h('dd', null, formatDate(created_at) || '—')
    )
  );

  // --- Change password ---
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'mín. 8 caracteres', required: true });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'confirmar nova senha', required: true });
  const pwError = h('p', { class: 'error-text' });
  const pwSuccess = h('p', { class: 'success-text' });

  const pwForm = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        pwError.textContent = '';
        pwSuccess.textContent = '';
        if (next.value !== confirm.value) {
          pwError.textContent = 'As novas senhas não conferem.';
          return;
        }
        const { ok, status, data } = await api.changePassword(current.value, next.value);
        if (!ok) {
          if (status === 401) pwError.textContent = 'Senha atual incorreta.';
          else if (status === 400 && Array.isArray(data?.details)) {
            pwError.textContent = data.details.map((d) => d.message).join(' ');
          } else {
            pwError.textContent = 'Não foi possível alterar a senha.';
          }
          return;
        }
        pwSuccess.textContent = 'Senha alterada com sucesso.';
        current.value = '';
        next.value = '';
        confirm.value = '';
      },
    },
    h('h3', null, 'Alterar senha'),
    h('div', { class: 'field' }, h('label', null, 'Senha atual'), current),
    h('div', { class: 'field' }, h('label', null, 'Nova senha'), next),
    h('div', { class: 'field' }, h('label', null, 'Confirmar nova senha'), confirm),
    pwError,
    pwSuccess,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvar senha')
  );

  // --- Subscription plan (placeholder for future) ---
  const plan = h(
    'div',
    { class: 'profile-card' },
    h('h3', null, 'Plano de assinatura'),
    h('p', { class: 'muted' }, 'Você ainda não tem um plano ativo.'),
    h(
      'button',
      { class: 'btn btn-ghost', type: 'button', disabled: true, title: 'Em breve' },
      'Gerenciar plano (em breve)'
    )
  );

  view.append(
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { style: { maxWidth: '520px', margin: '0 auto' } },
        avatarCard,
        summary,
        h('div', { class: 'profile-section' }, pwForm),
        h('div', { class: 'profile-section' }, plan),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/admin') }, 'Voltar')
        )
      )
    )
  );
}
