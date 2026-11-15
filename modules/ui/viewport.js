export function clampPosition(x, y, width, height, viewport) {
    const left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0;
    const maxX = left + Math.max(0, viewport.width - width);
    const maxY = top + Math.max(0, viewport.height - height);
    return { x: Math.min(maxX, Math.max(left, Number.isFinite(x) ? x : maxX)),
        y: Math.min(maxY, Math.max(top, Number.isFinite(y) ? y : maxY)) };
}
