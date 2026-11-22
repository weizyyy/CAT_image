// ── SillyImage Lab 生图排队 ──
import { slLog } from './log.js';
import { settings, getSTContext, getActiveMode, isEnglishMode } from './settings.js';
import { setImageActionState, showGeneratedImage } from './render.js';
import { generateImage } from './comfyui.js';
import { cleanPromptForMode } from './text-utils.js';
import { getChatId } from './archive.js';
import { galleryAdd } from './gallery.js';

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
    if (btn?.[0]) setImageActionState(btn[0]);
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
        if (isEnglishMode(task.mode)) { var _clean = cleanPromptForMode(prompt, task.mode); if (_clean) prompt = _clean; }
        var result = await generateImage(workflow, prompt, { signal: task.controller.signal, mode: task.mode });
        if (task.cancelled) return;
        galleryAdd(result.url, {
            kind: task.custom ? 'portrait' : 'chat',
            scene: task.scene || (task.custom ? String(task.id || '').replace(/^portrait_/, '立绘_') : ''),
            chatKey: task.chatKey,
            blockId: task.blockId,
        });
        // A message may be redrawn during generation. Update the live button for
        // this exact block ID, never another image with the same prompt.
        liveButton(task);
        if (task.custom) {
            // [Fix] 通用任务（如生成立绘）：由调用方回调处理结果
            task.custom.onSuccess(result);
            slLog('排队完成(任务):', task.id);
        } else if (task.btn[0]?.isConnected) {
            showGeneratedImage(task.btn[0], result.url);
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
            setImageActionState(task.btn[0], 'error');
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
    if (blockId && pendingBlocks.has(blockId)) { pendingBlocks.get(blockId).btn = btn; setImageActionState(btn[0], 'queued'); return; }
    if (blockId) cancelledAutoBlocks.delete(blockId);
    var id = 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    setImageActionState(btn[0], 'queued');
    const scene = btn.closest('.sl_img_block').attr('title') || '';
    const task = { id: id, btn: btn, blockId, prompt: prompt, mode: btn.attr('data-sl-mode') || getActiveMode(), workflow: settings.cWf, scene, chatKey: getChatId() };
    if (blockId) pendingBlocks.set(blockId, task);
    imageQueue.push(task);
    slLog('入队:', id, '队列长度:', imageQueue.length);
    processImageQueue();
}

// [Fix] 通用排队任务（立绘等非聊天图按钮的生成）：与聊天图共用同一队列，串行打 ComfyUI
export function enqueueTask(id, prompt, onSuccess, onFail) {
    imageQueue.push({ id: id, prompt: prompt, mode: getActiveMode(), workflow: settings.cWf, custom: { onSuccess: onSuccess, onFail: onFail }, chatKey: getChatId() });
    slLog('入队(任务):', id, '队列长度:', imageQueue.length);
    processImageQueue();
}

export function isImagePending(blockId) { return pendingBlocks.has(blockId); }

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
