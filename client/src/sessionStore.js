// Persistência de sessão ativa (não finalizada).
// Estratégia: localStorage (instantâneo) + servidor (sincroniza entre dispositivos).
// Fonte mais recente vence ao restaurar (compara lastSavedAt).

import { api } from './api';

const LS_PREFIX = 'allos_active_session__';

function lsKey(userId, type, itemId) {
  return `${LS_PREFIX}${userId}__${type}__${itemId}`;
}

export function loadLocal(userId, type, itemId) {
  try {
    const raw = localStorage.getItem(lsKey(userId, type, itemId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLocal(userId, type, itemId, data) {
  try {
    const payload = { ...data, lastSavedAt: new Date().toISOString() };
    localStorage.setItem(lsKey(userId, type, itemId), JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

export function clearLocal(userId, type, itemId) {
  try {
    localStorage.removeItem(lsKey(userId, type, itemId));
  } catch {}
}

// Carrega a sessão ativa de ambas as fontes (localStorage + servidor) e
// devolve a mais recente. Retorna null se nenhuma das fontes tiver dado.
export async function loadActiveSession(userId, type, itemId) {
  const local = loadLocal(userId, type, itemId);
  let remote = null;
  try {
    remote = await api.getActiveSession(type, itemId);
  } catch {
    // sem rede ou 401: usa só local
  }

  if (!local && !remote) return null;
  if (local && !remote) return local;
  if (remote && !local) return remote;

  const localTime = new Date(local.lastSavedAt || 0).getTime();
  const remoteTime = new Date(remote.lastSavedAt || 0).getTime();
  return remoteTime > localTime ? remote : local;
}

// Salva no localStorage imediatamente e dispara um POST para o servidor.
// O caller é responsável pelo debounce (não chamar isso a cada keystroke).
export async function saveActiveSession(userId, type, itemId, data) {
  const stored = saveLocal(userId, type, itemId, data);
  try {
    await api.saveActiveSession(type, itemId, data);
  } catch {
    // se falhar (rede, 401), o localStorage já garante a persistência local
  }
  return stored;
}

export async function clearActiveSession(userId, type, itemId) {
  clearLocal(userId, type, itemId);
  try {
    await api.clearActiveSession(type, itemId);
  } catch {}
}
