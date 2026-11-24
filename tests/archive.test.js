import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { initSettings, loadPreferences, saveSettings, settings } from '../modules/settings.js';
import { galleryAdd, galleryList, galleryPrune, galleryRemove } from '../modules/gallery.js';
import { archive, archiveFiles, archiveSaveError, flushArchive, loadArchive, saveArchive, sessionData, sessionKey } from '../modules/archive.js';
import { deleteChatRoster } from '../modules/roster.js';

test('the archive preserves complete snapshots through retries and loads the newest readable checkpoint', async () => {
    const files = new Map();
    const writes = [];
    const context = { chatId: 'A @ 12:30', characterId: 0, characters: [{ avatar: 'card-a.png' }], getRequestHeaders: () => ({}) };
    initSettings(() => context, {});
    let rejectWrite = false;
    globalThis.fetch = async (url, options) => {
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            writes.push(name);
            files.set(name, rejectWrite ? Buffer.from('incomplete') : Buffer.from(data, 'base64'));
            return new Response(null, { status: rejectWrite ? 503 : 200 });
        }
        const bytes = files.get(url.split('/').at(-1));
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    };
    await loadArchive();
    const key = sessionKey('card-a.png', context.chatId);
    sessionData(key, true).roster.alice = { name: 'Alice', anchor: 'eyes:green' };
    galleryAdd('/user/images/one/image.png', { blockId: 'slot-a' });
    galleryAdd('/user/images/two/image.png', { blockId: 'slot-b' });
    assert.equal(await saveArchive(), true);
    assert.deepEqual(writes, [archiveFiles[1]]);
    const first = JSON.parse(gunzipSync(files.get(archiveFiles[1])));
    assert.equal(first.sessions[key].images['slot-b'], '/user/images/two/image.png');
    assert.equal(Object.keys(first.sessions[key].gallery).length, 2);

    rejectWrite = true;
    assert.equal(galleryRemove(key, '/user/images/one/image.png'), true);
    assert.equal(await saveArchive(), false);
    assert.match(archiveSaveError(), /503/);
    assert.equal(archive.revision, 1);
    const fallback = await import('../modules/archive.js?fallback');
    await fallback.loadArchive();
    assert.equal(Object.keys(fallback.archive.sessions[key].gallery).length, 2);

    rejectWrite = false;
    assert.equal(await saveArchive(), true);
    const reopened = await import('../modules/archive.js?reopened');
    await reopened.loadArchive();
    assert.equal(reopened.archive.revision, 2);
    assert.deepEqual(Object.keys(reopened.archive.sessions[key].gallery), ['/user/images/two/image.png']);
    assert.equal(reopened.archive.sessions[key].roster.alice.anchor, 'eyes:green');
    assert.equal(reopened.archive.sessions[key].images['slot-a'], '/user/images/one/image.png');
});

test('archive pruning follows complete filenames and never drops a different card or its roster', async () => {
    const context = { chatId: 'A @ 1230', characterId: 0, characters: [{ avatar: 'card-a.png' }], getRequestHeaders: () => ({}) };
    initSettings(() => context, {});
    const previousFetch = fetch;
    globalThis.fetch = (url, options) => url === '/api/characters/chats'
        ? Promise.resolve(Response.json([{ file_name: 'A @ 1230.jsonl' }])) : previousFetch(url, options);
    const deletedKey = sessionKey('card-a.png', 'A @ 12:30');
    const otherKey = sessionKey('card-b.png', 'A @ 12:30');
    sessionData(otherKey, true).gallery['/other.png'] = { url: '/other.png', ts: 1 };
    galleryAdd('/active.png', { blockId: 'active' });
    const report = await galleryPrune();
    assert.deepEqual(report, { ok: true, removedChats: 1, removedImages: 1, removedCaches: 0 });
    assert.equal(sessionData(deletedKey).roster.alice.anchor, 'eyes:green');
    assert.deepEqual(sessionData(deletedKey).images, {});
    assert.deepEqual(galleryList().flatMap(g => g.items.map(i => i.url)), ['/active.png']);
    assert.ok(sessionData(otherKey).gallery['/other.png']);
    globalThis.fetch = previousFetch;
});

test('deleting one historical roster persists without removing its image data or other chat rosters', async () => {
    const context = { chatId: 'active', characterId: 0, characters: [{ avatar: 'card.png' }], getRequestHeaders: () => ({}) };
    initSettings(() => context, {});
    const savedFetch = fetch;
    let checkpoint;
    globalThis.fetch = async (url, options) => {
        if (url !== '/api/files/upload') return new Response(null, { status: 404 });
        checkpoint = JSON.parse(gunzipSync(Buffer.from(JSON.parse(options.body).data, 'base64')));
        return new Response(null, { status: 200 });
    };
    try {
        await loadArchive();
        const current = sessionKey('card.png', 'active');
        const historical = sessionKey('card.png', 'deleted');
        const foreign = sessionKey('unrelated.png', 'deleted');
        for (const key of [current, historical, foreign]) sessionData(key, true).roster.Alice = { anchor: 'eyes:green' };
        const record = sessionData(historical);
        record.wardrobe.coat = { detail: 'wool coat' };
        record.gallery['/archive.png'] = { url: '/archive.png' };
        record.images.slot = '/archive.png';
        record.revisions.revision = { source: '[img:test]', messageId: '1', slots: [{ id: 'slot' }] };
        const retained = structuredClone({ ...record, roster: {} });
        assert.equal(deleteChatRoster(current), false);
        assert.equal(deleteChatRoster(foreign), false);
        assert.equal(deleteChatRoster(historical), true);
        assert.equal(await flushArchive(), true);
        assert.deepEqual(checkpoint.sessions[historical], retained);
        assert.ok(checkpoint.sessions[current].roster.Alice);
        assert.ok(checkpoint.sessions[foreign].roster.Alice);
    } finally {
        globalThis.fetch = savedFetch;
    }
});

test('preferences write only to the host namespace and request a host save', () => {
    const config = { sillab: { modelType: 'zit' }, cat_image: { modelType: 'anima' } };
    let saves = 0;
    initSettings(() => ({ saveSettingsDebounced() { saves++; } }), config);
    loadPreferences();
    assert.equal(settings.modelType, 'anima');
    settings.modelType = 'anime';
    saveSettings();
    assert.equal(config.cat_image.modelType, 'anime');
    assert.equal(saves, 1);
});
