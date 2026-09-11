// Geometry uses image coordinates with X corrected for the image aspect ratio.
// Visibility paths keep interpolation inside polygons, crossing only explicit doors.
export function inside(p, poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (Math.abs(cross(a, b, p)) < 1e-9 && p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
}
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function visible(a, b, poly) {
  // Split at all boundary intersections, including collinear polygon vertices.
  const cuts = [0, 1], dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  if (length2 < 1e-16) return true;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length], ex = d.x - c.x, ey = d.y - c.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) {
      if (Math.abs(cross(a, b, c)) < 1e-9) for (const p of [c, d]) { const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2; if (t > 0 && t < 1) cuts.push(t); }
    } else {
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i] + cuts[i - 1]) / 2;
    if (!inside({ x: a.x + t * dx, y: a.y + t * dy }, poly)) return false;
  }
  return true;
}

export function buildField(floor, aspect = 1) {
  const point = p => ({ x: p.x * aspect, y: p.y });
  const rooms = floor.rooms.map(r => ({ ...r, polygon: r.polygon.map(point), nodes: [] }));
  const byID = new Map(rooms.map(r => [r.id, r]));
  const nodes = [], edges = [];
  function add(p, room) { const index = nodes.length; nodes.push(p); edges.push([]); byID.get(room).nodes.push(index); return index; }
  for (const r of rooms) for (const p of r.polygon) add(p, r.id);
  const sources = floor.sensors.map(s => ({ ...s, node: add(point(s.point), s.room_id) }));
  const doors = floor.doors.filter(d => d.influence > 0).map(d => ({ ...d, left: add(point(d.a), d.room_a), right: add(point(d.b), d.room_b) }));
  function link(a, b, cost) { edges[a].push([b, cost]); edges[b].push([a, cost]); }
  for (const r of rooms) for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) {
    const a = r.nodes[i], b = r.nodes[j]; if (visible(nodes[a], nodes[b], r.polygon)) link(a, b, distance(nodes[a], nodes[b]));
  }
  for (const d of doors) link(d.left, d.right, distance(nodes[d.left], nodes[d.right]) + 0.15 / d.influence);
  const distances = sources.map(s => {
    const costs = new Float64Array(nodes.length).fill(Infinity), done = new Uint8Array(nodes.length); costs[s.node] = 0;
    for (let step = 0; step < nodes.length; step++) {
      let current = -1, best = Infinity;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && costs[i] < best) { best = costs[i]; current = i; }
      if (current < 0) break; done[current] = 1;
      for (const [next, cost] of edges[current]) if (best + cost < costs[next]) costs[next] = best + cost;
    }
    return costs;
  });
  function weights(p, roomID) {
    const room = byID.get(roomID), q = point(p);
    const reachable = room.nodes.filter(n => visible(q, nodes[n], room.polygon)).map(n => [n, distance(q, nodes[n])]);
    return distances.map(costs => {
      let best = Infinity;
      for (const [n, d] of reachable) best = Math.min(best, d + costs[n]);
      return Number.isFinite(best) ? 1 / Math.max(best * best, 1e-12) : 0;
    });
  }
  function evaluate(weights, values) {
    let sum = 0, total = 0;
    sources.forEach((s, i) => { const value = values[s.entity_id]; if (Number.isFinite(value)) { sum += value * weights[i]; total += weights[i]; } });
    return total ? sum / total : null;
  }
  return { weights, evaluate, sources };
}

export function valueAt(series, stamp) {
  if (!series?.length) return null;
  let lo = 0, hi = series.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (series[mid].start <= stamp) lo = mid + 1; else hi = mid; }
  const row = series[lo - 1];
  return row && stamp < row.end && Number.isFinite(row.value) ? row.value : null;
}

export function colour(value, min = 15, max = 28) {
  const stops = [[77, 113, 229], [51, 180, 203], [112, 201, 156], [239, 203, 102], [233, 116, 79], [191, 62, 79]];
  const t = Math.max(0, Math.min(1, (value - min) / (max - min))) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
}
