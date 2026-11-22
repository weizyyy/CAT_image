import { archive, accessibleSessions, cardSessions, currentSession, ownsSession, recoveryCardId, sessionData, saveArchive } from './archive.js';
import { fetchCharacterChats } from './chat-sessions.js';

function ownSession(key) {
    const session = sessionData(key);
    return ownsSession(session) ? session : null;
}

export function galleryAdd(url, { kind = 'chat', scene = '', chatKey = currentSession().key, blockId } = {}) {
    if (typeof url !== 'string' || !url) return null;
    const session = sessionData(chatKey, true);
    if (!session) return null;
    // Use the complete URL so identically named files in different directories can coexist.
    const entry = session.gallery[url] ||= { ts: Date.now(), url, kind, scene: String(scene).slice(0, 120) };
    if (blockId && session.images[blockId] !== url) session.images = { ...session.images, [blockId]: url };
    void saveArchive();
    return entry;
}

export function galleryList() {
    const { card, key } = currentSession();
    const records = [...accessibleSessions(card), ...cardSessions(recoveryCardId).filter(([, s]) => !s.originalCardName)];
    return records.flatMap(([chatKey, session]) => {
        const items = Object.values(session.gallery).sort((a, b) => b.ts - a.ts);
        if (!items.length) return [];
        return [{ chatKey, current: chatKey === key, label: session.label, newest: items[0].ts, items, selectable: ownsSession(session, card) }];
    }).sort((a, b) => Number(b.current) - Number(a.current) || b.newest - a.newest);
}

export function galleryCacheSource(chatKey = currentSession().key) {
    const session = ownSession(chatKey);
    const source = session?.cacheSource && ownSession(session.cacheSource);
    return source && Object.keys(source.gallery).length ? session.cacheSource : '';
}

export function setGalleryCacheSource(source, chatKey = currentSession().key) {
    if (!chatKey || source === chatKey || (source && !Object.keys(ownSession(source)?.gallery || {}).length)) return false;
    const session = sessionData(chatKey, true);
    if (source) session.cacheSource = source;
    else delete session.cacheSource;
    void saveArchive();
    return true;
}

export function galleryCount() {
    return galleryList().reduce((sum, group) => sum + group.items.length, 0);
}

export function galleryRemove(chatKey, url) {
    const session = ownSession(chatKey);
    if (!session || !Object.hasOwn(session.gallery, url)) return false;
    delete session.gallery[url];
    void saveArchive();
    return true;
}

export function galleryClearChat(chatKey) {
    const session = ownSession(chatKey);
    if (!session) return 0;
    const count = Object.keys(session.gallery).length;
    session.gallery = {};
    void saveArchive();
    return count;
}

export async function galleryPrune() {
    const { card, file } = currentSession();
    const names = await fetchCharacterChats().catch(() => null);
    if (!names || card.id !== currentSession().card.id) return { ok: false };
    const alive = new Set([...names, file, currentSession().file]);
    let removedChats = 0, removedImages = 0, removedCaches = 0;
    for (const [key, session] of cardSessions(card.id)) {
        // Unmatched migrated records have no corresponding chat filename to compare.
        if (session.unmatched || alive.has(session.file)) continue;
        const images = Object.keys(session.gallery).length;
        const caches = Object.keys(session.revisions).length;
        if (!images && !caches && !Object.keys(session.images).length) continue;
        session.gallery = {};
        session.revisions = {};
        session.images = {};
        removedChats++;
        removedImages += images;
        removedCaches += caches;
        for (const other of Object.values(archive.sessions)) if (other.cacheSource === key) delete other.cacheSource;
    }
    if (removedChats && !await saveArchive()) return { ok: false, saveFailed: true };
    return { ok: true, removedChats, removedImages, removedCaches };
}
