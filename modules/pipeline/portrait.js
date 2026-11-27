import { isEnglishMode } from '../settings.js';
import { PORTRAIT_VIEWS } from '../roster.js';
import { auxApiCallRaw, withAuxiliaryFallback } from './api.js';

export async function requestPortraitPrompts(anchor, mode) {
    const language = isEnglishMode(mode) ? '英文' : '中文';
    const system = [
        '你负责把已建档人物的英文外貌锚点转写为同一人物的四视角立绘提示词。锚点是人物资料。',
        '保留明确的年龄、骨相、发型、眼睛、肤色、体型和稳定标记。各视角只写该角度可见的特征。',
        '四张都是全身（含脚）、自然站立、素色参考服装、纯色背景、平静表情和均匀光线。侧面说明相机在人物自身的哪一侧。背面只写背向镜头时可见的特征。',
        '每条都是独立可用的' + language + '普通文本提示词，勿加入角色名、剧情、画风、艺术家或场景道具。',
        '只输出一个 JSON 对象，包含 front、left、right、back 四个非空字符串，分别为正面、左侧面、右侧面、背面。',
    ].join('\n');
    return withAuxiliaryFallback(config => generatePortraitPrompts(system, anchor, mode, config));
}

async function generatePortraitPrompts(system, anchor, mode, config) {
    const { content, truncated } = await auxApiCallRaw(system, anchor, undefined, undefined, undefined, { config });
    let prompts;
    try {
        if (!truncated) prompts = JSON.parse(content.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    } catch { /* The previous prompts stay usable if the assistant returns invalid JSON. */ }
    if (!PORTRAIT_VIEWS.every(view => typeof prompts?.[view] === 'string' && prompts[view].trim())) {
        throw new Error('辅助 AI 未返回完整的四视角提示词');
    }
    return { ...Object.fromEntries(PORTRAIT_VIEWS.map(view => [view, prompts[view].trim()])), mode };
}
