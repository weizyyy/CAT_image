const nonemptyText = value => typeof value === 'string' && !!value.trim();
const hasOnlyFields = (value, fields) => value && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const optionalTextList = value => value === undefined || Array.isArray(value) && value.every(nonemptyText);

// MOSS-Image model-facing layout. Bounding boxes are centered pixel edges in yxyx order.
export function parseMossLayout(prompt, canvas) {
    let layout;
    try { layout = JSON.parse(prompt); } catch { return null; }
    if (!hasOnlyFields(layout, ['summary', 'items', 'bbox_coord_space', 'bbox_format']) ||
        layout.bbox_coord_space !== 'abs_centralized' || layout.bbox_format !== 'yxyx') return null;
    const { summary, items } = layout;
    if (!hasOnlyFields(summary, ['caption', 'meta', 'canvas', 'palette']) || !nonemptyText(summary.caption) ||
        (summary.canvas !== undefined && summary.canvas !== 'single') ||
        !optionalTextList(summary.meta) || !optionalTextList(summary.palette) ||
        !Array.isArray(items) || !items.length) return null;

    for (const item of items) {
        if (!hasOnlyFields(item, ['label', 'caption', 'bbox', 'tags', 'palette', 'text']) ||
            !['character', 'object', 'text'].includes(item.label) || !nonemptyText(item.caption) ||
            !optionalTextList(item.tags) || !optionalTextList(item.palette) ||
            (item.label === 'text' ? !nonemptyText(item.text) : item.text !== undefined)) return null;
        const box = item.bbox;
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isSafeInteger)) return null;
        const [top, left, bottom, right] = box;
        if (top >= bottom || left >= right) return null;
        if (canvas && (top < -canvas.height / 2 || bottom > canvas.height / 2 ||
            left < -canvas.width / 2 || right > canvas.width / 2)) return null;
    }
    return layout;
}
