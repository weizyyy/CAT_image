// 辅助 AI 传输层。调用方负责拼接消息和处理回包协议。
import { slLog, slErr } from '../log.js';
import { getAuxiliaryAttempts, normalizeAuxiliaryConfig, settings } from '../settings.js';

const OUT_MAXTOKENS = 16384;
const OPENAI_MANAGED_FIELDS = new Set(['model', 'messages', 'stream', 'temperature', 'top_p', 'top_k', 'thinking', 'reasoning_effort']);

export function parseAuxAdditionalParams(input) {
    const text = String(input || '').trim();
    if (!text) return {};
    let value;
    try {
        value = JSON.parse(text.startsWith('"') ? '{' + text + '}' : text);
    } catch {
        throw new Error('附加参数必须是有效的 JSON 对象。布尔值使用 true 或 false。');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('附加参数必须是 JSON 对象。');
    }
    const reserved = Object.keys(value).find(key => OPENAI_MANAGED_FIELDS.has(key));
    if (reserved) throw new Error('附加参数中的 ' + reserved + ' 由插件或上方设置管理。');
    if (Object.hasOwn(value, 'max_tokens') && Object.hasOwn(value, 'max_completion_tokens')) {
        throw new Error('max_tokens 和 max_completion_tokens 请选择其一。');
    }
    return value;
}

function auxiliaryEndpoint(config, model) {
    if (!config.url || !model) throw new Error('请填写 AI 助理的 API 地址和模型。');
    let endpoint;
    try { endpoint = new URL(config.url, globalThis.window?.location?.href); }
    catch { throw new Error('AI 助理的 API 地址格式不正确。'); }
    if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('API 地址须使用 HTTP 或 HTTPS。');
    const path = endpoint.pathname.replace(/\/+$/, '');
    if (config.format === 'gemini') {
        if (!config.key) throw new Error('请填写 Gemini 的 Google Cloud API Key。');
        // Reuse the endpoint even when a saved URL includes a version or a resource path.
        const base = path.replace(/\/v1(?:beta1)?(?:\/(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\/[^/]+:generateContent)?$/, '');
        if (base.includes('/projects/') || base.endsWith(':generateContent')) {
            throw new Error('请在 Gemini 的 API 地址栏填写端点的基础地址。');
        }
        endpoint.pathname = base + '/v1/publishers/google/models/' + encodeURIComponent(model) + ':generateContent';
        endpoint.searchParams.set('key', config.key);
    } else {
        endpoint.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
    }
    endpoint.hash = '';
    return endpoint;
}

function samplingValue(config, name, fallback) {
    if (config.omit?.includes(name)) return;
    const raw = String(config[name] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (name === 'topK' && !Number.isSafeInteger(parsed))) {
        throw new Error(name + (name === 'topK' ? ' 须为整数。' : ' 须为数字。'));
    }
    return parsed;
}

function geminiBody(messages, config, sampling, maxTokens, level) {
    const systemParts = [], contents = [];
    for (const message of messages) {
        const part = { text: message.content };
        if (message.role === 'system') systemParts.push(part);
        else contents.push({ role: message.role === 'assistant' ? 'model' : message.role, parts: [part] });
    }
    const generationConfig = { ...sampling, maxOutputTokens: maxTokens };
    if (config.thinking === 'off') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if (config.thinking === 'on' && level) {
        // Gemini 2.5 accepts a numeric budget; newer models use a thinking level.
        if (/^-?\d+$/.test(level)) {
            const budget = Number(level);
            if (!Number.isSafeInteger(budget) || budget < -1) throw new Error('Gemini thinkingBudget 须为 -1 或非负整数。');
            generationConfig.thinkingConfig = { thinkingBudget: budget };
        } else {
            generationConfig.thinkingConfig = { thinkingLevel: level.toUpperCase() };
        }
    }
    return { ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}), contents, generationConfig };
}

function openaiBody(endpoint, config, model, messages, { temperature, topP, topK }, maxTokens, level) {
    const official = endpoint.hostname === 'api.openai.com';
    const deepseek = endpoint.hostname === 'api.deepseek.com';
    if (official && topK !== undefined) throw new Error('使用 OpenAI 官方接口时，请将 topK 留空或勾选「不发送」。');
    const extras = parseAuxAdditionalParams(config.additional);
    const tokenField = official || Object.hasOwn(extras, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens';
    const body = { messages, model, stream: false, temperature, top_p: topP, top_k: topK, [tokenField]: maxTokens, ...extras };
    if (Object.hasOwn(extras, 'max_tokens') && tokenField === 'max_completion_tokens') delete body.max_completion_tokens;
    const legacyDefault = !official && !config.thinking;
    if (legacyDefault || (deepseek && config.thinking === 'off')) body.thinking = { type: 'disabled' };
    else if (config.thinking === 'off') body.reasoning_effort = 'none';
    if (config.thinking === 'on') {
        if (deepseek) body.thinking = { type: 'enabled' };
        if (level) body.reasoning_effort = level;
    }
    return { body, legacyDefault };
}

function requestHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.format === 'openai' && config.key) {
        headers.Authorization = /^Bearer\s/i.test(config.key) ? config.key : 'Bearer ' + config.key;
    }
    return headers;
}

function hideApiKey(text, key) {
    if (!key) return text;
    const encoded = new URLSearchParams({ key }).toString().slice('key='.length);
    return text.replaceAll(encoded, '[API Key 已隐藏]').replaceAll(key, '[API Key 已隐藏]');
}

// ── CoT（思维链）剥离 ──
// DeepSeek 把思考放在独立的 reasoning_content 字段（正常不会混进 content）；
// 但有些网关会把思考合并进正文，或模型自己带 <thinking> 标记 → 统一剥掉，
// 别让思考污染 ---PROFILE--- / ---IMAGES--- 的解析。
export function stripCoT(text) {
    var t = String(text || '');
    if (!t) return t;
    t = t.replace(/<(thought|thinking|reasoning)>[\s\S]*?<\/\1\s*>/gi, '');
    t = t.replace(/<(thought|thinking|reasoning)\s*\/>/gi, '');
    t = t.replace(/(^|\n)[ \t]*(思考过程|推理过程|分析过程|Thought process)[ \t]*[：:][\s\S]*?(?=\n[ \t]*---|\n\n|$)/gi, '\n');
    var p = t.search(/---\s*PROFILE\s*---/);
    if (p > 0) t = t.slice(p);
    var reEnd = /---\s*END\s*---/g, mm, lastIdx = -1;
    while ((mm = reEnd.exec(t)) !== null) lastIdx = mm.index + mm[0].length;
    if (lastIdx > 0) {
        // 多段输出时，最后一个 ---END--- 之后**可能还有尾段**。
        // 实测：3 份「PROFILE/IMAGES/END」时，最后那份的 ---CHECK--- 不带 END，
        // 旧实现把它当思考残留砍掉（1788 字 → 1730 字，正好一段 CHECK）。
        // 判据：残余里还有段标记就不截，只有纯废话才砍。
        var tail = t.slice(lastIdx);
        if (!/---\s*(?:PROFILE|IMAGES|CHECK|WARDROBE)\s*---/.test(tail)) {
            t = t.slice(0, lastIdx);
        }
    }
    return t.trim();
}

async function _post(endpoint, headers, body, timeoutMs, signal, queryKey) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctrl.abort();
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
    } catch (e) {
        const message = signal?.aborted ? '回复版本已变更，请求已取消'
            : e?.name === 'AbortError' ? '辅助API请求超时(' + timeoutMs + 'ms)' : (e?.message || 'fetch失败');
        throw new Error(hideApiKey(message, queryKey));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function readAuxiliaryResponse(data, format) {
    if (format === 'gemini') {
        const candidate = data?.candidates?.[0];
        const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || '';
        const finish = reason === 'MAX_TOKENS' ? 'length' : reason.toLowerCase();
        const parts = candidate?.content?.parts || [];
        const text = parts.filter(part => !part.thought).map(part => part.text || '').join('');
        const reasoning = parts.filter(part => part.thought).map(part => part.text || '').join('');
        return { text, finish, reasoningLen: reasoning.length };
    }
    const choice = data?.choices?.[0];
    const message = choice?.message;
    return { text: message?.content || '', finish: choice?.finish_reason || '',
        reasoningLen: (message?.reasoning_content || message?.reasoning || '').length };
}

async function sendAuxiliary(messages, { maxTokens, temperature = 0.3, forceModel, signal,
    config = getAuxiliaryAttempts()[0]?.config ?? normalizeAuxiliaryConfig() }) {
    const model = forceModel || config.model;
    const endpoint = auxiliaryEndpoint(config, model);
    const headers = requestHeaders(config);
    const sampling = {
        temperature: samplingValue(config, 'temperature', temperature),
        topP: samplingValue(config, 'topP'),
        topK: samplingValue(config, 'topK'),
    };
    const level = config.omit?.includes('thinkingLevel') ? '' : String(config.thinkingLevel ?? '').trim();
    const request = config.format === 'gemini'
        ? { body: geminiBody(messages, config, sampling, maxTokens, level) }
        : openaiBody(endpoint, config, model, messages, sampling, maxTokens, level);
    const timeoutMs = (settings.cTimeout || 180) * 1000;
    const queryKey = config.format === 'gemini' ? config.key : '';
    const post = () => _post(endpoint.href, headers, request.body, timeoutMs, signal, queryKey);
    slLog('auxApiCall →', endpoint.origin + endpoint.pathname, 'model:', model);
    let response = await post();
    if (!response.ok && request.legacyDefault && [400, 422].includes(response.status) &&
        /\bthinking\b/i.test(response.text) && /unknown|unsupported|unrecognized|not supported|not (?:permitted|allowed)|extra.forbidden|unexpected/i.test(response.text)) {
        // Existing compatible endpoints may implement the legacy thinking flag.
        slLog('辅助 API 不支持默认 thinking 字段，使用服务端默认设置重试');
        delete request.body.thinking;
        response = await post();
    }
    if (!response.ok) {
        const detail = hideApiKey(response.text, queryKey);
        slErr('auxApiCall 失败:', response.status, detail.slice(0, 500));
        throw new Error('HTTP ' + response.status + ': ' + detail.slice(0, 300));
    }
    let data;
    try { data = JSON.parse(response.text); }
    catch { throw new Error('辅助 API 未返回 JSON。'); }
    const { text, finish, reasoningLen } = readAuxiliaryResponse(data, config.format);
    const content = stripCoT(text);
    slLog('auxApiCall 返回: finish=' + finish + ', content_len=' + content.length + ', reasoning_len=' + reasoningLen);
    return { content, finish, reasoningLen, truncated: finish === 'length' };
}

export async function auxApiCallRaw(systemPrompt, userMessage, maxTokens, temperature, forceModel, { signal, config } = {}) {
    const messages = Array.isArray(systemPrompt) ? systemPrompt : [
        { role: 'system', content: systemPrompt }, { role: 'user', content: userMessage },
    ];
    return sendAuxiliary(messages, { maxTokens: Math.max(Number(maxTokens) || 0, OUT_MAXTOKENS), temperature, forceModel, signal, config });
}

export async function auxApiCall(systemPrompt, userMessage, maxTokens, temperature, forceModel) {
    return withAuxiliaryFallback(async config => {
        const { content } = await auxApiCallRaw(systemPrompt, userMessage, maxTokens, temperature, forceModel, { config });
        if (!content) throw new Error('辅助 AI 未返回文本。');
        return content;
    });
}

export async function withAuxiliaryFallback(run, { isCurrent = () => true, signal } = {}) {
    const attempts = getAuxiliaryAttempts();
    if (!attempts.length) throw new Error('请先保存 AI 助理的连接配置。');
    const checkCurrent = () => {
        signal?.throwIfAborted();
        if (!isCurrent()) throw new Error('回复版本已变更');
    };
    for (const [index, { config, retry }] of attempts.entries()) {
        checkCurrent();
        try {
            const result = await run(config, retry);
            checkCurrent();
            return result;
        } catch (error) {
            checkCurrent();
            const next = attempts[index + 1];
            if (!next) throw error;
            slLog('AI 助理连接失败，切换至回落配置:', next.config.name);
        }
    }
}

export async function testAuxConnection(config) {
    const result = await sendAuxiliary([{ role: 'user', content: 'Reply only with OK.' }], { maxTokens: 256, config });
    if (!result.content && !result.truncated) throw new Error('已连接，但模型未返回文本' + (result.finish ? '（' + result.finish + '）' : '') + '。');
}
