import { describe, it, expect } from 'vitest';
import { avatarErrorMessage } from '../pages/profile.js';

describe('avatarErrorMessage', () => {
  it('maps upload-validation statuses to user-input messages', () => {
    expect(avatarErrorMessage(415)).toBe('Formato de imagem não suportado.');
    expect(avatarErrorMessage(413)).toBe('Imagem muito grande (máx. 5 MB).');
    expect(avatarErrorMessage(400)).toBe('Arquivo inválido. Selecione uma imagem.');
  });

  it('treats a session expiry (401) distinctly from a bad file', () => {
    expect(avatarErrorMessage(401)).toBe('Sua sessão expirou. Faça login novamente.');
  });

  it('does not blame the user for server-side failures (5xx)', () => {
    const message = avatarErrorMessage(500);
    expect(message).toBe('Erro no servidor ao salvar a imagem. Tente novamente mais tarde.');
    expect(avatarErrorMessage(503)).toBe(message);
    // A server error must not imply the uploaded image was invalid/unsupported.
    expect(message).not.toMatch(/suportado|inválido|grande/i);
  });

  it('falls back to a generic upload failure for other client errors', () => {
    expect(avatarErrorMessage(409)).toBe('Falha ao enviar a imagem.');
  });
});
