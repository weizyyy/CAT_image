import { getSTContext, getSTHeaders } from './settings.js';
import { slErr } from './log.js';

export const archive = { version: 2, revision: 0, sessions: {} };
export const archiveFiles = ['cat-image-v2-a.json.gz', 'cat-image-v2-b.json.gz'];
export const recoveryCardId = ':recovered:';
let loaded = false;
let dirty = false;
let pending;
let failure;

export const chatFile = value => String(value || '').replace(/\.jsonl$/i, '');
export const sessionKey = (cardId, file) => cardId && file ? JSON.stringify([cardId, file]) : '';

export function currentCard(context = getSTContext()) {
    const character = !context.groupId && context.characters?.[context.characterId];
    return { id: character?.avatar || '', name: character?.data?.name || character?.name || '' };
}

export function currentSession(context = getSTContext()) {
    const card = currentCard(context);
    const file = chatFile(context.chatId || context.getCurrentChatId?.());
    return { card, file, key: sessionKey(card.id, file) };
}

export function getCharacterName() { return currentCard().name; }
export function getChatId() { return currentSession().key; }

export function sessionData(key = currentSession().key, create = false) {
    if (!key) return null;
    if (!Object.hasOwn(archive.sessions, key) && create) {
        const [cardId, file] = JSON.parse(key);
        archive.sessions[key] = { cardId, file, label: file, roster: {}, wardrobe: {}, gallery: {}, revisions: {}, images: {} };
    }
    return archive.sessions[key] || null;
}

export function cardSessions(cardId = currentCard().id) {
    return Object.entries(archive.sessions).filter(([, session]) => session.cardId === cardId);
}

export function accessibleSessions(card = currentCard()) {
    return Object.entries(archive.sessions).filter(([, session]) => ownsSession(session, card));
}

export function ownsSession(session, card = currentCard()) {
    return !!session && (session.cardId === card.id ||
        (session.cardId === recoveryCardId && session.originalCardName === card.name));
}

async function readArchiveFile(name) {
    const response = await fetch('/user/files/' + name, { headers: getSTHeaders(), cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('读取存档 HTTP ' + response.status);
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const state = await new Response(stream).json();
    if (state?.version !== 2 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !plainRecord(state.sessions) || Object.entries(state.sessions).some(([key, session]) => !validSession(key, session)))
        throw new Error('存档格式错误');
    return state;
}

function plainRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function validSession(key, session) {
    return plainRecord(session) && typeof session.cardId === 'string' && typeof session.file === 'string' &&
        key === sessionKey(session.cardId, session.file) && typeof session.label === 'string' &&
        ['roster', 'wardrobe', 'gallery', 'revisions', 'images'].every(field => plainRecord(session[field])) &&
        Object.values(session.revisions).every(record => plainRecord(record) && typeof record.source === 'string' &&
            typeof record.messageId === 'string' && Array.isArray(record.slots) &&
            record.slots.every(slot => plainRecord(slot) && typeof slot.id === 'string'));
}

export async function loadArchive() {
    const reads = await Promise.allSettled(archiveFiles.map(readArchiveFile));
    const valid = reads.flatMap(read => read.status === 'fulfilled' && read.value ? [read.value] : []);
    if (!valid.length && reads.some(read => read.status === 'rejected')) {
        throw new Error('无法读取角色档案和图库');
    }
    if (reads.some(read => read.status === 'rejected')) {
        slErr('一份存档检查点无法读取，已打开可用检查点');
        globalThis.toastr?.warning('一份存档检查点无法读取，已打开最近可用的存档。');
    }
    valid.sort((a, b) => b.revision - a.revision);
    archive.revision = valid[0]?.revision ?? 0;
    archive.sessions = valid[0]?.sessions ?? {};
    loaded = true;
}

async function writeArchiveFile(revision) {
    const snapshot = JSON.stringify({ ...archive, revision });
    const stream = new Blob([snapshot]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
    const response = await fetch('/api/files/upload', {
        method: 'POST', headers: { ...getSTHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: archiveFiles[revision % archiveFiles.length], data: btoa(binary) }),
    });
    if (!response.ok) throw new Error('写入存档 HTTP ' + response.status);
}

export function archiveSaveError() { return failure; }
export function flushArchive() { return pending ?? Promise.resolve(!failure); }

// One writer per window; a failed upload leaves the previous checkpoint intact.
export function saveArchive() {
    if (!loaded) return Promise.resolve(false);
    dirty = true;
    pending ??= Promise.resolve().then(async () => {
        try {
            while (dirty) {
                dirty = false;
                const revision = archive.revision + 1;
                await writeArchiveFile(revision);
                archive.revision = revision;
                failure = undefined;
            }
            return true;
        } catch (error) {
            if (!failure) globalThis.toastr?.error('角色档案或图库尚未保存，可从面板重试。');
            failure = error.message;
            dirty = true;
            slErr('档案与图库保存失败: ' + failure);
            return false;
        } finally {
            pending = undefined;
        }
    });
    return pending;
}
