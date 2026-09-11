import { inside } from './thermal.js';

// Find the widest interior position in image coordinates, then refine locally.
// Cache this per geometry change so playback does not repeat the search.
export function roomLabelPoint(polygon, aspect = 1) {
  const poly = polygon.map(p => ({ x: p.x * aspect, y: p.y }));
  const clearance = p => {
    if (!inside(p, poly)) return -Infinity;
    return Math.min(...poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy) || 0));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }));
  };
  const minX = Math.min(...poly.map(p => p.x)), maxX = Math.max(...poly.map(p => p.x));
  const minY = Math.min(...poly.map(p => p.y)), maxY = Math.max(...poly.map(p => p.y));
  let best = poly[0], score = -Infinity;
  const consider = p => { const d = clearance(p); if (d > score) { score = d; best = p; } };
  const dx = (maxX - minX) / 64, dy = (maxY - minY) / 64;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) consider({ x: minX + (x + .5) * dx, y: minY + (y + .5) * dy });
  for (let step = Math.max(dx, dy); step > 1e-6; step /= 2) {
    const centre = best;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) consider({ x: centre.x + x * step, y: centre.y + y * step });
  }
  return { x: best.x / aspect, y: best.y };
}
