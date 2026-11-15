// ── SillyImage Lab 生图排队 ──
import { slLog } from './log.js';
import { settings, COLORS, getSTContext, getActiveMode, isEnglishMode, escapeHtml } from './settings.js';
import { imgCacheGetById, imgCacheSetById } from './cache.js';
import { generateImage } from './comfyui.js';
import { cleanAnimePrompt } from './text-utils.js';
import { resolveFacePrompt, getCharacterName, getChatId } from './pipeline/profile.js';
import { galleryAdd } from './gallery.js';

// v1.21：生成时刻的归属（图库按【角色卡 × 聊天】归档）。入队时抓一次，避免排队期间切聊天串台。
function _genOwner() {
    var o = { charName: '', chatKey: '' };
    try { o.charName = getCharacterName() || ''; } catch (e) {}
    try { o.chatKey = getChatId() || ''; } catch (e) {}
    return o;
}

var imageQueue = [];
var queueRunning = false;
const pendingBlocks = new Map();
const cancelledAutoBlocks = new Set();
let activeTask;

function liveButton(task) {
    if (!task.btn || !task.blockId) return task.btn;
    const live = Array.from(task.btn[0]?.ownerDocument.querySelectorAll('.sl_img_btn') || []).find(n => n.dataset.slid === task.blockId);
    if (live) task.btn = jQuery(live);
    return task.btn;
}
function resetButton(task) {
    const btn = liveButton(task);
    if (btn) btn.text(imgCacheGetById(task.blockId) ? '↻ 重新生成' : '✦ 生成图片')
        .css({ background: COLORS.card, color: COLORS.text });
}
function cancelTask(task) {
    if (task.cancelled) return;
    task.cancelled = true;
    if (task.blockId) cancelledAutoBlocks.add(task.blockId);
    task.controller?.abort();
    resetButton(task);
    if (task.blockId) pendingBlocks.delete(task.blockId);
    try { task.custom?.onFail?.(new DOMException('已取消排图', 'AbortError')); } catch (e) { slLog('取消回调失败: ' + e.message); }
}

async function processImageQueue() {
    if (queueRunning || !imageQueue.length) return;
    queueRunning = true;
    var task = imageQueue.shift();
    activeTask = task; task.controller = new AbortController();
    liveButton(task);
    if (!task.custom && (!task.btn[0]?.isConnected || settings.pluginOn === false)) {
        pendingBlocks.delete(task.blockId);
        queueRunning = false; activeTask = null;
        return processImageQueue();
    }
    slLog('排队处理:', task.id, '剩余:', imageQueue.length);
    try {
        var workflow = task.workflow;
        var prompt = task.prompt;
        // Anime 模式强制清理中文（删空则保留原文，防空提示词）
        if (isEnglishMode()) { var _clean = cleanAnimePrompt(prompt); if (_clean) prompt = _clean; }
        var result = await generateImage(workflow, prompt, { signal: task.controller.signal });
        if (task.cancelled) return;
        // v1.21 图库：每张产出的图都记一笔（独立账本，不受 msgMap 50 条上限影响）
        try {
            galleryAdd(result.url, {
                kind: task.custom ? 'portrait' : 'chat',
                scene: task.scene || (task.custom ? String(task.id || '').replace(/^portrait_/, '立绘_') : ''),
                charName: task.charName,
                chatKey: task.chatKey
            });
        } catch (eG) { slLog('图库记录跳过: ' + eG.message); }
        // [Fix] 图块精确缓存：按块标识（消息key#序号）记录，同一提示词内容不再互相覆盖
        var _slid = task.blockId;
        if (_slid) imgCacheSetById(_slid, result.url);
        // A message may be redrawn during generation. Update the live button for
        // this exact block ID, never another image with the same prompt.
        liveButton(task);
        if (task.custom) {
            // [Fix] 通用任务（如生成立绘）：由调用方回调处理结果
            task.custom.onSuccess(result);
            slLog('排队完成(任务):', task.id);
        } else {
            task.btn.text('\u21bb \u91cd\u65b0\u751f\u6210').css({ background: COLORS.card, color: COLORS.text });
            task.btn.siblings('img').remove();
            // [v1.1.2 前端卡桥] 按钮可能位于酒馆助手的 iframe 文档中：
            // 图片元素必须用该文档创建（跨文档 append 在部分浏览器不渲染），src 用 attr 赋值避免 data URL 被转义
            var _od = (task.btn[0] && task.btn[0].ownerDocument) ? task.btn[0].ownerDocument : document;
            var imgEl = jQuery(_od.createElement('img'));
            imgEl.attr('src', result.url).attr('style', 'max-width:' + (settings.imgBlockWidth || '55%') + ';border-radius:12px;margin-top:6px;display:block;');
            task.btn.after(imgEl);
            imgEl[0].offsetHeight;
            task.btn.parent()[0].offsetHeight;
            getSTContext().saveMetadataDebounced && getSTContext().saveMetadataDebounced();
            // 重新绑定点击，恢复按钮功能
            slLog('排队完成:', task.id);
        }
    } catch (e) {
        if (task.cancelled) return;
        if (task.custom) {
            if (task.custom.onFail) task.custom.onFail(e);
            slLog('排队失败(任务):', task.id, e.message);
        } else {
            task.btn.text('\u2715 \u91cd\u8bd5').css({ background: COLORS.red, color: '#fff' });
            slLog('排队失败:', task.id, e.message);
        }
    } finally {
        if (pendingBlocks.get(task.blockId) === task) pendingBlocks.delete(task.blockId);
        queueRunning = false; activeTask = null;
        void processImageQueue();
    }
}

export function enqueueGen(btn, prompt, { automatic = false } = {}) {
    const blockId = btn.attr('data-slid');
    if (automatic && blockId && cancelledAutoBlocks.has(blockId)) return;
    if (blockId && pendingBlocks.has(blockId)) { pendingBlocks.get(blockId).btn = btn; btn.text('排队中\u2026'); return; }
    if (blockId) cancelledAutoBlocks.delete(blockId);
    var id = 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    btn.text('排队中\u2026').css({ background: COLORS.orange, color: '#fff' }).off('click');
    var _own = _genOwner(), _scene = '';
    try { _scene = String(btn.closest('.sl_img_block').find('div').first().text() || '').replace(/^🖼️\s*/, '').slice(0, 60); } catch (eS) {}
    const task = { id: id, btn: btn, blockId, prompt: prompt, workflow: settings.cWf, scene: _scene, charName: _own.charName, chatKey: _own.chatKey };
    if (blockId) pendingBlocks.set(blockId, task);
    imageQueue.push(task);
    slLog('入队:', id, '队列长度:', imageQueue.length);
    processImageQueue();
}

// [Fix] 通用排队任务（立绘等非聊天图按钮的生成）：与聊天图共用同一队列，串行打 ComfyUI
export function enqueueTask(id, prompt, onSuccess, onFail) {
    var _own = _genOwner();
    imageQueue.push({ id: id, prompt: prompt, workflow: settings.cWf, custom: { onSuccess: onSuccess, onFail: onFail }, charName: _own.charName, chatKey: _own.chatKey });
    slLog('入队(任务):', id, '队列长度:', imageQueue.length);
    processImageQueue();
}

export function getQueueLength() {
    return imageQueue.length;
}

export function getQueueStatus() { return { queued: imageQueue.length, running: !!activeTask && !activeTask.cancelled }; }

export function clearQueue() {
    const tasks = imageQueue;
    imageQueue = [];
    if (activeTask && !activeTask.cancelled) tasks.unshift(activeTask);
    for (const task of tasks) cancelTask(task);
    slLog('已取消全部排图: ' + tasks.length);
    return tasks.length;
}
