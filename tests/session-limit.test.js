import { describe, it, expect, afterEach } from 'vitest';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../client/src/sessionLimit.js';

// Lógica do cronômetro de sessão: conta SÓ quando a aba/app está visível
// (pessoa no chat) e trava no limite de 200 min.
describe('sessionLimit', () => {
  afterEach(() => { delete globalThis.document; });

  it('o limite é 200 minutos (12000s)', () => {
    expect(SESSION_LIMIT_MINUTES).toBe(200);
    expect(SESSION_LIMIT_SECONDS).toBe(200 * 60);
  });

  it('incrementa 1s por tick quando visível', () => {
    globalThis.document = { visibilityState: 'visible' };
    expect(nextActiveElapsed(0)).toBe(1);
    expect(nextActiveElapsed(41)).toBe(42);
  });

  it('NÃO conta quando a aba está escondida (fora do chat / app em background)', () => {
    globalThis.document = { visibilityState: 'hidden' };
    expect(nextActiveElapsed(10)).toBe(10);
    expect(nextActiveElapsed(0)).toBe(0);
  });

  it('trava no teto do limite e nunca ultrapassa', () => {
    globalThis.document = { visibilityState: 'visible' };
    expect(nextActiveElapsed(SESSION_LIMIT_SECONDS - 1)).toBe(SESSION_LIMIT_SECONDS);
    expect(nextActiveElapsed(SESSION_LIMIT_SECONDS)).toBe(SESSION_LIMIT_SECONDS);
    expect(nextActiveElapsed(SESSION_LIMIT_SECONDS + 999)).toBe(SESSION_LIMIT_SECONDS);
  });

  it('trata valores inválidos como 0', () => {
    globalThis.document = { visibilityState: 'visible' };
    expect(nextActiveElapsed(undefined)).toBe(1);
    expect(nextActiveElapsed(NaN)).toBe(1);
  });
});
