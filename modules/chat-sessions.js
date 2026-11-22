import { getSTContext, getSTHeaders } from './settings.js';
import { accessibleSessions, chatFile, currentCard, currentSession, sessionKey } from './archive.js';

export async function fetchCharacterChats(context = getSTContext()) {
    const { id } = currentCard(context);
    if (!id) return null;
    const response = await fetch('/api/characters/chats', {
        method: 'POST', headers: { ...getSTHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: id, simple: true }),
    });
    if (!response.ok) return null;
    const list = await response.json();
    if (!Array.isArray(list)) return null;
    const names = list.map(item => chatFile(item?.file_name));
    return names.every(Boolean) ? [...new Set(names)] : null;
}

export function describeCharacterChats(current = currentSession(), names = []) {
    const { card, key, file } = current;
    const openable = new Map(names.map(name => [sessionKey(card.id, name), name]));
    if (key) openable.set(key, file);
    const saved = new Map(accessibleSessions(card));
    const keys = new Set([...(key ? [key] : []), ...openable.keys(), ...saved.keys()]);
    return [...keys].map(id => {
        const openFile = openable.get(id);
        const session = saved.get(id);
        return { key: id, current: id === key, file: openFile, label: openFile || session?.label || session?.file };
    });
}

export async function listCharacterChats() {
    const context = getSTContext();
    const current = currentSession(context);
    const names = await fetchCharacterChats(context).catch(() => null);
    return describeCharacterChats(current, names || []);
}

export async function openCharacterSession(file) {
    const context = getSTContext();
    if (!file || typeof context.openCharacterChat !== 'function') return false;
    await context.openCharacterChat(file);
    return true;
}
