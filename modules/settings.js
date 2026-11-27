// ── SillyImage Lab 设置中心 ──
export var settings = {};
export const MOSS_IMAGE_CG_MODE = 'moss_image';
export const MOSS_IMAGE_FREE_MODE = 'moss_image_free';
export const GEMINI_AUX_URL = 'https://aiplatform.us.rep.googleapis.com';
const defaultMossCanvas = { width: 1536, height: 864 };

export function isMossImageMode(mode) {
    return mode === MOSS_IMAGE_CG_MODE || mode === MOSS_IMAGE_FREE_MODE;
}

export function isMossDimension(value) {
    return Number.isSafeInteger(value) && value > 0 && value % 16 === 0;
}

export function getMossCanvas() {
    const { mossWidth, mossHeight } = settings;
    return {
        width: isMossDimension(mossWidth) ? mossWidth : defaultMossCanvas.width,
        height: isMossDimension(mossHeight) ? mossHeight : defaultMossCanvas.height,
    };
}

export function getDefaults() {
    return {
        pluginOn: true,
        autoGen: 1,
        cUrl: 'http://localhost:8181',
        cTimeout: 180,
        cWf: '',
        cWfName: '',
        auxProfiles: [],
        auxProfileName: '',
        auxUseStrategy: false,
        auxStrategy: [],
        stylePreset: '',
        enhancedTheme: '默认',
        nsfwEnhance: false,
        modelType: 'zit',
        krea2Style: '',
        mossWidth: defaultMossCanvas.width,
        mossHeight: defaultMossCanvas.height,
        uiTheme: '雪白猫',
        debugMode: false,
        storyMode: 'narrative',
        animeArtist: '',
        workflows: {},
        summaryThreshold: 40,
        imageMode: 'always',
        injectCards: true,
        showGenPrompt: false,
        imgBlockWidth: '55%',
        feBridge: true,
        feBridgeMode: 'auto',
        slPurgeLayered: true,
    };
}

export function normalizeAuxiliaryConfig(profile = {}) {
    const format = profile.format === 'gemini' ? 'gemini' : 'openai';
    return { ...profile, format, url: String(profile.url ?? '').trim() || (format === 'gemini' ? GEMINI_AUX_URL : ''),
        model: String(profile.model ?? '').trim(), key: String(profile.key ?? '').trim() };
}

export function isAuxProfileConfigured({ format, url, model, key }) {
    return !!(url && model && (format !== 'gemini' || key));
}

export function preferredAuxiliaryProfile() {
    return settings.auxProfiles.find(profile => profile.name === settings.auxProfileName) ?? settings.auxProfiles[0];
}

export function getAuxiliaryStrategy() {
    const names = new Set(settings.auxProfiles.map(profile => profile.name));
    const rows = settings.auxStrategy.filter(row => names.has(row.name));
    return rows.length ? rows : [{ name: preferredAuxiliaryProfile()?.name ?? '', retry: true }];
}

export function getAuxiliaryAttempts() {
    const rows = settings.auxUseStrategy ? getAuxiliaryStrategy() : [{ name: preferredAuxiliaryProfile()?.name, retry: true }];
    const profiles = new Map(settings.auxProfiles.map(profile => [profile.name, profile]));
    return rows.filter(row => profiles.has(row.name))
        .map(row => ({ config: normalizeAuxiliaryConfig(profiles.get(row.name)), retry: row.retry !== false }));
}

export function isAuxConfigured() {
    return getAuxiliaryAttempts().some(({ config }) => isAuxProfileConfigured(config));
}

export var COLORS = {
    page: '#ffffff',
    card: '#f5f5f7',
    input: '#ebebed',
    text: '#1d1d1f',
    sub: '#6e6e73',
    mute: '#aeaeb2',
    line: '#d1d1d6',
    blue: '#0A84FF',
    orange: '#FF9F0A',
    green: '#30d158',
    red: '#ff3b30'
};

// ── 运行时依赖（从 index.js 注入） ──
var _getContext = null;
var _extensionSettings = null;

export function initSettings(getContextFn, extSettings) {
    _getContext = getContextFn;
    _extensionSettings = extSettings;
}

export function getSTContext() {
    if (!_getContext) throw new Error('settings not initialized');
    return _getContext();
}

export function getSTHeaders() {
    return getSTContext().getRequestHeaders();
}

export function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    // [Fix] div.innerHTML 不转义双引号/单引号，直接用于 data-prompt/title 等属性会被提前闭合
    // （LLM 输出的提示词常含英文引号 → 属性注入/HTML 破坏）。统一补转义。
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function preferences(source) {
    const values = getDefaults();
    for (const key of Object.keys(values)) if (Object.hasOwn(source, key)) values[key] = source[key];
    return values;
}

export function loadPreferences() {
    const source = _extensionSettings?.cat_image || {};
    Object.assign(settings, preferences(source));
    if (!Object.hasOwn(source, 'auxProfiles')) importAuxiliaryConnections(source);
    if (settings.modelType === 'minimax_h3_image') settings.modelType = MOSS_IMAGE_CG_MODE;
}

function importAuxiliaryConnections(source) {
    const oldOpenAI = {
        ...source.auxOpenAI, url: source.auxUrl || '', key: source.auxKey || '', model: source.auxModel || '',
    };
    const { projectId: _oldProjectId, ...oldGemini } = source.auxGemini || {};
    for (const [format, label, old] of [['openai', 'OpenAI', oldOpenAI], ['gemini', 'Gemini', oldGemini]]) {
        if (!Object.values(old).some(Boolean)) continue;
        const name = old.model?.trim() ? label + ' · ' + old.model.trim() : label;
        settings.auxProfiles.push({ ...old, name, format });
        if ((source.auxFormat || 'openai') === format) settings.auxProfileName = name;
    }
}

export function saveSettings() {
    if (!_extensionSettings) return;
    _extensionSettings.cat_image = structuredClone(preferences(settings));
    getSTContext().saveSettingsDebounced?.();
}

export function getActiveMode() {
    return settings.modelType || 'zit';
}

export var MODES = [
    { id: 'zit',       label: 'ZIT（中文提示词）',                                          short: 'ZIT（中文提示词）',            badge: '🖼️ ZIT' },
    { id: 'anima',     label: '🎬 Anima 混合（标签定结构 + 自然语言写氛围）★ Anima 系模型推荐', short: 'Anima 混合（标签+自然语言）',   badge: '🎬 Anima' },
    { id: 'anime',     label: 'Anime（纯英文描述）',                                        short: 'Anime（纯英文描述）',          badge: '🎬 Anime' },
    { id: 'anime_tag', label: 'Anime Tag（纯英文标签）',                                    short: 'Anime Tag（纯英文标签）',      badge: '🎬 Tag' },
    { id: 'krea2',     label: '🎬 Krea 2（英文自然语言段落）★ Krea 2 / 通用基座模型推荐',      short: 'Krea 2（英文自然语言段落）',   badge: '🎬 Krea2' },
    { id: MOSS_IMAGE_CG_MODE, label: '🎬 MOSS-Image（Layout JSON · Galgame CG）', short: 'MOSS-Image（Galgame CG）', badge: '🎬 MOSS CG' },
    { id: MOSS_IMAGE_FREE_MODE, label: '🎬 MOSS-Image（Layout JSON · 画风自由）', short: 'MOSS-Image（画风自由）', badge: '🎬 MOSS Layout' },
];

export function modeLabel(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i].short;
    return id || 'zit';
}

export function modeBadge(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i].badge;
    return '🖼️ ZIT';
}

// 英文模式共用同一套人物锚点。
// 统一入口：以后新增英文模式只改这里，不用再去各处撒 if
export function isEnglishMode(mode) {
    var m = mode || getActiveMode();
    return m === 'anime' || m === 'anime_tag' || m === 'anima' || m === 'krea2' || isMossImageMode(m);
}
