/*!
 * Genzineers Environment Scanner — 3D room scanning
 * © 2026 Genzineers (https://genzineers.com). All rights reserved.
 * Licensed under the Genzineers Source-Available License (GSAL) v1.0 — see LICENSE.
 */
'use strict';
(function () {
  const ES = window.ES; if (!ES) return;
  const { $, toast, status, consent, fitCanvas, registerCam, stopOtherCams, stopStream, startHeading, getHeading, errMsg, download } = ES;
  const MAX_POINTS = 600000;

  // ---------- point cloud store ----------
  const P = { pos: [], col: [], voxels: new Set() };
  function addPoint(x, y, z, r, g, b, voxel) {
    if (P.pos.length / 3 >= MAX_POINTS) return false;
    if (voxel) {
      const k = Math.round(x / voxel) + ',' + Math.round(y / voxel) + ',' + Math.round(z / voxel);
      if (P.voxels.has(k)) return false; P.voxels.add(k);
    }
    P.pos.push(x, y, z); P.col.push(r, g, b); return true;
  }
  function clearPoints() { P.pos = []; P.col = []; P.voxels = new Set(); updateCount(); render(); }
  function count() { return P.pos.length / 3; }
  function updateCount() { $('s3d-count').textContent = count().toLocaleString() + ' points'; }
  function heightColor(y, y0, y1) {
    const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0 || 1)));
    return [Math.round(40 + 215 * t), Math.round(200 - 80 * Math.abs(t - 0.5) * 2), Math.round(255 - 200 * t)];
  }

  // ---------- viewer ----------
  const V = { yaw: 0.6, pitch: 0.5, dist: 5, target: [0, 0, 0], auto: true };
  function fitView() {
    const n = count(); if (!n) { V.target = [0, 0, 0]; V.dist = 5; return; }
    let sx = 0, sy = 0, sz = 0; const step = Math.max(1, Math.floor(n / 5000));
    let m = 0; for (let i = 0; i < n; i += step) { sx += P.pos[i * 3]; sy += P.pos[i * 3 + 1]; sz += P.pos[i * 3 + 2]; m++; }
    V.target = [sx / m, sy / m, sz / m];
    let r = 0; for (let i = 0; i < n; i += step) { r = Math.max(r, Math.hypot(P.pos[i * 3] - V.target[0], P.pos[i * 3 + 1] - V.target[1], P.pos[i * 3 + 2] - V.target[2])); }
    V.dist = Math.max(1, r * 2.2);
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
    let r = [f[2], 0, -f[0]]; const rl = Math.hypot(...r) || 1; r = [-r[0] / rl, 0, -r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const foc = h * 0.9, ps = Math.max(1, Math.round(dpr * 1.6)), n = count(), pos = P.pos, col = P.col;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3] - eye[0], y = pos[i * 3 + 1] - eye[1], z = pos[i * 3 + 2] - eye[2];
      const zc = x * f[0] + y * f[1] + z * f[2]; if (zc < 0.05) continue;
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
  // orbit controls
  const ptrs = new Map(); let pinch0 = 0, dist0 = 0;
  const view = $('s3d-view');
  view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = V.dist; } });
  view.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) { V.yaw -= (e.clientX - prev[0]) * 0.008; V.pitch = Math.max(-1.55, Math.min(1.55, V.pitch + (e.clientY - prev[1]) * 0.008)); }
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const p = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0) V.dist = Math.max(0.3, dist0 * (pinch0 / p)); }
    render();
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); V.dist = Math.max(0.3, V.dist * Math.exp(e.deltaY * 0.001)); render(); }, { passive: false });
  $('s3d-top').addEventListener('click', () => { V.pitch = 1.55; render(); });
  $('s3d-reset').addEventListener('click', () => { V.yaw = 0.6; V.pitch = 0.5; fitView(); render(); });
  $('s3d-clear').addEventListener('click', () => { if (count() && !confirm('Delete all 3D points?')) return; clearPoints(); });
  window.addEventListener('resize', render);

  // ---------- export / import ----------
  $('s3d-export').addEventListener('click', () => {
    const n = count(); if (!n) return toast('Nothing to export yet.');
    const header = `ply\nformat binary_little_endian 1.0\ncomment Genzineers Environment Scanner\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
    const hb = new TextEncoder().encode(header), buf = new ArrayBuffer(hb.length + n * 15), dv = new DataView(buf);
    new Uint8Array(buf).set(hb);
    for (let i = 0, o = hb.length; i < n; i++, o += 15) {
      dv.setFloat32(o, P.pos[i * 3], true); dv.setFloat32(o + 4, P.pos[i * 3 + 1], true); dv.setFloat32(o + 8, P.pos[i * 3 + 2], true);
      dv.setUint8(o + 12, P.col[i * 3]); dv.setUint8(o + 13, P.col[i * 3 + 1]); dv.setUint8(o + 14, P.col[i * 3 + 2]);
    }
    download(`room-3d-${Date.now()}.ply`, new Blob([buf], { type: 'application/octet-stream' }));
  });
  $('imp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    status('s3d-status', 'Reading ' + file.name + '…');
    try {
      const buf = await file.arrayBuffer();
      const pts = /\.ply$/i.test(file.name) ? parsePLY(buf) : parseText(new TextDecoder().decode(buf), /\.obj$/i.test(file.name));
      if (!pts.n) throw new Error('No points found in file');
      const step = Math.max(1, Math.ceil(pts.n / (MAX_POINTS - count())));
      let y0 = Infinity, y1 = -Infinity; for (let i = 0; i < pts.n; i += step) { y0 = Math.min(y0, pts.p[i * 3 + 1]); y1 = Math.max(y1, pts.p[i * 3 + 1]); }
      for (let i = 0; i < pts.n; i += step) {
        const c = pts.c ? [pts.c[i * 3], pts.c[i * 3 + 1], pts.c[i * 3 + 2]] : heightColor(pts.p[i * 3 + 1], y0, y1);
        addPoint(pts.p[i * 3], pts.p[i * 3 + 1], pts.p[i * 3 + 2], c[0], c[1], c[2]);
      }
      updateCount(); fitView(); render();
      status('s3d-status', `Imported ${Math.ceil(pts.n / step).toLocaleString()} points from ${file.name}${step > 1 ? ' (thinned for speed)' : ''}.`);
    } catch (err) { status('s3d-status', 'Import failed: ' + errMsg(err), true); }
  });
  function parseText(txt, isObj) {
    const p = [], c = []; let hasC = true;
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim().split(/[\s,;]+/);
      if (isObj) { if (t[0] !== 'v') continue; t.shift(); }
      if (t.length < 3 || isNaN(+t[0])) continue;
      p.push(+t[0], +t[1], +t[2]);
      if (t.length >= 6) { const s = +t[3] <= 1 && +t[4] <= 1 && +t[5] <= 1 ? 255 : 1; c.push(+t[3] * s, +t[4] * s, +t[5] * s); } else hasC = false;
    }
    return { n: p.length / 3, p, c: hasC && c.length === p.length ? c : null };
  }
  function parsePLY(buf) {
    const bytes = new Uint8Array(buf); let end = -1;
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const hi = head.indexOf('end_header'); if (hi < 0) throw new Error('Not a PLY file');
    end = new TextEncoder().encode(head.slice(0, hi + 'end_header'.length)).length; while (bytes[end] === 10 || bytes[end] === 13) end++;
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
    overlay.innerHTML = '<div style="position:absolute;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top));background:#000a;padding:10px 14px;border-radius:12px" id="ar-info">Move the phone slowly around the room…</div><div style="position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px;border:2px solid #2ee6a6;border-radius:50%"></div><button id="ar-stop" style="pointer-events:auto;position:absolute;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#2ee6a6;color:#062218;border:0;border-radius:99px;padding:14px 28px;font:600 16px system-ui">Finish scan</button>';
    document.body.appendChild(overlay);
    return overlay;
  }
  $('ar-start').addEventListener('click', async () => {
    if (!window.ES_HAS.xrAR) {
      return status('s3d-status', ES.isIOS ? 'iPhone/iPad browsers don\'t offer AR depth to websites. Use "AI depth from camera" here, or scan with a LiDAR app (3D Scanner App, Polycam, Scaniverse) and import the .ply/.obj.' : 'AR isn\'t available in this browser. On Android, use Chrome with Google Play Services for AR installed. Otherwise use AI depth or import a scan.', true);
    }
    if (!(await consent('ar'))) return;
    stopOtherCams('ar');
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
    const useDepth = session.enabledFeatures ? session.enabledFeatures.includes('depth-sensing') : true;
    const hitSources = [];
    if (session.requestHitTestSource && (!useDepth || !session.enabledFeatures)) {
      for (let gy = -2; gy <= 2; gy++) for (let gx = -3; gx <= 3; gx++) {
        try { hitSources.push(await session.requestHitTestSource({ space: viewerSpace, offsetRay: new XRRay({ x: 0, y: 0, z: 0 }, { x: gx * 0.12, y: gy * 0.12, z: -1 }) })); } catch (e) { break; }
      }
    }
    let frameNo = 0, depthWorked = false, y0 = -1.6, y1 = 1.2;
    const info = $('ar-info');
    $('ar-stop').onclick = () => session.end();
    session.addEventListener('end', () => {
      ov.style.display = 'none'; hitSources.forEach((h) => h.cancel && h.cancel());
      updateCount(); fitView(); render();
      status('s3d-status', `AR scan finished: ${count().toLocaleString()} points${depthWorked ? ' from the depth sensor' : ' from surface hits'}. Drag to orbit.`);
    });
    const onFrame = (t, frame) => {
      session.requestAnimationFrame(onFrame);
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const pose = frame.getViewerPose(ref); if (!pose) return;
      frameNo++;
      if (frameNo % 8 !== 0) return;
      let added = 0;
      for (const v of pose.views) {
        let di = null;
        if (useDepth && frame.getDepthInformation) { try { di = frame.getDepthInformation(v); } catch (e) { di = null; } }
        if (di) {
          depthWorked = true;
          const P0 = v.projectionMatrix, M = v.transform.matrix;
          for (let gy = 0; gy < 30; gy++) for (let gx = 0; gx < 40; gx++) {
            const u = (gx + 0.5) / 40, w = (gy + 0.5) / 30;
            let z; try { z = di.getDepthInMeters(u, w); } catch (e) { z = 0; }
            if (!z || z < 0.15 || z > 6) continue;
            const nx = u * 2 - 1, ny = 1 - w * 2;
            const x = (z * (nx + P0[8])) / P0[0], y = (z * (ny + P0[9])) / P0[5], zz = -z;
            const wx = M[0] * x + M[4] * y + M[8] * zz + M[12], wy = M[1] * x + M[5] * y + M[9] * zz + M[13], wz = M[2] * x + M[6] * y + M[10] * zz + M[14];
            const c = heightColor(wy, y0, y1);
            if (addPoint(wx, wy, wz, c[0], c[1], c[2], 0.03)) added++;
          }
        }
      }
      for (const hs of hitSources) {
        const res = frame.getHitTestResults(hs);
        if (res.length) { const p = res[0].getPose(ref).transform.position; const c = heightColor(p.y, y0, y1); if (addPoint(p.x, p.y, p.z, c[0], c[1], c[2], 0.04)) added++; }
      }
      if (frameNo % 24 === 0) info.textContent = `${count().toLocaleString()} points · ${depthWorked ? 'depth sensor' : hitSources.length ? 'surface hits (no depth on this phone)' : 'waiting for tracking…'} · walk slowly, cover walls, floor and furniture`;
    };
    session.requestAnimationFrame(onFrame);
  });

  // ---------- AI monocular depth ----------
  const AI = { stream: null, pipe: null, loading: null, captures: 0, firstHeading: null };
  const aiStop = () => { stopStream(AI.stream); AI.stream = null; $('ai-wrap').classList.add('hidden'); $('ai-capture').disabled = true; $('ai-stop').disabled = true; };
  registerCam('ai3d', aiStop);
  $('ai-scale').addEventListener('input', (e) => { $('ai-scale-val').textContent = (+e.target.value).toFixed(1) + ' m'; });
  $('ai-start').addEventListener('click', async () => {
    if (!(await consent('camera'))) return;
    stopOtherCams('ai3d'); aiStop();
    try { AI.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } } }); } catch (e) { return status('s3d-status', 'Camera error: ' + errMsg(e), true); }
    const v = $('ai-video'); v.srcObject = AI.stream; await v.play().catch(() => {});
    $('ai-wrap').classList.remove('hidden'); $('ai-capture').disabled = false; $('ai-stop').disabled = false;
    const live = await startHeading();
    status('s3d-status', (live ? 'Compass on. ' : 'No compass: each capture assumes you turned 30° to the right. ') + 'Stand still, point at a part of the room and tap Capture view. Loading the AI model in the background…');
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
      status('s3d-status', 'AI depth model ready. Tap Capture view.');
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
      let yaw;
      if (window.ES.S.headingLive) { const hd = getHeading(); if (AI.firstHeading == null) AI.firstHeading = hd; yaw = hd - AI.firstHeading; }
      else yaw = AI.captures * 30;
      status('s3d-status', 'Estimating depth…');
      const pipe = await loadModel();
      const out = await pipe(cv.toDataURL('image/jpeg', 0.9));
      const t = out.predicted_depth; const dh = t.dims[t.dims.length - 2], dw = t.dims[t.dims.length - 1], disp = t.data;
      // depth-anything returns relative inverse depth: bigger = closer
      const cIdx = Math.floor(dh / 2) * dw + Math.floor(dw / 2);
      let ctr = 0, cn = 0; for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) { ctr += disp[cIdx + yy * dw + xx]; cn++; } ctr /= cn;
      let mn = Infinity; for (let i = 0; i < disp.length; i++) mn = Math.min(mn, disp[i]);
      const scale = +$('ai-scale').value, fov = (66 * Math.PI) / 180, fx = dw / 2 / Math.tan(fov / 2);
      const th = (yaw * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
      const step = Math.max(1, Math.round(dw / 160)); let added = 0;
      const off = Math.max(1e-3, mn * 0.98);
      for (let y = step; y < dh - step; y += step) for (let x = step; x < dw - step; x += step) {
        const i = y * dw + x, dsp = disp[i] - off + 1e-3;
        // reject flying pixels at depth edges
        const g = Math.abs(disp[i + step] - disp[i - step]) + Math.abs(disp[i + step * dw] - disp[i - step * dw]);
        if (g > (disp[i] || 1) * 0.25) continue;
        const depth = Math.min(scale * 4, scale * ((ctr - off + 1e-3) / dsp));
        const lx = ((x - dw / 2) / fx) * depth, ly = (-(y - dh / 2) / fx) * depth;
        const wx = lx * cs + depth * sn, wz = lx * sn - depth * cs;
        const px = Math.min(W - 1, Math.round((x / dw) * W)), py = Math.min(H - 1, Math.round((y / dh) * H)), o = (py * W + px) * 4;
        if (addPoint(wx, ly, wz, rgb[o], rgb[o + 1], rgb[o + 2], 0.02)) added++;
      }
      AI.captures++; updateCount(); if (AI.captures === 1) fitView(); render();
      status('s3d-status', `View ${AI.captures} added (${added.toLocaleString()} points at ${Math.round(yaw)}°). Turn about 30° and capture again to wrap around the room.`);
    } catch (e) { status('s3d-status', 'Depth failed: ' + errMsg(e), true); }
    finally { $('ai-capture').disabled = !AI.stream; }
  });

  window.ES3D = { render: () => { updateCount(); render(); }, count };
  updateCount();
})();
