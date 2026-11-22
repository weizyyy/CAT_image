import { rosterEntries } from '../roster.js';
// ── SillyImage Lab UI 工具函数 ──
// [AI-Fix] 原 ui.js 与 theme.js 重复定义了 toast/esc/escAttr/sbtn/fi，这里统一复用 theme.js 实现
export { toast, esc, escAttr, sbtn, fi } from './theme.js';

export function chkProf() { return rosterEntries().length > 0; }