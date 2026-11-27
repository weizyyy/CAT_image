import { CAT } from './theme.js';
import { esc, escAttr, sbtn, fi } from './utils.js';
import { btnGhost } from './primitives.js';
import { settings, saveSettings, GEMINI_AUX_URL, getAuxiliaryStrategy, isAuxProfileConfigured,
    normalizeAuxiliaryConfig, preferredAuxiliaryProfile } from '../settings.js';
import { parseAuxAdditionalParams, testAuxConnection } from '../pipeline/api.js';

const STRATEGY = 'strategy';
const NEW = 'new';
const profileSlot = name => 'profile:' + name;
const block = 'margin-bottom:10px;';
const fieldLabel = () => 'display:block;font-size:11px;color:' + CAT.sub + ';margin-bottom:4px;';
const hintStyle = () => 'font-size:10.5px;color:' + CAT.mute + ';line-height:1.5;margin-top:4px;';
const option = (value, label, selected) => '<option value="' + escAttr(value) + '"' +
    (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>';

export function renderAuxPanel(body, slot, editor) {
  const selected = preferredAuxiliaryProfile();
  slot ??= settings.auxUseStrategy ? STRATEGY : selected ? profileSlot(selected.name) : NEW;
  const options = settings.auxProfiles.map(({ name }) => option(profileSlot(name), name, slot)).join('');
  const header = '<div style="' + block + '"><label for="sl_aux_profile" style="' + fieldLabel() +
    '">配置文件</label><select id="sl_aux_profile" style="' + fi() + '">' +
    option(STRATEGY, '连接策略', slot) + options + option(NEW, '新建配置', slot) + '</select></div>';

  if (slot === STRATEGY) renderStrategy(body, header);
  else {
    const profile = settings.auxProfiles.find(({ name }) => profileSlot(name) === slot);
    editor ??= { name: profile?.name ?? '', format: profile?.format ?? 'openai',
      drafts: profile ? { [profile.format]: structuredClone(profile) } : {} };
    renderProfile(body, header, slot, editor);
  }
  body.find('#sl_aux_profile').on('change', function () {
    const next = this.value;
    if (next !== NEW) {
      settings.auxUseStrategy = next === STRATEGY;
      if (!settings.auxUseStrategy) settings.auxProfileName = next.slice('profile:'.length);
      saveSettings();
    }
    renderAuxPanel(body, next);
  });
}

function renderStrategy(body, header) {
  const rows = getAuxiliaryStrategy();
  const profiles = settings.auxProfiles;
  const inputStyle = fi(), hint = hintStyle();
  let html = header + '<div style="' + block + '"><label for="sl_aux_format" style="' + fieldLabel() + '">' +
    '请求格式</label><select id="sl_aux_format" disabled style="' + inputStyle + '"><option>由配置文件决定</option></select></div>';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:12px 0 6px;">' +
    '<strong style="font-size:12px;color:' + CAT.text + ';">回落配置</strong><button id="sl_aux_reset_strategy" type="button" style="' +
    btnGhost('font-size:11px;padding:6px 10px;') + '">重置策略</button></div>';
  for (const [index, { name, retry }] of rows.entries()) {
    const options = profiles.map(profile => option(profile.name, profile.name, name)).join('');
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
      '<select data-aux-strategy-name="' + index + '" aria-label="第 ' + (index + 1) + ' 项回落配置"' +
      (!profiles.length ? ' disabled' : '') + ' style="' + inputStyle + 'min-width:0;">' +
      (options || '<option>请先保存连接配置</option>') + '</select>' +
      '<label style="white-space:nowrap;font-size:11px;color:' + CAT.sub + ';"><input type="checkbox" data-aux-strategy-retry="' +
      index + '" aria-label="第 ' + (index + 1) + ' 项是否重试"' + (retry !== false ? ' checked' : '') +
      (!profiles.length ? ' disabled' : '') + '> 是否重试</label></div>';
  }
  html += '<button id="sl_aux_add_strategy" type="button"' + (!profiles.length ? ' disabled' : '') + ' style="' +
    btnGhost('font-size:11px;padding:6px 10px;') + '">添加配置</button>';
  html += '<div style="' + hint + '">按列表顺序尝试，成功后停止。勾选「是否重试」时，配图回包不合格会在该连接重试一次。</div>';
  body.html(html);
  const update = next => { settings.auxStrategy = next; saveSettings(); };
  body.find('#sl_aux_reset_strategy').on('click', () => { update([]); renderAuxPanel(body, STRATEGY); });
  body.find('#sl_aux_add_strategy').on('click', () => {
    const next = profiles.find(profile => !rows.some(row => row.name === profile.name)) ?? profiles[0];
    if (!next) return;
    update([...rows, { name: next.name, retry: true }]);
    renderAuxPanel(body, STRATEGY);
  });
  body.find('[data-aux-strategy-name], [data-aux-strategy-retry]').on('change', function () {
    const index = Number(this.dataset.auxStrategyName ?? this.dataset.auxStrategyRetry);
    rows[index] = this.type === 'checkbox' ? { ...rows[index], retry: this.checked } : { ...rows[index], name: this.value };
    update([...rows]);
  });
}
function renderProfile(body, header, slot, editor) {
  const current = editor.drafts[editor.format] ||= { format: editor.format };
  const gemini = editor.format === 'gemini', inputStyle = fi(), hint = hintStyle();
  const entry = (key, label, value, type = 'text', placeholder = '') => '<div style="' + block +
    '"><label for="sl_aux_' + key + '" style="' + fieldLabel() + '">' + label + '</label><input id="sl_aux_' + key +
    '" data-aux-field="' + key + '" type="' + type + '" value="' + escAttr(value) +
    '" placeholder="' + escAttr(placeholder) + '" style="' + inputStyle + '"></div>';
  const optionalEntry = (key, label, type, placeholder, integer = false) => {
    const omitted = current.omit?.includes(key);
    return '<div style="' + block + '"><label for="sl_aux_' + key + '" style="' + fieldLabel() + '">' + label +
      '</label><div style="display:flex;align-items:center;gap:8px;"><input id="sl_aux_' + key + '" data-aux-field="' + key +
      '" type="' + type + '"' + (type === 'number' ? ' step="' + (integer ? '1' : 'any') + '"' : '') +
      ' value="' + escAttr(String(current[key] ?? '')) + '" placeholder="' + escAttr(placeholder) + '"' + (omitted ? ' disabled' : '') +
      ' style="' + inputStyle + 'min-width:0;"><label style="white-space:nowrap;font-size:11px;color:' + CAT.sub +
      ';"><input type="checkbox" data-aux-omit="' + key + '" aria-label="' + label + ' 不发送"' + (omitted ? ' checked' : '') + '> 不发送</label></div></div>';
  };

  let html = header + entry('name', '配置名称', editor.name) + '<div style="' + block + '"><label for="sl_aux_format" style="' + fieldLabel() + '">请求格式</label>' +
    '<select id="sl_aux_format" style="' + inputStyle + '">' + option('openai', 'OpenAI Chat Completions', editor.format) +
    option('gemini', 'Gemini Enterprise Agent Platform', editor.format) + '</select></div>';
  html += entry('url', 'API 地址', current.url, 'text', gemini ? GEMINI_AUX_URL : 'https://api.openai.com/v1');
  html += entry('key', gemini ? 'Google Cloud API Key' : 'API Key', current.key, 'password');
  if (gemini) {
    html += entry('projectId', '项目 ID', current.projectId);
    html += entry('region', '地区', current.region || 'global');
    html += '<div style="' + hint + '">填写项目 ID 后可指定地区。API 地址留空时按地区自动选址。项目 ID 留空时，Google 使用快速模式账号的地区。</div>';
  }
  html += entry('model', gemini ? 'Gemini 模型 ID' : '聊天分析模型', current.model);
  html += '<div style="' + hint + 'margin-bottom:8px;">留空沿用默认值（配图 temperature 为 0.25）。勾选「不发送」可省略该字段。' +
    (gemini ? '' : ' topK 由兼容网关提供。') + '</div>';
  html += optionalEntry('temperature', 'temperature', 'number', '当前任务默认');
  html += optionalEntry('topP', 'topP', 'number', '服务默认');
  html += optionalEntry('topK', 'topK', 'number', '服务默认', true);
  html += '<div style="' + block + '"><label for="sl_aux_thinking" style="' + fieldLabel() + '">思考模式</label>' +
    '<select id="sl_aux_thinking" data-aux-field="thinking" style="' + inputStyle + '">' +
    option('', '使用默认值', current.thinking || '') + option('on', '开启', current.thinking) +
    option('off', '关闭', current.thinking) + option('omit', '不发送', current.thinking) + '</select>' +
    (gemini ? '<div style="' + hint + '">是否支持关闭由所选模型决定。</div>' : '') + '</div>';
  html += '<div id="sl_aux_level_row"' + (current.thinking === 'on' ? '' : ' hidden') + '>' +
    optionalEntry('thinkingLevel', gemini ? 'thinkingLevel' : 'ReasoningEffort', 'text', '留空由模型决定') +
    (gemini ? '<div style="' + hint + 'margin:-6px 0 10px;">Gemini 2.5 可填整数作为 thinkingBudget。</div>' : '') + '</div>';
  if (!gemini) {
    html += '<div style="' + block + '"><label for="sl_aux_additional" style="' + fieldLabel() + '">附加参数（JSON）</label>' +
      '<textarea id="sl_aux_additional" data-aux-field="additional" rows="5" spellcheck="false" style="' + inputStyle +
      'font-family:monospace;resize:vertical;" placeholder="' + escAttr('{"provider":{"only":["relace/fp4"],"allow_fallbacks":false}}') + '">' +
      esc(current.additional || '') + '</textarea><div id="sl_aux_additional_error" role="status" style="' + hint + 'color:' + CAT.red + ';"></div></div>';
  }
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" id="sl_test_aux" style="' + sbtn(CAT.accent) +
    '">测试连接</button><button type="button" id="sl_save_aux" style="' + sbtn(CAT.accent) + '">保存连接</button></div>';
  html += '<div id="sl_aux_status" role="status" style="' + hint + 'overflow-wrap:anywhere;"></div>';
  body.html(html);

  const validateAdditional = () => {
    const input = body.find('#sl_aux_additional'), errorText = body.find('#sl_aux_additional_error');
    if (!input.length) return;
    let error = '';
    try { parseAuxAdditionalParams(current.additional); } catch (e) { error = e.message; }
    input.attr('aria-invalid', String(!!error));
    errorText.text(error);
  };
  validateAdditional();
  body.find('#sl_aux_format').on('change', function () {
    editor.format = this.value;
    renderAuxPanel(body, slot, editor);
  });
  body.find('[data-aux-field]').on('input change', function () {
    const key = this.dataset.auxField;
    if (key === 'name') editor.name = this.value;
    else current[key] = this.value;
    if (key === 'thinking') body.find('#sl_aux_level_row').prop('hidden', this.value !== 'on');
    if (key === 'additional') validateAdditional();
  });
  body.find('[data-aux-omit]').on('change', function () {
    const key = this.dataset.auxOmit;
    const omitted = new Set(current.omit);
    if (this.checked) omitted.add(key);
    else omitted.delete(key);
    current.omit = [...omitted];
    body.find('#sl_aux_' + key).prop('disabled', this.checked);
  });
  body.find('#sl_test_aux').on('click', async function () {
    const button = jQuery(this), status = body.find('#sl_aux_status');
    button.prop('disabled', true).text('测试中…');
    status.text('');
    try {
      await testAuxConnection(normalizeAuxiliaryConfig(current));
      status.css('color', CAT.green).text('连接成功');
    } catch (error) {
      status.css('color', CAT.red).text(error.message);
    } finally {
      button.prop('disabled', false).text('测试连接');
    }
  });
  body.find('#sl_save_aux').on('click', () => {
    const status = body.find('#sl_aux_status');
    try {
      const name = editor.name.trim();
      if (!name || name === '连接策略' || name === '新建配置') throw new Error('请填写配置名称。');
      const config = normalizeAuxiliaryConfig(current);
      if (!isAuxProfileConfigured(config)) {
        throw new Error(gemini ? '请填写 Gemini 模型 ID 和 Google Cloud API Key。' : '请填写 API 地址和聊天分析模型。');
      }
      if (!gemini) parseAuxAdditionalParams(current.additional);
      const saved = structuredClone({ ...current, name });
      const index = settings.auxProfiles.findIndex(profile => profile.name === name);
      if (index === -1) settings.auxProfiles.push(saved);
      else settings.auxProfiles[index] = saved;
      settings.auxProfileName = name;
      settings.auxUseStrategy = false;
      saveSettings();
      renderAuxPanel(body);
      body.find('#sl_aux_status').css('color', CAT.green).text('已保存连接「' + name + '」');
    } catch (error) {
      status.css('color', CAT.red).text(error.message);
    }
  });
}
