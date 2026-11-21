/*!
 * Genzineers Environment Scanner — 3D room & object scanner
 * © 2026 Genzineers (https://genzineers.com). All rights reserved.
 * Licensed under the Genzineers Source-Available License (GSAL) v1.0 — see LICENSE.
 */
'use strict';
(function () {
  const ES = window.ES; if (!ES) return;
  const { $, toast, status, consent, fitCanvas, registerCam, stopOtherCams, stopStream, startHeading, getHeading, errMsg, download } = ES;
  const MAX_POINTS = 600000;

  // ---------- state ----------
  const S3 = {
    mode: 'room',
    objSize: 0.4, objRot: 'turntable', objStep: 30, flip: false,
    removeTable: false, removeStray: false,
  };
  const newCloud = () => ({ pos: [], col: [], vox: new Set() });
  let base = newCloud();            // AR + imported points (append only)
  let ai = newCloud();              // rebuilt from AI captures
  let aiMesh = { pos: [], col: [], idx: [] };
  const captures = [];              // raw AI depth captures in camera space
  let VIEW = { pos: [], col: [], n: 0 };

  function addTo(cl, x, y, z, r, g, b, voxel) {
    if ((base.pos.length + ai.pos.length) / 3 >= MAX_POINTS) return false;
    if (voxel) {
      const k = Math.round(x / voxel) + ',' + Math.round(y / voxel) + ',' + Math.round(z / voxel);
      if (cl.vox.has(k)) return false; cl.vox.add(k);
    }
    cl.pos.push(x, y, z); cl.col.push(r, g, b); return true;
  }
  const isObj = () => S3.mode === 'object';
  function heightColor(y, y0, y1) {
    const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0 || 1)));
    return [Math.round(40 + 215 * t), Math.round(200 - 80 * Math.abs(t - 0.5) * 2), Math.round(255 - 200 * t)];
  }

  // Combine sources and apply clean-up filters into the view/export cloud.
  function refresh() {
    let pos = base.pos.concat(ai.pos), col = base.col.concat(ai.col);
    if (S3.removeTable && base.pos.length) {
      const keep = tableFilterY(base.pos);
      if (keep) {
        const p2 = [], c2 = [];
        for (let i = 0; i < base.pos.length / 3; i++) if (base.pos[i * 3 + 1] > keep) { p2.push(base.pos[i * 3], base.pos[i * 3 + 1], base.pos[i * 3 + 2]); c2.push(base.col[i * 3], base.col[i * 3 + 1], base.col[i * 3 + 2]); }
        pos = p2.concat(ai.pos); col = c2.concat(ai.col);
      }
    }
    if (S3.removeStray && pos.length > 30) ({ pos, col } = strayFilter(pos, col));
    VIEW = { pos, col, n: pos.length / 3 };
    $('s3d-count').textContent = VIEW.n.toLocaleString() + ' points' + (aiMesh.idx.length ? ` · ${(aiMesh.idx.length / 3).toLocaleString()} triangles` : '');
    render();
  }
  // y-level just above the dominant horizontal plane at the bottom (for gravity-aligned AR / imported scans)
  function tableFilterY(p) {
    const n = p.length / 3; if (n < 50) return null;
    let y0 = Infinity, y1 = -Infinity; for (let i = 0; i < n; i++) { const y = p[i * 3 + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bin = isObj() ? 0.005 : 0.02, lim = y0 + (y1 - y0) * 0.4, hist = new Map();
    for (let i = 0; i < n; i++) { const y = p[i * 3 + 1]; if (y <= lim) { const b = Math.floor((y - y0) / bin); hist.set(b, (hist.get(b) || 0) + 1); } }
    let best = 0, bv = 0; for (const [b, v] of hist) if (v > bv) { bv = v; best = b; }
    if (bv < n * 0.03) return null;
    return y0 + (best + 1) * bin + (isObj() ? 0.008 : 0.03);
  }
  function strayFilter(pos, col) {
    const n = pos.length / 3; let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = pos[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    const cell = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 120 || 0.01;
    const key = (x, y, z) => x + ',' + y + ',' + z, grid = new Map(), ci = new Int32Array(n * 3);
    for (let i = 0; i < n; i++) { const x = Math.floor(pos[i * 3] / cell), y = Math.floor(pos[i * 3 + 1] / cell), z = Math.floor(pos[i * 3 + 2] / cell); ci[i * 3] = x; ci[i * 3 + 1] = y; ci[i * 3 + 2] = z; const k = key(x, y, z); grid.set(k, (grid.get(k) || 0) + 1); }
    const dens = new Map();
    const p2 = [], c2 = [];
    for (let i = 0; i < n; i++) {
      const k = key(ci[i * 3], ci[i * 3 + 1], ci[i * 3 + 2]);
      let d = dens.get(k);
      if (d == null) { d = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) d += grid.get(key(ci[i * 3] + dx, ci[i * 3 + 1] + dy, ci[i * 3 + 2] + dz)) || 0; dens.set(k, d); }
      if (d >= 6) { p2.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); c2.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]); }
    }
    return { pos: p2, col: c2 };
  }
  function clearAll() { base = newCloud(); ai = newCloud(); aiMesh = { pos: [], col: [], idx: [] }; captures.length = 0; $('ai-undo').disabled = true; refresh(); }

  // ---------- mode UI ----------
  function setMode(m) {
    S3.mode = m;
    document.querySelectorAll('#s3d-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('obj-opts').classList.toggle('hidden', m !== 'object');
    $('tab-scan3d').classList.toggle('obj-mode', m === 'object');
    $('ai-scale-label').textContent = m === 'object' ? 'Distance from camera to object' : 'Distance to centre of view';
    const sc = $('ai-scale');
    if (m === 'object' && +sc.value > 1.5) sc.value = 0.5;
    if (m === 'room' && +sc.value < 1) sc.value = 2.5;
    $('ai-scale-val').textContent = (+sc.value).toFixed(2) + ' m';
    $('ai-desc').textContent = m === 'object'
      ? 'An AI model estimates depth from each photo. Put the object in the dashed box, keep the phone still, capture, turn the object clockwise (seen from above) by the set angle, capture again. One-time model download (27–50 MB); runs fully on your device.'
      : 'An AI model estimates depth from each photo. Stand in one spot, capture, turn about 30°, capture again — views are stitched around you using the compass. One-time model download (27–50 MB); runs fully on your device.';
    const nm = $('dl-name'); if (/^(room|object)-scan$/.test(nm.value)) nm.value = m === 'object' ? 'object-scan' : 'room-scan';
    $('dl-center').checked = m === 'object';
    if (captures.length) rebuildAI();
  }
  $('s3d-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('obj-size').addEventListener('input', (e) => { S3.objSize = +e.target.value; $('obj-size-val').textContent = Math.round(S3.objSize * 100) + ' cm'; if (captures.length) rebuildAI(); });
  $('obj-rot').addEventListener('change', (e) => { S3.objRot = e.target.value; $('obj-step-wrap').classList.toggle('hidden', S3.objRot !== 'turntable'); if (S3.objRot === 'compass') startHeading(); if (captures.length) rebuildAI(); });
  $('obj-step').addEventListener('change', (e) => { S3.objStep = +e.target.value; if (captures.length) rebuildAI(); });
  $('obj-flip').addEventListener('change', (e) => { S3.flip = e.target.checked; if (captures.length) rebuildAI(); });
  const toggle = (id, key) => $(id).addEventListener('click', () => { S3[key] = !S3[key]; $(id).setAttribute('aria-pressed', S3[key]); if (key === 'removeTable' && captures.length) rebuildAI(); else refresh(); });
  toggle('obj-table', 'removeTable'); toggle('obj-clean', 'removeStray');

  // ---------- viewer ----------
  const V = { yaw: 0.6, pitch: 0.5, dist: 5, target: [0, 0, 0] };
  function fitView() {
    const n = VIEW.n; if (!n) { V.target = [0, 0, 0]; V.dist = 5; return; }
    const P = VIEW.pos; let sx = 0, sy = 0, sz = 0, m = 0; const step = Math.max(1, Math.floor(n / 5000));
    for (let i = 0; i < n; i += step) { sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; m++; }
    V.target = [sx / m, sy / m, sz / m];
    let r = 0; for (let i = 0; i < n; i += step) r = Math.max(r, Math.hypot(P[i * 3] - V.target[0], P[i * 3 + 1] - V.target[1], P[i * 3 + 2] - V.target[2]));
    V.dist = Math.max(0.2, r * 2.4);
  }
  let rq = 0;
  function render() { if (rq) return; rq = requestAnimationFrame(() => { rq = 0; draw(); }); }
  function draw() {
    const c = $('s3d-view'); if (!c.clientWidth) return;
    const { ctx, w, h, dpr } = fitCanvas(c, 1.5);
    const img = ctx.createImageData(w, h), d = img.data, zb = new Float32Array(w * h).fill(Infinity);
    for (let i = 0; i < d.length; i += 4) { d[i] = 5; d[i + 1] = 8; d[i + 2] = 11; d[i + 3] = 255; }
    const cp = Math.cos(V.pitch), sp = Math.sin(V.pitch), cyw = Math.cos(V.yaw), syw = Math.sin(V.yaw);
    const eye = [V.target[0] + V.dist * cp * syw, V.target[1] + V.dist * sp, V.target[2] + V.dist * cp * cyw];
    const f = [V.target[0] - eye[0], V.target[1] - eye[1], V.target[2] - eye[2]]; const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
    const rl = Math.hypot(f[2], f[0]) || 1, r = [-f[2] / rl, 0, f[0] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const foc = h * 0.9, ps = Math.max(1, Math.round(dpr * 1.6)), n = VIEW.n, pos = VIEW.pos, col = VIEW.col;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3] - eye[0], y = pos[i * 3 + 1] - eye[1], z = pos[i * 3 + 2] - eye[2];
      const zc = x * f[0] + y * f[1] + z * f[2]; if (zc < 0.02) continue;
      const sx = Math.round(w / 2 + ((x * r[0] + y * r[1] + z * r[2]) * foc) / zc);
      const sy = Math.round(h / 2 - ((x * u[0] + y * u[1] + z * u[2]) * foc) / zc);
      if (sx < 0 || sy < 0 || sx >= w - ps || sy >= h - ps) continue;
      const shade = Math.max(0.35, Math.min(1, 1.6 - zc / (V.dist * 1.6)));
      for (let oy = 0; oy < ps; oy++) for (let ox = 0; ox < ps; ox++) {
        const k = (sy + oy) * w + sx + ox; if (zc >= zb[k]) continue; zb[k] = zc;
        const o = k * 4; d[o] = col[i * 3] * shade; d[o + 1] = col[i * 3 + 1] * shade; d[o + 2] = col[i * 3 + 2] * shade;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (!n) {
      ctx.fillStyle = '#8ea2b4'; ctx.font = `${14 * dpr}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText('No 3D points yet — choose a scan method above', w / 2, h / 2); ctx.textAlign = 'start';
    }
  }
  const ptrs = new Map(); let pinch0 = 0, dist0 = 0;
  const view = $('s3d-view');
  view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = V.dist; } });
  view.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) { V.yaw -= (e.clientX - prev[0]) * 0.008; V.pitch = Math.max(-1.55, Math.min(1.55, V.pitch + (e.clientY - prev[1]) * 0.008)); }
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const p = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0) V.dist = Math.max(0.05, dist0 * (pinch0 / p)); }
    render();
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); V.dist = Math.max(0.05, V.dist * Math.exp(e.deltaY * 0.001)); render(); }, { passive: false });
  $('s3d-top').addEventListener('click', () => { V.pitch = 1.55; render(); });
  $('s3d-reset').addEventListener('click', () => { V.yaw = 0.6; V.pitch = 0.5; fitView(); render(); });
  $('s3d-clear').addEventListener('click', () => { if (VIEW.n && !confirm('Delete this 3D scan?')) return; clearAll(); });
  $('s3d-quick').addEventListener('click', () => { $('dl-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }); exportScan(); });
  window.addEventListener('resize', render);

  // ---------- mesh building ----------
  function voxelMesh(pos, col, size) {
    const n = pos.length / 3;
    let vox;
    for (let tries = 0; tries < 6; tries++) {
      vox = new Map();
      for (let i = 0; i < n; i++) {
        const k = Math.floor(pos[i * 3] / size) + ',' + Math.floor(pos[i * 3 + 1] / size) + ',' + Math.floor(pos[i * 3 + 2] / size);
        const v = vox.get(k); if (v) { v[0] += col[i * 3]; v[1] += col[i * 3 + 1]; v[2] += col[i * 3 + 2]; v[3]++; } else vox.set(k, [col[i * 3], col[i * 3 + 1], col[i * 3 + 2], 1]);
      }
      if (vox.size <= 150000) break;
      size *= 1.5;
    }
    const out = { pos: [], col: [], idx: [] };
    const F = [ // dir, 4 corners (unit cube)
      [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]], [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
      [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]], [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
      [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]], [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
    ];
    for (const [k, v] of vox) {
      const [x, y, z] = k.split(',').map(Number); const r = v[0] / v[3], g = v[1] / v[3], b = v[2] / v[3];
      for (const [dd, cs] of F) {
        if (vox.has((x + dd[0]) + ',' + (y + dd[1]) + ',' + (z + dd[2]))) continue;
        const s = out.pos.length / 3;
        for (const c of cs) { out.pos.push((x + c[0]) * size, (y + c[1]) * size, (z + c[2]) * size); out.col.push(r, g, b); }
        out.idx.push(s, s + 1, s + 2, s, s + 2, s + 3);
      }
    }
    return out;
  }
  function extentOf(pos) {
    let mx = 0; const n = pos.length / 3; if (!n) return 1;
    const mn = [Infinity, Infinity, Infinity], ma = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = pos[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > ma[a]) ma[a] = v; }
    for (let a = 0; a < 3; a++) mx = Math.max(mx, ma[a] - mn[a]);
    return mx || 1;
  }
  function buildMesh(detail) {
    const div = { fine: 260, medium: 140, coarse: 70, auto: isObj() ? 160 : 120 }[detail];
    if (detail === 'auto' && aiMesh.idx.length) {
      if (!base.pos.length) return aiMesh;
      const vm = voxelMesh(base.pos, base.col, extentOf(base.pos) / div);
      const off = aiMesh.pos.length / 3;
      return { pos: aiMesh.pos.concat(vm.pos), col: aiMesh.col.concat(vm.col), idx: aiMesh.idx.concat(vm.idx.map((i) => i + off)) };
    }
    return voxelMesh(VIEW.pos, VIEW.col, extentOf(VIEW.pos) / div);
  }
  // optional: centre at origin with the lowest point on y = 0
  function centred(pos) {
    if (!$('dl-center').checked || !pos.length) return pos;
    const n = pos.length / 3; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, pos[i * 3]); x1 = Math.max(x1, pos[i * 3]); y0 = Math.min(y0, pos[i * 3 + 1]); z0 = Math.min(z0, pos[i * 3 + 2]); z1 = Math.max(z1, pos[i * 3 + 2]); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out = new Float32Array(pos.length);
    for (let i = 0; i < n; i++) { out[i * 3] = pos[i * 3] - cx; out[i * 3 + 1] = pos[i * 3 + 1] - y0; out[i * 3 + 2] = pos[i * 3 + 2] - cz; }
    return out;
  }

  // ---------- writers ----------
  function writePLYPoints(pos, col) {
    const n = pos.length / 3;
    const hb = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment Genzineers Environment Scanner\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
    const buf = new ArrayBuffer(hb.length + n * 15), dv = new DataView(buf); new Uint8Array(buf).set(hb);
    for (let i = 0, o = hb.length; i < n; i++, o += 15) { dv.setFloat32(o, pos[i * 3], true); dv.setFloat32(o + 4, pos[i * 3 + 1], true); dv.setFloat32(o + 8, pos[i * 3 + 2], true); dv.setUint8(o + 12, col[i * 3]); dv.setUint8(o + 13, col[i * 3 + 1]); dv.setUint8(o + 14, col[i * 3 + 2]); }
    return new Blob([buf], { type: 'application/octet-stream' });
  }
  function writePLYMesh(m) {
    const n = m.pos.length / 3, f = m.idx.length / 3;
    const hb = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment Genzineers Environment Scanner\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${f}\nproperty list uchar int vertex_indices\nend_header\n`);
    const buf = new ArrayBuffer(hb.length + n * 15 + f * 13), dv = new DataView(buf); new Uint8Array(buf).set(hb);
    let o = hb.length;
    for (let i = 0; i < n; i++, o += 15) { dv.setFloat32(o, m.pos[i * 3], true); dv.setFloat32(o + 4, m.pos[i * 3 + 1], true); dv.setFloat32(o + 8, m.pos[i * 3 + 2], true); dv.setUint8(o + 12, m.col[i * 3]); dv.setUint8(o + 13, m.col[i * 3 + 1]); dv.setUint8(o + 14, m.col[i * 3 + 2]); }
    for (let i = 0; i < f; i++, o += 13) { dv.setUint8(o, 3); dv.setInt32(o + 1, m.idx[i * 3], true); dv.setInt32(o + 5, m.idx[i * 3 + 1], true); dv.setInt32(o + 9, m.idx[i * 3 + 2], true); }
    return new Blob([buf], { type: 'application/octet-stream' });
  }
  function writeOBJ(m) {
    const parts = ['# Genzineers Environment Scanner\n# vertex colours: v x y z r g b\n'];
    const n = m.pos.length / 3; let chunk = [];
    const flush = () => { parts.push(chunk.join('\n') + '\n'); chunk = []; };
    for (let i = 0; i < n; i++) { chunk.push(`v ${m.pos[i * 3].toFixed(4)} ${m.pos[i * 3 + 1].toFixed(4)} ${m.pos[i * 3 + 2].toFixed(4)} ${(m.col[i * 3] / 255).toFixed(3)} ${(m.col[i * 3 + 1] / 255).toFixed(3)} ${(m.col[i * 3 + 2] / 255).toFixed(3)}`); if (chunk.length > 20000) flush(); }
    for (let i = 0; i < m.idx.length; i += 3) { chunk.push(`f ${m.idx[i] + 1} ${m.idx[i + 1] + 1} ${m.idx[i + 2] + 1}`); if (chunk.length > 20000) flush(); }
    flush();
    return new Blob(parts, { type: 'text/plain' });
  }
  function writeSTL(m) {
    // millimetres, Z up (3D-printing convention)
    const f = m.idx.length / 3, buf = new ArrayBuffer(84 + f * 50), dv = new DataView(buf);
    const head = new TextEncoder().encode('Genzineers Environment Scanner - units mm'); new Uint8Array(buf).set(head.slice(0, 80));
    dv.setUint32(80, f, true);
    const P = (i) => [m.pos[i * 3] * 1000, -m.pos[i * 3 + 2] * 1000, m.pos[i * 3 + 1] * 1000];
    for (let t = 0, o = 84; t < f; t++, o += 50) {
      const a = P(m.idx[t * 3]), b = P(m.idx[t * 3 + 1]), c = P(m.idx[t * 3 + 2]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0]; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      [nx, ny, nz, ...a, ...b, ...c].forEach((val, k) => dv.setFloat32(o + k * 4, val, true));
      dv.setUint16(o + 48, 0, true);
    }
    return new Blob([buf], { type: 'model/stl' });
  }
  function writeGLB(m, points) {
    const n = m.pos.length / 3, pos = new Float32Array(m.pos), col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { col[i * 4] = m.col[i * 3]; col[i * 4 + 1] = m.col[i * 3 + 1]; col[i * 4 + 2] = m.col[i * 3 + 2]; col[i * 4 + 3] = 255; }
    const idx = points ? null : new Uint32Array(m.idx);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = pos[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    const pad4 = (x) => (x + 3) & ~3;
    const oPos = 0, oCol = pad4(pos.byteLength), oIdx = oCol + pad4(col.byteLength), binLen = pad4(oIdx + (idx ? idx.byteLength : 0));
    const bufferViews = [{ buffer: 0, byteOffset: oPos, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: oCol, byteLength: col.byteLength, target: 34962 }];
    const accessors = [{ bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: mn, max: mx }, { bufferView: 1, componentType: 5121, normalized: true, count: n, type: 'VEC4' }];
    const prim = { attributes: { POSITION: 0, COLOR_0: 1 }, material: 0, mode: points ? 0 : 4 };
    if (idx) { bufferViews.push({ buffer: 0, byteOffset: oIdx, byteLength: idx.byteLength, target: 34963 }); accessors.push({ bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' }); prim.indices = 2; }
    const json = {
      asset: { version: '2.0', generator: 'Genzineers Environment Scanner', copyright: 'Scan data owned by its creator' },
      extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'scan' }],
      meshes: [{ name: 'scan', primitives: [prim] }],
      materials: [{ name: 'vertex-colour', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, extensions: { KHR_materials_unlit: {} } }],
      buffers: [{ byteLength: binLen }], bufferViews, accessors,
    };
    let js = new TextEncoder().encode(JSON.stringify(json)); const jl = pad4(js.length);
    const jsP = new Uint8Array(jl).fill(0x20); jsP.set(js); js = jsP;
    const total = 12 + 8 + jl + 8 + binLen, out = new ArrayBuffer(total), dv = new DataView(out), u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); u8.set(js, 20);
    const b0 = 20 + jl; dv.setUint32(b0, binLen, true); dv.setUint32(b0 + 4, 0x004e4942, true);
    const bin = b0 + 8; u8.set(new Uint8Array(pos.buffer), bin + oPos); u8.set(col, bin + oCol); if (idx) u8.set(new Uint8Array(idx.buffer), bin + oIdx);
    return new Blob([out], { type: 'model/gltf-binary' });
  }
  function writeXYZ(pos, col) {
    const parts = [], n = pos.length / 3; let ch = [];
    for (let i = 0; i < n; i++) { ch.push(`${pos[i * 3].toFixed(4)} ${pos[i * 3 + 1].toFixed(4)} ${pos[i * 3 + 2].toFixed(4)} ${col[i * 3] | 0} ${col[i * 3 + 1] | 0} ${col[i * 3 + 2] | 0}`); if (ch.length > 20000) { parts.push(ch.join('\n') + '\n'); ch = []; } }
    parts.push(ch.join('\n') + '\n');
    return new Blob(parts, { type: 'text/plain' });
  }
  function exportScan() {
    if (!VIEW.n) return toast('Nothing to download yet — scan or import something first.');
    const fmt = $('dl-format').value, detail = $('dl-detail').value;
    const name = ($('dl-name').value || 'scan').replace(/[^\w\-. ]+/g, '').trim() || 'scan';
    status('s3d-status', 'Preparing download…');
    setTimeout(() => {
      try {
        let blob, ext, info;
        if (fmt === 'ply' || fmt === 'xyz' || fmt === 'glbpoints') {
          const pos = centred(VIEW.pos), col = VIEW.col;
          blob = fmt === 'ply' ? writePLYPoints(pos, col) : fmt === 'xyz' ? writeXYZ(pos, col) : writeGLB({ pos, col }, true);
          ext = fmt === 'glbpoints' ? 'glb' : fmt; info = `${VIEW.n.toLocaleString()} points`;
        } else {
          const m0 = buildMesh(detail), m = { pos: centred(m0.pos), col: m0.col, idx: m0.idx };
          if (!m.idx.length) throw new Error('Not enough points to build a mesh');
          blob = fmt === 'glb' ? writeGLB(m) : fmt === 'obj' ? writeOBJ(m) : fmt === 'stl' ? writeSTL(m) : writePLYMesh(m);
          ext = fmt === 'plymesh' ? 'ply' : fmt; info = `${(m.idx.length / 3).toLocaleString()} triangles`;
        }
        download(`${name}.${ext}`, blob);
        status('s3d-status', `Downloaded ${name}.${ext} (${info}, ${(blob.size / 1048576).toFixed(1)} MB).`);
      } catch (e) { status('s3d-status', 'Download failed: ' + errMsg(e), true); }
    }, 30);
  }
  $('dl-go').addEventListener('click', exportScan);

  // ---------- import ----------
  $('imp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    status('s3d-status', 'Reading ' + file.name + '…');
    try {
      const buf = await file.arrayBuffer();
      const pts = /\.ply$/i.test(file.name) ? parsePLY(buf) : parseText(new TextDecoder().decode(buf), /\.obj$/i.test(file.name));
      if (!pts.n) throw new Error('No points found in file');
      const room = MAX_POINTS - (base.pos.length + ai.pos.length) / 3;
      if (room <= 0) throw new Error('Point limit reached — clear the scan first');
      const step = Math.max(1, Math.ceil(pts.n / room));
      let y0 = Infinity, y1 = -Infinity; for (let i = 0; i < pts.n; i += step) { y0 = Math.min(y0, pts.p[i * 3 + 1]); y1 = Math.max(y1, pts.p[i * 3 + 1]); }
      for (let i = 0; i < pts.n; i += step) {
        const c = pts.c ? [pts.c[i * 3], pts.c[i * 3 + 1], pts.c[i * 3 + 2]] : heightColor(pts.p[i * 3 + 1], y0, y1);
        addTo(base, pts.p[i * 3], pts.p[i * 3 + 1], pts.p[i * 3 + 2], c[0], c[1], c[2]);
      }
      refresh(); fitView(); render();
      $('dl-name').value = file.name.replace(/\.\w+$/, '');
      status('s3d-status', `Imported ${Math.ceil(pts.n / step).toLocaleString()} points from ${file.name}${step > 1 ? ' (thinned for speed)' : ''}. You can now download it in another format.`);
    } catch (err) { status('s3d-status', 'Import failed: ' + errMsg(err), true); }
  });
  function parseText(txt, isObjFile) {
    const p = [], c = []; let hasC = true;
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim().split(/[\s,;]+/);
      if (isObjFile) { if (t[0] !== 'v') continue; t.shift(); }
      if (t.length < 3 || isNaN(+t[0])) continue;
      p.push(+t[0], +t[1], +t[2]);
      if (t.length >= 6) { const s = +t[3] <= 1 && +t[4] <= 1 && +t[5] <= 1 ? 255 : 1; c.push(+t[3] * s, +t[4] * s, +t[5] * s); } else hasC = false;
    }
    return { n: p.length / 3, p, c: hasC && c.length === p.length ? c : null };
  }
  function parsePLY(buf) {
    const bytes = new Uint8Array(buf);
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const hi = head.indexOf('end_header'); if (hi < 0) throw new Error('Not a PLY file');
    let end = new TextEncoder().encode(head.slice(0, hi + 'end_header'.length)).length; while (bytes[end] === 10 || bytes[end] === 13) end++;
    const lines = head.slice(0, hi).split(/\r?\n/);
    const fmt = (lines.find((l) => l.startsWith('format')) || '').split(' ')[1];
    let nv = 0, inV = false; const props = [];
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      if (t[0] === 'element') { inV = t[1] === 'vertex'; if (inV) nv = +t[2]; }
      else if (t[0] === 'property' && inV && t[1] !== 'list') props.push({ type: t[1], name: t[2] });
    }
    const idx = (n) => props.findIndex((p) => p.name === n);
    const ix = idx('x'), iy = idx('y'), iz = idx('z'), ir = Math.max(idx('red'), idx('r')), ig = Math.max(idx('green'), idx('g')), ib = Math.max(idx('blue'), idx('b'));
    const p = new Float32Array(nv * 3), c = ir >= 0 ? new Uint8Array(nv * 3) : null;
    if (fmt === 'ascii') {
      const rows = new TextDecoder().decode(bytes.subarray(end)).split(/\r?\n/);
      for (let i = 0; i < nv; i++) { const t = rows[i].trim().split(/\s+/).map(Number); p[i * 3] = t[ix]; p[i * 3 + 1] = t[iy]; p[i * 3 + 2] = t[iz]; if (c) { c[i * 3] = t[ir]; c[i * 3 + 1] = t[ig]; c[i * 3 + 2] = t[ib]; } }
    } else {
      const le = fmt !== 'binary_big_endian', dv = new DataView(buf, end);
      const SZ = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
      const offs = []; let stride = 0; props.forEach((pr) => { offs.push(stride); stride += SZ[pr.type] || 4; });
      const rd = (o, type) => {
        switch (type) {
          case 'float': case 'float32': return dv.getFloat32(o, le);
          case 'double': case 'float64': return dv.getFloat64(o, le);
          case 'uchar': case 'uint8': return dv.getUint8(o);
          case 'char': case 'int8': return dv.getInt8(o);
          case 'short': case 'int16': return dv.getInt16(o, le);
          case 'ushort': case 'uint16': return dv.getUint16(o, le);
          case 'int': case 'int32': return dv.getInt32(o, le);
          default: return dv.getUint32(o, le);
        }
      };
      for (let i = 0; i < nv; i++) {
        const b = i * stride;
        p[i * 3] = rd(b + offs[ix], props[ix].type); p[i * 3 + 1] = rd(b + offs[iy], props[iy].type); p[i * 3 + 2] = rd(b + offs[iz], props[iz].type);
        if (c) { c[i * 3] = rd(b + offs[ir], props[ir].type); c[i * 3 + 1] = rd(b + offs[ig], props[ig].type); c[i * 3 + 2] = rd(b + offs[ib], props[ib].type); }
      }
    }
    return { n: nv, p, c };
  }

  // ---------- AR depth scan (WebXR) ----------
  function setArPill() {
    const p = $('m-ar-pill');
    if (window.ES_HAS.xrAR) { p.className = 'pill ok'; p.textContent = 'available'; }
    else { p.className = 'pill no'; p.textContent = ES.isIOS ? 'not on iOS' : 'not here'; }
  }
  window.addEventListener('es-xr', setArPill); setTimeout(setArPill, 1500);

  let overlay;
  function arOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'ar-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:15px system-ui;color:#fff;';
    overlay.innerHTML = '<div style="position:absolute;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top));background:#000a;padding:10px 14px;border-radius:12px" id="ar-info">Move the phone slowly…</div><div id="ar-reticle" style="position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px;border:2px solid #2ee6a6;border-radius:50%"></div><button id="ar-stop" style="pointer-events:auto;position:absolute;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#2ee6a6;color:#062218;border:0;border-radius:99px;padding:14px 28px;font:600 16px system-ui">Finish scan</button>';
    document.body.appendChild(overlay);
    return overlay;
  }
  $('ar-start').addEventListener('click', async () => {
    if (!window.ES_HAS.xrAR) {
      return status('s3d-status', ES.isIOS ? 'iPhone/iPad browsers don\'t offer AR depth to websites. Use "AI depth from camera" here, or scan with a LiDAR app (3D Scanner App, Polycam, Scaniverse) and import the .ply/.obj.' : 'AR isn\'t available in this browser. On Android, use Chrome with Google Play Services for AR installed. Otherwise use AI depth or import a scan.', true);
    }
    if (!(await consent('ar'))) return;
    stopOtherCams('ar');
    const obj = isObj(), R = S3.objSize / 2;
    const ov = arOverlay(); ov.style.display = 'block';
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local'],
        optionalFeatures: ['depth-sensing', 'hit-test', 'dom-overlay'],
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
        domOverlay: { root: ov },
      });
    } catch (e) { ov.style.display = 'none'; return status('s3d-status', 'Could not start AR: ' + errMsg(e), true); }
    const gl = document.createElement('canvas').getContext('webgl', { xrCompatible: true, alpha: true });
    await session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    const ref = await session.requestReferenceSpace('local');
    const viewerSpace = await session.requestReferenceSpace('viewer');
    const ef = session.enabledFeatures;
    const useDepth = ef ? ef.includes('depth-sensing') : true;
    const hitSources = [];
    if (session.requestHitTestSource && (!useDepth || !ef)) {
      const span = obj ? 1 : 3, sp = obj ? 0.04 : 0.12;
      for (let gy = -2; gy <= 2; gy++) for (let gx = -span; gx <= span; gx++) {
        try { hitSources.push({ src: await session.requestHitTestSource({ space: viewerSpace, offsetRay: new XRRay({ x: 0, y: 0, z: 0 }, { x: gx * sp, y: gy * sp, z: -1 }) }), center: gx === 0 && gy === 0 }); } catch (e) { break; }
      }
    }
    let frameNo = 0, depthWorked = false, y0 = -1.6, y1 = 1.2, objC = null;
    const voxel = obj ? 0.005 : 0.03, GX = obj ? 64 : 40, GY = obj ? 48 : 30;
    const info = $('ar-info');
    info.textContent = obj ? 'Point the circle at the middle of the object to lock on…' : 'Move the phone slowly around the room…';
    $('ar-stop').onclick = () => session.end();
    const keep = (x, y, z) => !obj || !objC || (Math.hypot(x - objC.x, z - objC.z) <= R * 1.15 && y > objC.y - R * 1.6 && y < objC.y + R * 1.6);
    const lockAt = (x, y, z, M) => {
      // shift from the front surface to roughly the object's middle
      const fx = -M[8], fz = -M[10], fl = Math.hypot(fx, fz) || 1;
      objC = { x: x + (fx / fl) * R * 0.5, y, z: z + (fz / fl) * R * 0.5 };
      y0 = y - R; y1 = y + R;
      if (navigator.vibrate) navigator.vibrate(60);
    };
    session.addEventListener('end', () => {
      ov.style.display = 'none'; hitSources.forEach((h) => h.src.cancel && h.src.cancel());
      refresh(); fitView(); render();
      status('s3d-status', `AR scan finished: ${VIEW.n.toLocaleString()} points${depthWorked ? ' from the depth sensor' : ' from surface hits'}. Drag to orbit, then download below.`);
    });
    const onFrame = (t, frame) => {
      session.requestAnimationFrame(onFrame);
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const pose = frame.getViewerPose(ref); if (!pose) return;
      frameNo++;
      if (frameNo % (obj ? 5 : 8) !== 0) return;
      for (const v of pose.views) {
        let di = null;
        if (useDepth && frame.getDepthInformation) { try { di = frame.getDepthInformation(v); } catch (e) { di = null; } }
        if (!di) continue;
        depthWorked = true;
        const P0 = v.projectionMatrix, M = v.transform.matrix;
        const toWorld = (u, w, z) => {
          const nx = u * 2 - 1, ny = 1 - w * 2, x = (z * (nx + P0[8])) / P0[0], y = (z * (ny + P0[9])) / P0[5], zz = -z;
          return [M[0] * x + M[4] * y + M[8] * zz + M[12], M[1] * x + M[5] * y + M[9] * zz + M[13], M[2] * x + M[6] * y + M[10] * zz + M[14]];
        };
        if (obj && !objC) {
          let z = 0; try { z = di.getDepthInMeters(0.5, 0.5); } catch (e) { /* none */ }
          if (z > 0.1 && z < 3) { const p = toWorld(0.5, 0.5, z); lockAt(p[0], p[1], p[2], M); } else continue;
        }
        for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
          const u = (gx + 0.5) / GX, w = (gy + 0.5) / GY;
          let z; try { z = di.getDepthInMeters(u, w); } catch (e) { z = 0; }
          if (!z || z < 0.1 || z > (obj ? 3 : 6)) continue;
          const [wx, wy, wz] = toWorld(u, w, z);
          if (!keep(wx, wy, wz)) continue;
          const c = heightColor(wy, y0, y1);
          addTo(base, wx, wy, wz, c[0], c[1], c[2], voxel);
        }
      }
      for (const hs of hitSources) {
        const res = frame.getHitTestResults(hs.src);
        if (!res.length) continue;
        const pz = res[0].getPose(ref).transform.position;
        if (obj && !objC && hs.center) lockAt(pz.x, pz.y, pz.z, pose.transform.matrix);
        if (!keep(pz.x, pz.y, pz.z)) continue;
        const c = heightColor(pz.y, y0, y1); addTo(base, pz.x, pz.y, pz.z, c[0], c[1], c[2], obj ? 0.01 : 0.04);
      }
      if (frameNo % 20 === 0) {
        const n = (base.pos.length / 3).toLocaleString();
        info.textContent = obj
          ? (objC ? `Locked on object · ${n} points · walk slowly all the way round, also look from above` : 'Point the circle at the middle of the object to lock on…')
          : `${n} points · ${depthWorked ? 'depth sensor' : hitSources.length ? 'surface hits (no depth on this phone)' : 'waiting for tracking…'} · cover walls, floor and furniture`;
      }
    };
    session.requestAnimationFrame(onFrame);
  });

  // ---------- AI monocular depth ----------
  const AI = { stream: null, pipe: null, loading: null };
  const aiStop = () => { stopStream(AI.stream); AI.stream = null; $('ai-wrap').classList.add('hidden'); $('ai-capture').disabled = true; $('ai-stop').disabled = true; };
  registerCam('ai3d', aiStop);
  $('ai-scale').addEventListener('input', (e) => { $('ai-scale-val').textContent = (+e.target.value).toFixed(2) + ' m'; });
  $('ai-scale').addEventListener('change', () => { if (captures.length) { captures[captures.length - 1].D = +$('ai-scale').value; rebuildAI(); } });
  $('ai-start').addEventListener('click', async () => {
    if (!(await consent('camera'))) return;
    stopOtherCams('ai3d'); aiStop();
    try { AI.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } } }); } catch (e) { return status('s3d-status', 'Camera error: ' + errMsg(e), true); }
    const v = $('ai-video'); v.srcObject = AI.stream; await v.play().catch(() => {});
    $('ai-wrap').classList.remove('hidden'); $('ai-capture').disabled = false; $('ai-stop').disabled = false;
    let msg;
    if (isObj()) {
      if (S3.objRot === 'compass') await startHeading();
      msg = S3.objRot === 'turntable' ? `Fit the object inside the dashed box, set the distance slider, then Capture. After each photo turn the object ${S3.objStep}° clockwise (seen from above).` : 'Fit the object inside the dashed box and capture. Then walk a few steps around it, keep it centred, and capture again.';
    } else {
      const live = await startHeading();
      msg = (live ? 'Compass on. ' : 'No compass: each capture assumes you turned 30° to the right. ') + 'Stand still, point at a part of the room and tap Capture.';
    }
    status('s3d-status', msg + ' Loading the AI model in the background…');
    loadModel();
  });
  $('ai-stop').addEventListener('click', aiStop);
  function loadModel() {
    if (AI.loading) return AI.loading;
    AI.loading = (async () => {
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2');
      T.env.allowLocalModels = false;
      const gpu = !!navigator.gpu;
      const opts = { device: gpu ? 'webgpu' : 'wasm', dtype: gpu ? 'fp16' : 'q8', progress_callback: (p) => { if (p.status === 'progress' && p.total) status('s3d-status', `Downloading AI depth model… ${Math.round((p.loaded / p.total) * 100)}% (one time only)`); } };
      try { AI.pipe = await T.pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', opts); }
      catch (e) { if (!gpu) throw e; AI.pipe = await T.pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', Object.assign(opts, { device: 'wasm', dtype: 'q8' })); }
      status('s3d-status', 'AI depth model ready. Tap Capture.');
      return AI.pipe;
    })();
    AI.loading.catch((e) => { AI.loading = null; status('s3d-status', 'Could not load the AI model: ' + errMsg(e) + '. Check your internet connection.', true); });
    return AI.loading;
  }

  $('ai-capture').addEventListener('click', async () => {
    const v = $('ai-video'); if (!v.videoWidth) return;
    $('ai-capture').disabled = true;
    try {
      const W = 384, H = Math.round((W * v.videoHeight) / v.videoWidth);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(v, 0, 0, W, H);
      const rgb = cx.getImageData(0, 0, W, H).data;
      const heading = window.ES.S.headingLive ? getHeading() : null;
      status('s3d-status', 'Estimating depth…');
      const pipe = await loadModel();
      const out = await pipe(cv.toDataURL('image/jpeg', 0.9));
      const t = out.predicted_depth; const dh = t.dims[t.dims.length - 2], dw = t.dims[t.dims.length - 1], disp = t.data;
      // depth-anything returns relative inverse depth (bigger = closer). Convert to metres using the
      // distance slider as the depth at the centre of the frame.
      const cIdx = Math.floor(dh / 2) * dw + Math.floor(dw / 2);
      let ctr = 0, cn = 0; for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) { ctr += disp[cIdx + yy * dw + xx]; cn++; } ctr /= cn;
      let mn = Infinity; for (let i = 0; i < disp.length; i++) mn = Math.min(mn, disp[i]);
      const off = Math.max(1e-3, mn * 0.98), fov = (66 * Math.PI) / 180, fx = dw / 2 / Math.tan(fov / 2);
      const step = Math.max(1, Math.round(dw / (isObj() ? 200 : 160)));
      const gw = Math.floor((dw - 1) / step), gh = Math.floor((dh - 1) / step), N = gw * gh;
      const cap = { gw, gh, nx: new Float32Array(N), ny: new Float32Array(N), rel: new Float32Array(N), col: new Uint8Array(N * 3), edge: new Uint8Array(N), heading, D: +$('ai-scale').value };
      const cRel = ctr - off + 1e-3;
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const x = gx * step, y = gy * step, i = y * dw + x, k = gy * gw + gx;
        cap.nx[k] = (x - dw / 2) / fx; cap.ny[k] = -(y - dh / 2) / fx;
        cap.rel[k] = cRel / (disp[i] - off + 1e-3);           // depth relative to the centre (1 = centre depth)
        const g = x > 0 && y > 0 && x < dw - 1 && y < dh - 1 ? Math.abs(disp[i + 1] - disp[i - 1]) + Math.abs(disp[i + dw] - disp[i - dw]) : 0;
        cap.edge[k] = g > (disp[i] || 1) * 0.12 ? 1 : 0;      // flying pixels at depth edges
        const px = Math.min(W - 1, Math.round((x / dw) * W)), py = Math.min(H - 1, Math.round((y / dh) * H)), o = (py * W + px) * 4;
        cap.col[k * 3] = rgb[o]; cap.col[k * 3 + 1] = rgb[o + 1]; cap.col[k * 3 + 2] = rgb[o + 2];
      }
      captures.push(cap); $('ai-undo').disabled = false;
      rebuildAI(); if (captures.length === 1) fitView(); render();
      const k = captures.length;
      status('s3d-status', isObj()
        ? (S3.objRot === 'turntable' ? `Photo ${k} added. Turn the object ${S3.objStep}° clockwise and capture again (${Math.max(0, Math.round(360 / S3.objStep) - k)} to go for a full circle).` : `Photo ${k} added. Walk a little further round the object and capture again.`)
        : `View ${k} added. Turn about 30° and capture again to wrap around the room.`);
    } catch (e) { status('s3d-status', 'Depth failed: ' + errMsg(e), true); }
    finally { $('ai-capture').disabled = !AI.stream; }
  });
  $('ai-undo').addEventListener('click', () => { captures.pop(); $('ai-undo').disabled = !captures.length; rebuildAI(); status('s3d-status', `Removed the last capture (${captures.length} left).`); });

  // Fit the table plane in one capture (camera space) with RANSAC.
  function tablePlane(P, valid) {
    const idx = []; for (let i = 0; i < valid.length; i++) if (valid[i]) idx.push(i);
    if (idx.length < 60) return null;
    let best = null, bestN = 0; const tol = S3.objSize * 0.03 + 0.003;
    for (let it = 0; it < 150; it++) {
      const a = idx[(Math.random() * idx.length) | 0], b = idx[(Math.random() * idx.length) | 0], c = idx[(Math.random() * idx.length) | 0];
      const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], u = [P[b * 3] - A[0], P[b * 3 + 1] - A[1], P[b * 3 + 2] - A[2]], v = [P[c * 3] - A[0], P[c * 3 + 1] - A[1], P[c * 3 + 2] - A[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); if (l < 1e-9) continue;
      n = n.map((x) => x / l); if (n[1] < 0) n = n.map((x) => -x);
      if (n[1] < 0.5) continue; // must be roughly horizontal (camera within ~60° of level)
      const d = -(n[0] * A[0] + n[1] * A[1] + n[2] * A[2]);
      let cnt = 0, below = 0; for (const i of idx) { const s = n[0] * P[i * 3] + n[1] * P[i * 3 + 1] + n[2] * P[i * 3 + 2] + d; if (Math.abs(s) < tol) cnt++; else if (s < 0) below++; }
      if (below > idx.length * 0.15) continue; // the table should be under most of the scene
      if (cnt > bestN) { bestN = cnt; best = { n, d }; }
    }
    return best && bestN > idx.length * 0.12 ? best : null;
  }
  function rotToUp(n) {
    // rotation matrix taking plane normal n onto +Y (Rodrigues)
    const ax = [-n[2], 0, n[0]], s = Math.hypot(ax[0], ax[2]), c = n[1];
    if (s < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const k = [ax[0] / s, 0, ax[2] / s], t = 1 - c;
    return [t * k[0] * k[0] + c, -s * k[2], t * k[0] * k[2], s * k[2], c, -s * k[0], t * k[0] * k[2], s * k[0], t * k[2] * k[2] + c];
  }

  function rebuildAI() {
    ai = newCloud(); aiMesh = { pos: [], col: [], idx: [] };
    const obj = isObj(), R = S3.objSize / 2;
    const h0 = captures.length && captures[0].heading != null ? captures[0].heading : 0;
    const pct = (arr, q) => { if (!arr.length) return 0; const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    // pass 1: camera-space points, table levelling, per-capture object stats
    const prepped = captures.map((cp) => {
      const N = cp.gw * cp.gh, D = cp.D;
      const P = new Float32Array(N * 3), valid = new Uint8Array(N), isTable = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (cp.edge[i]) continue;
        const dep = Math.min(D * 4, D * cp.rel[i]);
        let x = cp.nx[i] * dep, y = cp.ny[i] * dep, z = -dep;
        if (obj) { z += D; if (Math.abs(x) > R * 1.3 || y > R * 1.6 || y < -R * 2 || z < -R * 1.5 || z > R * 1.6) continue; }
        P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; valid[i] = 1;
      }
      let stats = null;
      if (obj) {
        const plane = tablePlane(P, valid), Rm = plane ? rotToUp(plane.n) : null;
        const ox = [], oz = [];
        for (let i = 0; i < N; i++) {
          if (!valid[i]) continue;
          let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          if (plane) {
            const s = plane.n[0] * x + plane.n[1] * y + plane.n[2] * z + plane.d;
            if (s < -S3.objSize * 0.05) { valid[i] = 0; continue; }
            if (s < S3.objSize * 0.035 + 0.004) isTable[i] = 1;
            const X = Rm[0] * x + Rm[1] * y + Rm[2] * z, Y = Rm[3] * x + Rm[4] * y + Rm[5] * z, Z = Rm[6] * x + Rm[7] * y + Rm[8] * z;
            P[i * 3] = X; P[i * 3 + 1] = Y; P[i * 3 + 2] = Z; x = X; z = Z;
          }
          if (!isTable[i]) { ox.push(x); oz.push(z); }
        }
        if (ox.length > 30) {
          const x0 = pct(ox, 0.05), x1 = pct(ox, 0.95), xc = (x0 + x1) / 2, hw = (x1 - x0) / 2;
          const front = []; for (let j = 0; j < ox.length; j++) if (Math.abs(ox[j] - xc) < hw * 0.3) front.push(oz[j]);
          stats = { xc, hw, zf: pct(front.length ? front : oz, 0.9) };
        }
      }
      return { cp, P, valid, isTable, stats };
    });
    // the turntable axis is fixed relative to the camera: take the median over all photos
    let ax = 0, az = 0;
    if (obj) {
      const st = prepped.map((p) => p.stats).filter(Boolean);
      if (st.length) { const xc = pct(st.map((s) => s.xc), 0.5), hw = pct(st.map((s) => s.hw), 0.5), zf = pct(st.map((s) => s.zf), 0.5); ax = xc; az = zf - hw; }
    }
    // pass 2: place every photo around the axis and triangulate
    prepped.forEach(({ cp, P, valid, isTable }, k) => {
      let th;
      if (obj) th = S3.objRot === 'compass' && cp.heading != null ? cp.heading - h0 : -k * S3.objStep * (S3.flip ? -1 : 1); // object turned clockwise seen from above
      else th = cp.heading != null ? cp.heading - h0 : k * 30;
      const t = (th * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
      const N = cp.gw * cp.gh, D = cp.D, vIndex = new Int32Array(N).fill(-1);
      for (let i = 0; i < N; i++) {
        if (!valid[i] || (S3.removeTable && isTable[i])) continue;
        const x = P[i * 3] - ax, y = P[i * 3 + 1], z = P[i * 3 + 2] - az;
        const wx = x * cs - z * sn, wz = x * sn + z * cs;
        const r = cp.col[i * 3], g = cp.col[i * 3 + 1], b = cp.col[i * 3 + 2];
        vIndex[i] = aiMesh.pos.length / 3; aiMesh.pos.push(wx, y, wz); aiMesh.col.push(r, g, b);
        addTo(ai, wx, y, wz, r, g, b, obj ? 0.003 : 0.02);
      }
      // triangulate neighbouring samples when they are on the same surface
      const jump = obj ? R * 0.12 : 0.15;
      for (let gy = 0; gy < cp.gh - 1; gy++) for (let gx = 0; gx < cp.gw - 1; gx++) {
        const a = gy * cp.gw + gx, b = a + 1, c = a + cp.gw, d = c + 1;
        if (vIndex[a] < 0 || vIndex[b] < 0 || vIndex[c] < 0 || vIndex[d] < 0) continue;
        const da = cp.rel[a] * D, db = cp.rel[b] * D, dc = cp.rel[c] * D, dd = cp.rel[d] * D;
        if (Math.max(da, db, dc, dd) - Math.min(da, db, dc, dd) > jump * Math.max(1, da / 2)) continue;
        aiMesh.idx.push(vIndex[a], vIndex[c], vIndex[b], vIndex[b], vIndex[c], vIndex[d]);
      }
    });
    refresh();
  }

  window.ES3D = { render: () => refresh(), count: () => VIEW.n, _captures: captures, _rebuild: rebuildAI, _view: () => VIEW, _mesh: () => aiMesh };
  refresh();
})();
