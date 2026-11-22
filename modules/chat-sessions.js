import { getSTContext, getSTHeaders, settings } from './settings.js';
import { getCharacterName, getChatId } from './pipeline/profile.js';

const normalize = value => String(value || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '');

export function characterChatKey(character, file) {
    return normalize(character) + '_' + normalize(file);
}

export function cachedChatKey(messageKey) {
    return messageKey.match(/^(.*)_(?:\d+|fe-\w+)_v2_/u)?.[1];
}

export function characterChatKeys(charName = getCharacterName()) {
    return new Set([
        ...Object.keys(settings.roster?.[charName] || {}),
        ...Object.keys(settings.gallery?.[charName] || {}),
        ...Object.keys(settings.profiles?.[charName]?.chats || {}),
    ]);
}

export async function fetchCharacterChats(context = getSTContext()) {
    const character = context.characters?.[context.characterId];
    if (!character?.avatar) return null;
    const response = await fetch('/api/characters/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getSTHeaders() },
        body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
    });
    if (!response.ok) return null;
    const list = await response.json();
    if (!Array.isArray(list)) return null;
    return list.map(item => String(item?.file_name || '').replace(/\.jsonl$/i, '')).filter(Boolean);
}

export async function listCharacterChats() {
    const context = getSTContext();
    const charName = getCharacterName(), current = getChatId();
    const names = await fetchCharacterChats(context).catch(() => null);
    const files = new Map();
    const prefix = normalize(charName) + '_';
    for (const name of names || []) {
        const key = characterChatKey(charName, name);
        // Normalization can collapse two filenames. Do not open an ambiguous entry.
        files.set(key, files.has(key) ? null : name);
    }
    const rawCurrent = context.chatId || context.chatMetadata?.chat_name || context.chat_metadata?.chat_name;
    if (rawCurrent) files.set(current, String(rawCurrent).replace(/\.jsonl$/i, ''));
    const keys = new Set([current, ...files.keys(), ...characterChatKeys(charName)]);
    return [...keys].map(key => ({
        key, current: key === current, file: files.get(key),
        label: files.get(key) || (key.startsWith(prefix) ? key.slice(prefix.length) : key),
    }));
}

export async function openCharacterSession(file) {
    const context = getSTContext();
    if (!file || typeof context.openCharacterChat !== 'function') return false;
    await context.openCharacterChat(file);
    return true;
}
