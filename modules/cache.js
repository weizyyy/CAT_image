import { getSTHeaders } from './settings.js';
import { sessionData } from './archive.js';

export function imgCacheGetById(blockId, chatKey) {
    return sessionData(chatKey)?.images[blockId];
}

// 上传图片到 ST 本地存储
export async function uploadImageToST(dataUrl, signal) {
    var match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('无效的 Data URL');
    var format = match[1], raw = match[2];
    var filename = 'sl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getSTHeaders()),
        body: JSON.stringify({ image: raw, format: format, filename: filename }), signal
    });
    if (!response.ok) { var text = await response.text(); throw new Error(text.slice(0, 200)); }
    var data = await response.json();
    if (!data.path) throw new Error('Upload 返回缺少 path');
    return data.path.startsWith('/') ? data.path : '/' + data.path;
}
