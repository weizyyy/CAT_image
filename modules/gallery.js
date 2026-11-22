// ── SillyImage Lab v1.21 图库（产出图存档）──
// 目的：所有生成过的图都留一份独立账本，按【角色卡 × 聊天】归档。
//   · 删聊天 → 该聊天的图账与 msgMap 里的图缓存一起清掉（级联）
//   · 用户可以逐张手动删（只删账本，不删服务器上的 png —— 浏览器没有删文件的权限）
//
// 为什么不再只靠 msgMap：
//   msgMap 是"消息 → 增强文本"的缓存，按 chatId_mesId_指纹 索引；
//   v1.22 起它已经搬进 IndexedDB（不再受 50 条上限约束），但"这张图属于哪场聊天"仍然只有图库知道。
//   图库是另一层账：不参与消息缓存的生命周期，删聊天时按聊天级联清理。

import { settings, saveSettings } from './settings.js';
import { getCharacterName, getChatId } from './pipeline/profile.js';
import { fetchCharacterChats, characterChatKey, characterChatKeys, cachedChatKey } from './chat-sessions.js';
import { slLog } from './log.js';
import { imgStoreDeleteKeys } from './imgstore.js';

function _char() {
    try { return getCharacterName() || ''; } catch (e) { return ''; }
}

// 从 /user/images/sl_xxx.png 之类地址里取文件名
export function galleryFileName(url) {
    try {
        var s = String(url || '').split('?')[0].split('#')[0];
        var i = s.lastIndexOf('/');
        var f = decodeURIComponent(i >= 0 ? s.slice(i + 1) : s);
        return /\.(png|jpe?g|webp|gif)$/i.test(f) ? f : '';
    } catch (e) { return ''; }
}

// 写一条记录。meta: { kind: 'chat'|'portrait', scene, prompt, chatKey, charName }
export function galleryAdd(url, meta) {
    try {
        var file = galleryFileName(url);
        if (!file) return null;
        var charName = (meta && meta.charName) || _char();
        if (!charName) return null;
        var chatKey = (meta && meta.chatKey) || '';
        if (!chatKey) { try { chatKey = getChatId(); } catch (e) { chatKey = ''; } }
        if (!chatKey) return null;
        if (!settings.gallery) settings.gallery = {};
        if (!settings.gallery[charName]) settings.gallery[charName] = {};
        if (!settings.gallery[charName][chatKey]) settings.gallery[charName][chatKey] = {};
        var bag = settings.gallery[charName][chatKey];
        if (bag[file]) return bag[file];
        bag[file] = {
            ts: Date.now(),
            url: String(url),
            kind: (meta && meta.kind) || 'chat',
            scene: String((meta && meta.scene) || '').slice(0, 120)
        };
        slLog('图库记录: ' + file + '（' + bag[file].kind + '）');
        return bag[file];
    } catch (e) { slLog('图库记录失败: ' + e.message); return null; }
}

// 当前角色卡的全部图账 → [{ chatKey, label, current, items: [{file,url,ts,kind,scene}] }]（新的聊天在前）
export function galleryList() {
    try {
        var charName = _char();
        if (!charName || !settings.gallery || !settings.gallery[charName]) return [];
        var bag = settings.gallery[charName];
        var cur = '';
        try { cur = getChatId(); } catch (e) {}
        var out = [];
        for (var chatKey in bag) {
            var items = [], b = bag[chatKey] || {};
            for (var f in b) items.push(Object.assign({ file: f }, b[f]));
            if (!items.length) { delete bag[chatKey]; continue; }
            items.sort(function (a, c) { return (c.ts || 0) - (a.ts || 0); });
            out.push({
                chatKey: chatKey,
                current: chatKey === cur,
                label: chatKey === cur ? '当前聊天' : chatKey.replace(charName + '_', ''),
                newest: items[0].ts || 0,
                items: items
            });
        }
        out.sort(function (a, c) { return c.newest - a.newest; });
        return out;
    } catch (e) { return []; }
}

export function galleryCacheSource(charName = _char(), chatKey = getChatId()) {
    const source = settings.galleryCacheSources?.[charName]?.[chatKey];
    return source && source !== chatKey && settings.gallery?.[charName]?.[source] ? source : '';
}

export function setGalleryCacheSource(source, charName = _char(), chatKey = getChatId()) {
    if (!charName || !chatKey || source === chatKey || (source && !settings.gallery?.[charName]?.[source])) return false;
    const sources = (settings.galleryCacheSources ||= {});
    const byChat = (sources[charName] ||= {});
    if (source) byChat[chatKey] = source;
    else delete byChat[chatKey];
    saveSettings();
    return true;
}

export function galleryCount() {
    try {
        var n = 0, list = galleryList();
        for (var i = 0; i < list.length; i++) n += list[i].items.length;
        return n;
    } catch (e) { return 0; }
}

// 手动删一张（只删账本）
export function galleryRemove(chatKey, file) {
    try {
        var charName = _char();
        var bag = settings.gallery && settings.gallery[charName];
        if (!bag || !bag[chatKey] || !bag[chatKey][file]) return false;
        delete bag[chatKey][file];
        if (!Object.keys(bag[chatKey]).length) delete bag[chatKey];
        slLog('图库删除: ' + file);
        return true;
    } catch (e) { return false; }
}

// 清空当前聊天的图账
export function galleryClearChat(chatKey) {
    try {
        var charName = _char();
        var bag = settings.gallery && settings.gallery[charName];
        if (!bag) return 0;
        var key = chatKey || getChatId();
        var n = bag[key] ? Object.keys(bag[key]).length : 0;
        if (bag[key]) delete bag[key];
        return n;
    } catch (e) { return 0; }
}

// 级联清理：聊天文件已经不在了 → 删它的图账 + 该聊天的 msgMap 图片缓存
// 返回 { ok, removedChats, removedImages, removedCaches } ；拿不到聊天列表时 ok=false（本轮不动手）
export function galleryPrune() {
    const character = _char();
    return fetchCharacterChats().catch(() => null).then(function (names) {
        if (!names) return { ok: false, removedChats: 0, removedImages: 0, removedCaches: 0 };
        var charName = _char();
        if (!charName || charName !== character) return { ok: false, removedChats: 0, removedImages: 0, removedCaches: 0 };
        const alive = new Set(names.map(name => characterChatKey(charName, name)));
        alive.add(getChatId());
        const known = characterChatKeys(charName);
        const bag = settings.gallery?.[charName] || {};
        let removedChats = 0, removedImages = 0;
        for (const chatKey of Object.keys(bag)) {
            if (alive.has(chatKey)) continue;
            removedImages += Object.keys(bag[chatKey] || {}).length;
            delete bag[chatKey];
            removedChats++;
        }
        const deadKeys = Object.keys(settings.msgMap || {}).filter(key => {
            const chatKey = cachedChatKey(key);
            return known.has(chatKey) && !alive.has(chatKey);
        });
        const removedCaches = deadKeys.length;
        if (removedCaches) imgStoreDeleteKeys(deadKeys);
        slLog('图库级联清理: 聊天 ' + removedChats + ' 场 / 图 ' + removedImages + ' 张 / 消息缓存 ' + removedCaches + ' 条');
        return { ok: true, removedChats: removedChats, removedImages: removedImages, removedCaches: removedCaches };
    });
}
