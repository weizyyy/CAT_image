import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../modules/settings.js';

test('IndexedDB reload preserves revision chronology instead of assigning every entry the current time', async () => {
    const records = [
        ['chat_0_v2_0_a', { text: 'older source', ts: 100 }],
        ['chat_0_v2_0_b', { text: 'newer source', ts: 200 }]
    ];
    globalThis.indexedDB = { open() {
        const request = {};
        queueMicrotask(() => {
            request.result = { transaction() { return { objectStore() { return { openCursor() {
                const cursor = {}; let i = 0;
                const advance = () => queueMicrotask(() => {
                    const entry = records[i++];
                    cursor.result = entry ? { key: entry[0], value: entry[1], continue: advance } : null;
                    cursor.onsuccess();
                });
                advance(); return cursor;
            } }; } }; } };
            request.onsuccess();
        });
        return request;
    } };
    settings.msgMap = {}; settings.msgMapTs = {};
    const { imgStoreInit } = await import('../modules/imgstore.js');
    const result = await imgStoreInit();
    assert.equal(result.loaded, 2);
    assert.deepEqual(settings.msgMapTs, { chat_0_v2_0_a: 100, chat_0_v2_0_b: 200 });
});
