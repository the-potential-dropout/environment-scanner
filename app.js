/*!
 * Genzineers Environment Scanner
 * © 2026 Genzineers (https://genzineers.com). All rights reserved.
 * Licensed under the Genzineers Source-Available License (GSAL) v1.0 — see LICENSE.
 * Free for non-commercial use. Commercial use requires a licence: genzineers@gmail.com
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('es-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('es-' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem('es-' + k); } catch (e) { /* ignore */ } },
  };

  const S = {
    map: store.get('map', { sonar: [], devices: [], notes: [] }),
    heading: null, headingLive: false, manualHeading: 0,
    bt: new Map(), addon: {}, nfc: [],
  };
  const saveMap = () => { store.set('map', S.map); drawMap(); };

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function status(id, msg, err) { const el = $(id); if (!el) return; el.textContent = msg || ''; el.classList.toggle('err', !!err); }
  function fitCanvas(c, maxDpr = 2) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { ctx: c.getContext('2d'), w, h, dpr };
  }
  function errMsg(e) { return (e && (e.message || e.name)) || String(e); }

  class LineChart {
    constructor(canvas, opt = {}) { this.c = canvas; this.n = opt.n || 240; this.data = []; this.opt = opt; }
    push(v) { this.data.push(v); if (this.data.length > this.n) this.data.shift(); this.draw(); }
    clear() { this.data = []; this.draw(); }
    draw() {
      const { ctx, w, h, dpr } = fitCanvas(this.c);
      ctx.clearRect(0, 0, w, h);
      if (!this.data.length) return;
      let min = this.opt.min, max = this.opt.max;
      if (min == null) min = Math.min(...this.data);
      if (max == null) max = Math.max(...this.data);
      if (max - min < 1e-6) { max += 1; min -= 1; }
      ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { const y = (h * i) / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.fillStyle = css('--muted'); ctx.font = `${11 * dpr}px system-ui`;
      ctx.fillText(max.toFixed(this.opt.dp ?? 1) + (this.opt.unit || ''), 6 * dpr, 13 * dpr);
      ctx.fillText(min.toFixed(this.opt.dp ?? 1) + (this.opt.unit || ''), 6 * dpr, h - 5 * dpr);
      ctx.strokeStyle = this.opt.color || css('--accent'); ctx.lineWidth = 2 * dpr; ctx.beginPath();
      this.data.forEach((v, i) => {
        const x = (i / (this.n - 1)) * w, y = h - ((v - min) / (max - min)) * (h - 8 * dpr) - 4 * dpr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  }

  let actx;
  function audioCtx() {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; actx = new AC(); }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  }

  // camera ownership so two modes don't fight over the camera
  const camStops = {};
  function registerCam(name, stopFn) { camStops[name] = stopFn; }
  function stopOtherCams(name) { Object.keys(camStops).forEach((k) => { if (k !== name) { try { camStops[k](); } catch (e) { /* ignore */ } } }); }
  function stopStream(s) { if (s) s.getTracks().forEach((t) => t.stop()); }

  // ---------- Consent ----------
  const PERMS = {
    bluetooth: { ico: 'ᛒ', title: 'Bluetooth', body: 'Scan for Bluetooth devices nearby and read their signal strength.', uses: ['Find phones, earbuds, trackers and smart cameras', 'Estimate how far away each one is', 'Connect to Bluetooth sensors you choose'] },
    camera: { ico: '◉', title: 'Camera & flashlight', body: 'Use the camera image (and flashlight where available) on this device only.', uses: ['Spot reflections from hidden camera lenses', 'See infrared LEDs', 'Measure light, flicker and depth for 3D scans', 'Use a USB thermal camera'] },
    microphone: { ico: '∿', title: 'Microphone & speaker', body: 'Play short chirps or tones and listen to the microphone. Nothing is recorded or saved.', uses: ['Sonar distance to walls', 'Ultrasonic noise spectrogram', 'Presence detection'] },
    motion: { ico: '⟳', title: 'Motion, compass & magnetometer', body: 'Read the accelerometer, gyroscope, compass and magnetic field sensor.', uses: ['Direction you are facing for the room map and 3D stitching', 'Magnetic field / EMF detection', 'Level, tilt and vibration'] },
    location: { ico: '⌖', title: 'Location (GPS)', body: 'Read your position, altitude and speed. It is shown only on this screen and never sent anywhere.', uses: ['Position, altitude, speed', 'GPS accuracy'] },
    ar: { ico: '⬢', title: 'Augmented reality depth', body: 'Start an AR session that uses the camera and depth sensor to measure the room in 3D.', uses: ['Real-scale 3D point cloud of the room'] },
    nfc: { ico: '⊙', title: 'NFC', body: 'Read NFC tags held near the back of the phone.', uses: ['Find hidden NFC tags', 'Show what they contain'] },
    serial: { ico: '⊕', title: 'USB / serial devices', body: 'Connect to a USB sensor board you pick from a list.', uses: ['Read external sensors like air quality, radar, thermal arrays'] },
  };
  function consent(key) {
    const p = PERMS[key];
    if (store.get('consent-' + key) === 'yes') return Promise.resolve(true);
    return new Promise((resolve) => {
      $('consent-ico').textContent = p.ico;
      $('consent-title').textContent = `Allow ${p.title}?`;
      $('consent-body').textContent = p.body;
      $('consent-uses').innerHTML = p.uses.map((u) => `<li>${u}</li>`).join('');
      $('consent').classList.remove('hidden');
      $('consent-yes').focus();
      const done = (ok) => {
        $('consent').classList.add('hidden');
        $('consent-yes').onclick = $('consent-no').onclick = null;
        if ($('consent-remember').checked) store.set('consent-' + key, ok ? 'yes' : 'no');
        renderPerms();
        if (!ok) toast(`${p.title} not allowed. You can allow it later in Overview → Permissions.`);
        resolve(ok);
      };
      $('consent-yes').onclick = () => done(true);
      $('consent-no').onclick = () => done(false);
    });
  }
  async function browserPermState(name) {
    try { const r = await navigator.permissions.query({ name }); return r.state; } catch (e) { return null; }
  }
  async function renderPerms() {
    const map = { camera: 'camera', microphone: 'microphone', location: 'geolocation', motion: 'accelerometer', nfc: 'nfc' };
    const rows = await Promise.all(Object.keys(PERMS).map(async (k) => {
      const app = store.get('consent-' + k);
      const br = map[k] ? await browserPermState(map[k]) : null;
      const label = app === 'yes' ? 'Allowed' : app === 'no' ? 'Declined' : 'Not asked yet';
      const cls = app === 'yes' ? 'ok' : app === 'no' ? 'no' : 'part';
      return `<div class="item"><div class="t">${PERMS[k].ico} ${PERMS[k].title}</div>
        <div class="s">${PERMS[k].body}${br ? ` · Browser: ${br}` : ''}</div>
        <div class="r"><span class="pill ${cls}">${label}</span><br>
        ${app === 'yes' ? `<button class="btn small ghost" data-revoke="${k}">Revoke</button>` : `<button class="btn small" data-grant="${k}">Allow</button>`}</div></div>`;
    }));
    $('perm-list').innerHTML = rows.join('');
  }
  $('perm-list').addEventListener('click', async (e) => {
    const g = e.target.dataset.grant, r = e.target.dataset.revoke;
    if (r) { store.del('consent-' + r); renderPerms(); toast('Revoked in the app. To fully reset, also clear this site\'s permissions in your browser settings.', 4000); }
    if (g) {
      store.del('consent-' + g);
      if (!(await consent(g))) return;
      try {
        if (g === 'camera') stopStream(await navigator.mediaDevices.getUserMedia({ video: true }));
        if (g === 'microphone') stopStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
        if (g === 'location') navigator.geolocation.getCurrentPosition(() => renderPerms(), () => renderPerms());
        if (g === 'motion') await requestMotionPermission();
      } catch (err) { toast('Browser said: ' + errMsg(err)); }
      renderPerms();
    }
  });

  // iOS 13+ needs an explicit permission for motion/orientation
  async function requestMotionPermission() {
    const asks = [];
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') asks.push(DeviceMotionEvent.requestPermission());
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') asks.push(DeviceOrientationEvent.requestPermission());
    const res = await Promise.all(asks);
    if (res.some((r) => r !== 'granted')) throw new Error('Motion permission denied');
  }

  // ---------- Compass heading ----------
  let headingStarted = false;
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    // compensate for screen rotation
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    S.heading = (h + so + 360) % 360; S.headingLive = true;
    const hv = $('sonar-heading'); if (hv) { hv.value = Math.round(S.heading); $('sonar-heading-val').textContent = Math.round(S.heading) + '°'; }
  }
  async function startHeading() {
    if (headingStarted) return S.headingLive;
    if (!(await consent('motion'))) return false;
    try { await requestMotionPermission(); } catch (e) { return false; }
    headingStarted = true;
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
    else window.addEventListener('deviceorientation', onOrient);
    await new Promise((r) => setTimeout(r, 600));
    return S.headingLive;
  }
  function getHeading() { return S.headingLive && S.heading != null ? S.heading : S.manualHeading; }
  $('sonar-heading').addEventListener('input', (e) => { S.manualHeading = +e.target.value; $('sonar-heading-val').textContent = e.target.value + '°'; });

  // ---------- Tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'map') drawMap();
    if (name === 'sonar') drawPolar();
    if (name === 'scan3d' && window.ES3D) window.ES3D.render();
    window.scrollTo(0, 0);
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

  // ---------- Capabilities + sensor matrix ----------
  const has = {
    bt: 'bluetooth' in navigator,
    btScan: !!(navigator.bluetooth && navigator.bluetooth.requestLEScan),
    cam: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    mag: 'Magnetometer' in window,
    als: 'AmbientLightSensor' in window,
    motion: 'DeviceMotionEvent' in window,
    orient: 'DeviceOrientationEvent' in window,
    geo: 'geolocation' in navigator,
    nfc: 'NDEFReader' in window,
    serial: 'serial' in navigator,
    xr: !!navigator.xr,
    xrAR: false,
    conn: !!(navigator.connection || navigator.mozConnection || navigator.webkitConnection),
    touch: navigator.maxTouchPoints > 0,
    gpu: 'gpu' in navigator,
  };
  window.ES_HAS = has;

  function cap(tab, name, state, text) { return { tab, name, state, text }; }
  function renderCaps() {
    const btText = !has.bt ? (isIOS ? 'Apple blocks Web Bluetooth on iOS. Open this page in the Bluefy browser app.' : 'Not in this browser. Use Chrome, Edge or Samsung Internet.')
      : has.btScan ? 'Full room scanning available.' : 'Pick-one-device mode. Enable experimental features for full scans.';
    const caps = [
      cap('scan3d', '3D room scan', has.xrAR ? 'ok' : has.cam ? 'part' : 'no', has.xrAR ? 'AR depth scanning available (real metres).' : has.cam ? 'AI depth from camera + LiDAR file import.' : 'Needs a camera.'),
      cap('bluetooth', 'Bluetooth devices', has.bt ? (has.btScan ? 'ok' : 'part') : 'no', btText),
      cap('lens', 'Hidden camera lens finder', has.cam ? 'ok' : 'no', has.cam ? 'Camera available. Flashlight is checked when you start.' : 'No camera access in this browser.'),
      cap('magnet', 'Magnetic / EMF', has.mag ? 'ok' : 'no', has.mag ? 'Magnetometer available.' : isIOS ? 'iOS does not let websites read the magnetometer.' : 'Android Chrome: enable chrome://flags/#enable-generic-sensor-extra-classes'),
      cap('sonar', 'Sonar room shape', has.cam ? 'ok' : 'no', 'Speaker + microphone echo ranging.'),
      cap('audio', 'Ultrasonic & presence', has.cam ? 'ok' : 'no', 'Spectrogram, sound level and Doppler motion detector.'),
      cap('light', 'Light, colour & flicker', has.als ? 'ok' : has.cam ? 'part' : 'no', has.als ? 'Ambient light sensor available.' : 'Estimated with the camera.'),
      cap('thermal', 'Thermal view', has.cam ? 'part' : 'no', 'Needs a USB thermal camera (UVC).'),
      cap('network', 'Network signal', has.conn ? 'ok' : 'part', has.conn ? 'Connection type, speed and latency.' : 'Latency only in this browser.'),
      cap('sensors', 'Motion, level & GPS', has.motion ? 'ok' : has.geo ? 'part' : 'no', has.touch ? 'Accelerometer, gyroscope, compass, GPS.' : 'Laptops usually have no motion sensors; GPS uses Wi-Fi location.'),
      cap('addons', 'NFC & add-on sensors', has.nfc || has.serial || has.bt ? 'part' : 'no', [has.nfc && 'NFC', has.bt && 'Bluetooth sensors', has.serial && 'USB sensors'].filter(Boolean).join(' · ') || 'Not available in this browser.'),
    ];
    const lab = { ok: 'Ready', part: 'Partial', no: 'Unavailable' };
    $('caps').innerHTML = caps.map((c) => `<button class="cap" data-go="${c.tab}"><div class="top"><span class="name">${c.name}</span><span class="pill ${c.state}">${lab[c.state]}</span></div><p>${c.text}</p></button>`).join('');
    renderMatrix();
  }
  $('caps').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) showTab(b.dataset.go); });

  function renderMatrix() {
    const L = 'live', A = 'addon', B = 'blocked';
    const rows = [
      ['Depth & proximity', 'LiDAR / Time-of-Flight', has.xrAR ? L : A, 'scan3d', has.xrAR ? 'Used through AR depth sensing for real-scale 3D scans.' : 'Android: AR depth in Chrome on ARCore phones. iPhone LiDAR is closed to websites: scan in a LiDAR app and import the .ply/.obj.'],
      ['Depth & proximity', 'Proximity sensor', B, null, 'Browsers removed the proximity API. Sonar gives a similar near-object reading.'],
      ['Depth & proximity', 'Soli radar (Pixel 4)', B, null, 'No web access. Alternative: plug in a mmWave radar module (e.g. LD2410) via USB.'],
      ['Depth & proximity', 'Ultra-Wideband (UWB)', B, null, 'No web API on any phone. Use Apple Find My / Samsung SmartThings Find for UWB tags.'],
      ['Visual, light & thermal', 'Camera (CMOS)', has.cam ? L : B, 'lens', 'Lens glint detection, IR LEDs, AI depth, light and flicker analysis.'],
      ['Visual, light & thermal', 'Ambient light & colour temp', has.als ? L : has.cam ? L : B, 'light', has.als ? 'Light sensor in lux, colour temperature from the camera.' : 'Estimated with the camera (relative brightness, kelvin, flicker).'],
      ['Visual, light & thermal', 'Flicker / spectral sensor', has.cam ? L : B, 'light', 'The dedicated chip is closed, so flicker is detected from camera rolling-shutter banding.'],
      ['Visual, light & thermal', 'Thermal camera', A, 'thermal', 'Rugged-phone thermal sensors are closed to websites. USB (UVC) thermal cameras work in Thermal view.'],
      ['Visual, light & thermal', 'IR blaster', B, null, 'No web API. IR LEDs of hidden cameras can still be seen in IR mode.'],
      ['Acoustic & vibration', 'MEMS microphones', has.cam ? L : B, 'audio', 'Sound level, spectrogram up to the mic limit, ultrasonic tones.'],
      ['Acoustic & vibration', 'Ultrasonic transceiver', has.cam ? L : B, 'audio', 'Speaker + mic as sonar and as a 19 kHz Doppler presence detector.'],
      ['Atmosphere & air', 'Barometer', has.bt || has.serial ? A : B, 'addons', 'Phone barometers are closed to websites. Bluetooth/USB pressure sensors work.'],
      ['Atmosphere & air', 'Object thermometer (Pixel Pro)', has.bt || has.serial ? A : B, 'addons', 'Closed to websites. A Bluetooth/USB IR thermometer (e.g. MLX90614) works.'],
      ['Atmosphere & air', 'Hygrometer (humidity)', has.bt || has.serial ? A : B, 'addons', 'Bluetooth Environmental Sensing devices and USB boards work.'],
      ['Atmosphere & air', 'Air quality / VOC / PM2.5', has.bt || has.serial ? A : B, 'addons', 'Connect a USB/Bluetooth air-quality sensor (SGP30, SCD40, PMS5003…).'],
      ['Magnetic & motion', 'Magnetometer', has.mag ? L : B, 'magnet', has.mag ? 'Live EMF / metal detector.' : 'Compass heading still works; raw field needs Android Chrome with sensor flag.'],
      ['Magnetic & motion', 'Hall effect sensor', B, null, 'Closed to websites. The magnetometer detects the same magnets.'],
      ['Magnetic & motion', 'Accelerometer & gyroscope', has.motion ? L : B, 'sensors', 'Gravity, level, tilt and vibration seismograph.'],
      ['Radio & positioning', 'GNSS / GPS', has.geo ? L : B, 'sensors', 'Position, altitude, speed and accuracy.'],
      ['Radio & positioning', 'Bluetooth', has.bt ? L : B, 'bluetooth', has.bt ? 'Device discovery, proximity finder, tracker & camera flags.' : 'Not in this browser.'],
      ['Radio & positioning', 'Wi-Fi scan / Wi-Fi RTT', B, 'network', 'Websites cannot list networks. Connection speed and latency are used as a signal-strength proxy.'],
      ['Radio & positioning', 'Cellular / radio waves', B, 'network', 'No raw radio access. Connection type and quality only.'],
      ['Radio & positioning', 'NFC', has.nfc ? L : B, 'addons', has.nfc ? 'Read NFC tags.' : 'Android Chrome / Samsung Internet only.'],
    ];
    const lab = { live: ['ok', 'Live'], addon: ['part', 'Add-on'], blocked: ['no', 'Blocked'] };
    $('matrix').innerHTML = rows.map(([g, n, st, tab, t]) => `<div class="mx"><div class="grp">${g}</div><div class="top"><b>${n}</b><span class="pill ${lab[st][0]}">${lab[st][1]}</span></div><p>${t}</p>${tab ? `<a data-go="${tab}">Open →</a>` : ''}</div>`).join('');
  }
  $('matrix').addEventListener('click', (e) => { const a = e.target.closest('[data-go]'); if (a) showTab(a.dataset.go); });

  async function checkXR() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return;
    try { has.xrAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { has.xrAR = false; }
    renderCaps();
    window.dispatchEvent(new Event('es-xr'));
  }

  // ---------- Bluetooth ----------
  const COMPANIES = { 0x004c: 'Apple', 0x0006: 'Microsoft', 0x0075: 'Samsung', 0x00e0: 'Google', 0x0171: 'Amazon', 0x0087: 'Garmin', 0x009e: 'Bose', 0x012d: 'Sony', 0x038f: 'Xiaomi', 0x02e5: 'Espressif (IoT board)', 0x0059: 'Nordic (IoT board)', 0x000d: 'Texas Instruments', 0x0499: 'Ruuvi', 0x0157: 'Huami', 0x0310: 'SGL Italia', 0x01da: 'Logitech' };
  const CAM_RX = /cam|ipc|wyze|eufy|\byi[-_ ]|arlo|blink|ring|spy|hidden|dvr|nanny|v380|xiaovv|tuya|ezviz|imou|reolink|hikvision|dahua|wansview|tapo/i;
  let btScanHandle = null, btFinderId = null, btRenderT = 0;

  function rssiToDist(rssi, tx) {
    const ref = typeof tx === 'number' && tx > -30 && tx < 20 ? tx - 41 : -59;
    return Math.pow(10, (ref - rssi) / (10 * 2.2));
  }
  function classify(d) {
    const tags = [];
    let alert = false;
    if (d.company != null) tags.push(COMPANIES[d.company] || 'Company 0x' + d.company.toString(16).padStart(4, '0'));
    if (d.company === 0x004c && d.appleType === 0x12) { tags.push('Find My tracker (AirTag or Apple device)'); alert = true; }
    const uu = (d.uuids || []).join(' ').toLowerCase();
    if (uu.includes('0000feed') || uu.includes('0000feec')) { tags.push('Tile tracker'); alert = true; }
    if (uu.includes('0000fd5a')) { tags.push('Samsung SmartTag'); alert = true; }
    if (d.name && CAM_RX.test(d.name)) { tags.push('Possible camera'); alert = true; }
    if (d.company === 0x02e5 || d.company === 0x0059) tags.push('Common in smart cams/plugs');
    if (!d.name) tags.push('No name (hidden)');
    return { tags, alert };
  }
  function bars(rssi) { const n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -80 ? 2 : 1; return `<span class="sig">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}" style="height:${i * 4 + 2}px"></i>`).join('')}</span>`; }
  function fmtDist(m) { return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`; }

  function btUpdate(ev) {
    const id = ev.device.id;
    const prev = S.bt.get(id) || { id, first: Date.now() };
    const d = Object.assign(prev, { name: ev.device.name || ev.name || prev.name || '', last: Date.now(), tx: ev.txPower ?? prev.tx, uuids: ev.uuids || prev.uuids, device: ev.device });
    if (typeof ev.rssi === 'number') d.rssi = d.rssi == null ? ev.rssi : d.rssi * 0.7 + ev.rssi * 0.3;
    if (ev.manufacturerData && ev.manufacturerData.size) {
      for (const [cid, dv] of ev.manufacturerData) { d.company = cid; if (cid === 0x004c && dv.byteLength) d.appleType = dv.getUint8(0); break; }
    }
    S.bt.set(id, d);
    if (id === btFinderId) updateFinder(d);
    const now = performance.now(); if (now - btRenderT > 600) { btRenderT = now; renderBt(); }
  }
  function renderBt() {
    const list = [...S.bt.values()].sort((a, b) => (b.rssi ?? -200) - (a.rssi ?? -200));
    const alerts = list.filter((d) => classify(d).alert).length;
    status('bt-status', `${list.length} device${list.length === 1 ? '' : 's'} found${alerts ? ` · ${alerts} worth checking` : ''}. Tap a device to track it.`);
    $('bt-list').innerHTML = list.map((d) => {
      const c = classify(d), stale = Date.now() - d.last > 15000;
      return `<div class="item" data-bt="${d.id}" style="cursor:pointer;${stale ? 'opacity:.5' : ''}">
        <div class="t">${d.name ? escapeHtml(d.name) : 'Unnamed device'}</div>
        <div class="s">${c.tags.map((t) => `<span class="tag ${/tracker|camera|Find My|Tile|SmartTag/.test(t) ? 'alert' : ''}">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="r">${d.rssi != null ? `${bars(d.rssi)}<br><b>~${fmtDist(rssiToDist(d.rssi, d.tx))}</b><br><small>${Math.round(d.rssi)} dBm</small>` : '<small>connected</small>'}</div></div>`;
    }).join('');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  $('bt-list').addEventListener('click', (e) => {
    const it = e.target.closest('[data-bt]'); if (!it) return;
    btFinderId = it.dataset.bt; const d = S.bt.get(btFinderId);
    $('bt-finder').classList.remove('hidden'); $('bt-finder-name').textContent = d.name || 'Unnamed device';
    updateFinder(d); $('bt-finder').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  function updateFinder(d) {
    if (d.rssi == null) { $('bt-finder-dist').textContent = 'connected'; return; }
    const m = rssiToDist(d.rssi, d.tx);
    $('bt-finder-dist').textContent = '~' + fmtDist(m);
    const heat = clamp((d.rssi + 95) / 55, 0, 1);
    const dot = $('bt-finder-dot');
    dot.style.transform = `scale(${1 + heat * 3.2})`;
    dot.style.background = heat > 0.75 ? css('--bad') : heat > 0.45 ? css('--warn') : css('--accent');
    $('bt-finder-hint').textContent = heat > 0.8 ? 'Very close — check within arm\'s reach.' : heat > 0.55 ? 'Getting warm.' : 'Cold — keep moving. Signal drops through walls and bodies.';
  }
  $('bt-mark').addEventListener('click', async () => {
    const d = S.bt.get(btFinderId); if (!d) return;
    await startHeading();
    S.map.devices.push({ name: d.name || 'Bluetooth device', heading: getHeading(), dist: d.rssi != null ? rssiToDist(d.rssi, d.tx) : 1, alert: classify(d).alert, t: Date.now() });
    saveMap(); toast(`Marked at ${Math.round(getHeading())}° on the room map. Point at the strongest signal for best results.`);
  });

  $('bt-scan').addEventListener('click', async () => {
    if (!has.bt) return status('bt-status', isIOS ? 'iPhone/iPad: Apple blocks Bluetooth for websites. Install the free "Bluefy" browser and open this page there.' : 'This browser has no Web Bluetooth. Try Chrome, Edge or Samsung Internet.', true);
    if (!(await consent('bluetooth'))) return;
    if (!has.btScan) { status('bt-status', 'Full scanning is off in this browser, so pick devices one at a time (see the tip below).'); return pickDevice(); }
    try {
      btScanHandle = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
      navigator.bluetooth.addEventListener('advertisementreceived', btUpdate);
      $('bt-stop').disabled = false; status('bt-status', 'Scanning… walk slowly around the room.');
    } catch (e) { status('bt-status', 'Scan failed: ' + errMsg(e) + '. Falling back to pick-one mode.', true); pickDevice(); }
  });
  $('bt-pick').addEventListener('click', async () => {
    if (!has.bt) return $('bt-scan').click();
    if (!(await consent('bluetooth'))) return;
    pickDevice();
  });
  async function pickDevice() {
    try {
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['battery_service', 'device_information', 'environmental_sensing'] });
      const d = { id: dev.id, name: dev.name || '', last: Date.now(), device: dev };
      S.bt.set(dev.id, d); renderBt();
      if (dev.watchAdvertisements) {
        dev.addEventListener('advertisementreceived', btUpdate);
        try { await dev.watchAdvertisements(); status('bt-status', 'Tracking signal strength of ' + (dev.name || 'device') + '. Tap it to open the finder.'); }
        catch (e) { status('bt-status', 'Picked. Live signal strength needs experimental features enabled.'); }
      } else status('bt-status', 'Picked. This browser cannot report signal strength for picked devices.');
      try {
        const gatt = await dev.gatt.connect();
        const info = [];
        try { const s = await gatt.getPrimaryService('device_information'); for (const [u, l] of [['manufacturer_name_string', 'Maker'], ['model_number_string', 'Model']]) { try { const v = await (await s.getCharacteristic(u)).readValue(); info.push(l + ': ' + new TextDecoder().decode(v)); } catch (e) { /* missing */ } } } catch (e) { /* none */ }
        try { const b = await (await (await gatt.getPrimaryService('battery_service')).getCharacteristic('battery_level')).readValue(); info.push('Battery ' + b.getUint8(0) + '%'); } catch (e) { /* none */ }
        if (info.length) { d.name = (d.name || 'Device') + ' — ' + info.join(', '); renderBt(); }
        gatt.disconnect();
      } catch (e) { /* not connectable */ }
    } catch (e) { if (e.name !== 'NotFoundError') status('bt-status', errMsg(e), true); }
  }
  $('bt-stop').addEventListener('click', () => {
    if (btScanHandle) { btScanHandle.stop(); btScanHandle = null; }
    if (navigator.bluetooth) navigator.bluetooth.removeEventListener('advertisementreceived', btUpdate);
    $('bt-stop').disabled = true; status('bt-status', `Stopped. ${S.bt.size} devices found.`);
  });
  setInterval(() => { if (btScanHandle) renderBt(); }, 3000);

  // ---------- Lens finder ----------
  const lens = { stream: null, raf: 0, tracks: [], ir: false, work: document.createElement('canvas') };
  async function startLens(ir) {
    if (!has.cam) return status('lens-status', 'No camera access in this browser.', true);
    if (!(await consent('camera'))) return;
    stopOtherCams('lens'); stopLens();
    lens.ir = ir;
    try {
      lens.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: ir ? 'user' : { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) { return status('lens-status', 'Camera error: ' + errMsg(e), true); }
    const v = $('lens-video'); v.srcObject = lens.stream; await v.play().catch(() => {});
    v.style.visibility = 'hidden';
    let torch = false;
    if (!ir) {
      const track = lens.stream.getVideoTracks()[0];
      try { const c = track.getCapabilities ? track.getCapabilities() : {}; if (c.torch) { await track.applyConstraints({ advanced: [{ torch: true }] }); torch = true; } } catch (e) { /* no torch */ }
    }
    status('lens-status', ir ? 'IR mode: turn the lights off and point the screen around. Purple/white dots that pulse or stay lit may be IR LEDs.'
      : torch ? 'Flashlight on. Sweep slowly. Red circles = steady pin-point reflections worth checking. Tap one to save it to the room map.'
        : 'No flashlight control in this browser: hold a separate torch right next to the camera, or use another phone\'s light. Sweep slowly.');
    $('lens-stop').disabled = false;
    lens.tracks = [];
    lensLoop();
  }
  function stopLens() {
    cancelAnimationFrame(lens.raf); stopStream(lens.stream); lens.stream = null; $('lens-stop').disabled = true;
  }
  registerCam('lens', stopLens);
  function coverDraw(ctx, v, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return null;
    const s = Math.max(w / vw, h / vh), dw = vw * s, dh = vh * s;
    ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh); return true;
  }
  function lensLoop() {
    const v = $('lens-video'), c = $('lens-overlay');
    const { ctx, w, h, dpr } = fitCanvas(c, 1.5);
    if (coverDraw(ctx, v, w, h)) {
      const aw = 240, ah = Math.round((240 * h) / w);
      const wk = lens.work; wk.width = aw; wk.height = ah;
      const wctx = wk.getContext('2d', { willReadFrequently: true });
      wctx.drawImage(c, 0, 0, aw, ah);
      const px = wctx.getImageData(0, 0, aw, ah).data;
      const L = new Float32Array(aw * ah);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) L[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const sens = +$('lens-sens').value;
      const thr = 250 - sens * 9, contrast = 90 - sens * 6;
      const found = [];
      const R = 5;
      for (let y = R; y < ah - R; y += 1) {
        for (let x = R; x < aw - R; x += 1) {
          const l = L[y * aw + x]; if (l < thr) continue;
          // must be a local maximum
          if (l < L[y * aw + x - 1] || l < L[y * aw + x + 1] || l < L[(y - 1) * aw + x] || l <= L[(y + 1) * aw + x]) continue;
          // ring average around the point must be much darker (= tiny point source)
          let ring = 0, n = 0;
          for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ring += L[Math.round(y + Math.sin(a) * R) * aw + Math.round(x + Math.cos(a) * R)]; n++; }
          ring /= n;
          if (l - ring < contrast) continue;
          if (lens.ir) { const i = (y * aw + x) * 4; if (px[i + 2] < px[i + 1] * 0.9 && px[i] < 200) continue; }
          found.push({ x, y, s: l - ring });
          x += R;
        }
      }
      found.sort((a, b) => b.s - a.s); found.length = Math.min(found.length, 25);
      // persistence tracking
      const next = [];
      for (const f of found) {
        const m = lens.tracks.find((t) => Math.hypot(t.x - f.x, t.y - f.y) < 10);
        next.push({ x: f.x, y: f.y, age: m ? m.age + 1 : 1 });
      }
      lens.tracks = next;
      const sx = w / aw, sy = h / ah;
      let strong = 0;
      for (const t of lens.tracks) {
        const steady = t.age >= 6; if (steady) strong++;
        ctx.beginPath(); ctx.lineWidth = (steady ? 3 : 1.5) * dpr;
        ctx.strokeStyle = steady ? '#ff3b4e' : 'rgba(255,200,60,.7)';
        ctx.arc(t.x * sx, t.y * sy, (steady ? 18 : 10) * dpr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, w, 26 * dpr);
      ctx.fillStyle = '#fff'; ctx.font = `${13 * dpr}px system-ui`;
      ctx.fillText(strong ? `${strong} steady point${strong > 1 ? 's' : ''} — look closely` : 'Scanning… no steady points', 8 * dpr, 18 * dpr);
    }
    lens.raf = requestAnimationFrame(lensLoop);
  }
  $('lens-overlay').addEventListener('click', async () => {
    if (!lens.stream) return;
    if (!lens.tracks.some((t) => t.age >= 6)) return toast('No steady point under the scan right now.');
    await startHeading();
    S.map.notes.push({ text: lens.ir ? 'Possible IR LED' : 'Possible camera lens', heading: getHeading(), dist: 1.5, kind: 'lens', t: Date.now() });
    saveMap(); toast('Saved to room map at ' + Math.round(getHeading()) + '°.');
  });
  $('lens-start').addEventListener('click', () => startLens(false));
  $('lens-ir').addEventListener('click', () => startLens(true));
  $('lens-stop').addEventListener('click', () => { stopLens(); status('lens-status', 'Stopped.'); });

  // ---------- Magnetometer ----------
  const mag = { sensor: null, base: null, hist: [], chart: new LineChart($('mag-chart'), { unit: ' µT' }), osc: null, gain: null };
  $('mag-start').addEventListener('click', async () => {
    if (!has.mag) return status('mag-status', isIOS ? 'iPhone/iPad Safari does not let websites read the magnetometer. Use an Android phone with Chrome, or a native EMF app.' : 'Magnetometer is hidden in this browser. Android Chrome: open chrome://flags/#enable-generic-sensor-extra-classes → Enabled → restart.', true);
    if (!(await consent('motion'))) return;
    try {
      const st = await browserPermState('magnetometer'); if (st === 'denied') throw new Error('Permission denied in browser settings');
      mag.sensor = new Magnetometer({ frequency: 30 });
      mag.sensor.addEventListener('reading', onMag);
      mag.sensor.addEventListener('error', (e) => status('mag-status', 'Sensor error: ' + errMsg(e.error), true));
      mag.sensor.start();
      $('mag-cal').disabled = false; $('mag-stop').disabled = false;
      status('mag-status', 'Hold still away from electronics, then tap Calibrate. Then sweep slowly.');
      if ($('mag-sound').checked) startMagSound();
    } catch (e) { status('mag-status', errMsg(e), true); }
  });
  function onMag() {
    const s = mag.sensor; const m = Math.hypot(s.x, s.y, s.z);
    mag.hist.push(m); if (mag.hist.length > 30) mag.hist.shift();
    if (mag.base == null && mag.hist.length >= 30) mag.base = mag.hist.reduce((a, b) => a + b) / mag.hist.length;
    const delta = mag.base == null ? 0 : m - mag.base;
    $('mag-val').textContent = m.toFixed(1);
    $('mag-delta').textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1);
    $('mag-bar').style.width = clamp((Math.abs(delta) / 100) * 100, 0, 100) + '%';
    mag.chart.push(m);
    if (mag.osc) { const a = Math.abs(delta); mag.osc.frequency.setTargetAtTime(220 + a * 18, actx.currentTime, 0.05); mag.gain.gain.setTargetAtTime(a > 4 ? 0.08 : 0, actx.currentTime, 0.05); }
  }
  function startMagSound() {
    const ac = audioCtx(); mag.osc = ac.createOscillator(); mag.gain = ac.createGain(); mag.gain.gain.value = 0;
    mag.osc.type = 'square'; mag.osc.connect(mag.gain).connect(ac.destination); mag.osc.start();
  }
  function stopMagSound() { if (mag.osc) { mag.osc.stop(); mag.osc.disconnect(); mag.osc = null; } }
  $('mag-sound').addEventListener('change', (e) => { if (!mag.sensor) return; e.target.checked ? startMagSound() : stopMagSound(); });
  $('mag-cal').addEventListener('click', () => { if (mag.hist.length) { mag.base = mag.hist.reduce((a, b) => a + b) / mag.hist.length; toast('Calibrated. Earth\'s field is now zero.'); } });
  $('mag-stop').addEventListener('click', () => { if (mag.sensor) mag.sensor.stop(); mag.sensor = null; stopMagSound(); $('mag-cal').disabled = $('mag-stop').disabled = true; status('mag-status', 'Stopped.'); });

  // ---------- Sonar ----------
  const sonar = { stream: null, src: null, proc: null, rec: null, busy: false, auto: null, lastProfile: null };
  async function sonarInit() {
    if (sonar.stream) return true;
    if (!(await consent('microphone'))) return false;
    try { sonar.stream = await getMic(); } catch (e) { status('sonar-status', 'Microphone error: ' + errMsg(e), true); return false; }
    const ac = audioCtx();
    sonar.src = ac.createMediaStreamSource(sonar.stream);
    sonar.proc = ac.createScriptProcessor(2048, 1, 1);
    sonar.proc.onaudioprocess = (e) => { if (sonar.rec) sonar.rec.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    const mute = ac.createGain(); mute.gain.value = 0;
    sonar.src.connect(sonar.proc); sonar.proc.connect(mute).connect(ac.destination);
    startHeading();
    return true;
  }
  function makeChirp(sr) {
    const dur = 0.008, n = Math.round(sr * dur), f0 = 2500, f1 = Math.min(11000, sr / 2 - 1000), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr, w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); out[i] = w * Math.sin(2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * dur)) * t * t)); }
    return out;
  }
  async function sonarPing() {
    if (sonar.busy) return; sonar.busy = true;
    try {
      if (!(await sonarInit())) return;
      const ac = audioCtx(), sr = ac.sampleRate, chirp = makeChirp(sr);
      const reps = 3, gap = 0.12;
      const buf = ac.createBuffer(1, Math.round(sr * gap * reps), sr);
      const ch = buf.getChannelData(0);
      for (let r = 0; r < reps; r++) ch.set(chirp, Math.round(r * gap * sr));
      sonar.rec = [];
      await new Promise((r) => setTimeout(r, 120));
      const s = ac.createBufferSource(); s.buffer = buf; s.connect(ac.destination); s.start();
      await new Promise((r) => setTimeout(r, gap * reps * 1000 + 350));
      const chunks = sonar.rec; sonar.rec = null;
      const len = chunks.reduce((a, c) => a + c.length, 0), rec = new Float32Array(len);
      let o = 0; chunks.forEach((c) => { rec.set(c, o); o += c.length; });
      const res = analyseEcho(rec, chirp, sr, reps, gap);
      if (!res) { status('sonar-status', 'Couldn\'t hear the chirp. Turn the volume up, remove headphones and try again.', true); return; }
      sonar.lastProfile = res.profile; drawEcho(res);
      const heading = getHeading();
      if (res.dist) {
        S.map.sonar.push({ heading, dist: res.dist, t: Date.now() }); saveMap();
        status('sonar-status', `Nearest surface at ${heading.toFixed(0)}°: ${res.dist.toFixed(2)} m${S.headingLive ? '' : ' (set the heading slider to your direction)'}`);
      } else status('sonar-status', 'No clear echo. Point at a hard wall 0.5–8 m away.');
      drawPolar();
    } finally { sonar.busy = false; }
  }
  function analyseEcho(rec, chirp, sr, reps, gap) {
    const N = chirp.length;
    // matched filter (cross-correlation)
    const corr = new Float32Array(rec.length - N);
    for (let i = 0; i < corr.length; i++) { let s = 0; for (let j = 0; j < N; j += 1) s += rec[i + j] * chirp[j]; corr[i] = Math.abs(s); }
    // find direct path of first chirp
    let maxI = 0, maxV = 0; for (let i = 0; i < corr.length; i++) if (corr[i] > maxV) { maxV = corr[i]; maxI = i; }
    if (maxV < 0.02) return null;
    // direct path = first peak above 50% of max (max may be second rep)
    let d0 = maxI; for (let i = 0; i < maxI; i++) if (corr[i] > maxV * 0.5) { d0 = i; break; }
    const maxRange = 8, win = Math.round(((maxRange * 2) / 343) * sr);
    const profile = new Float32Array(win);
    for (let r = 0; r < reps; r++) {
      const start = d0 + Math.round(r * gap * sr);
      let peak = 0; for (let k = -40; k < 40; k++) { const v = corr[start + k] || 0; if (v > peak) peak = v; }
      if (!peak) continue;
      for (let k = 0; k < win; k++) profile[k] += (corr[start + k] || 0) / peak / reps;
    }
    // smooth envelope
    const env = new Float32Array(win), sm = Math.round(sr * 0.0004);
    for (let k = 0; k < win; k++) { let s = 0, n = 0; for (let j = -sm; j <= sm; j++) { const v = profile[k + j]; if (v != null) { s += v; n++; } } env[k] = s / n; }
    const minK = Math.round(((0.45 * 2) / 343) * sr);
    // noise floor
    const tail = [...env.slice(Math.round(win * 0.8))].sort((a, b) => a - b); const floor = tail[Math.floor(tail.length / 2)] || 0;
    let best = -1, bestV = 0;
    for (let k = minK; k < win - 1; k++) {
      // direct-path ringing decays: weight by distance a little
      const v = env[k] * (1 + k / win);
      if (env[k] > env[k - 1] && env[k] >= env[k + 1] && v > bestV && env[k] > floor * 2.2 + 0.02) { bestV = v; best = k; }
    }
    return { profile: env, sr, dist: best > 0 ? (best / sr) * 343 / 2 : null, floor };
  }
  function drawEcho(res) {
    const { ctx, w, h, dpr } = fitCanvas($('sonar-echo'));
    ctx.clearRect(0, 0, w, h);
    const p = res.profile, max = Math.max(...p.slice(Math.round(((0.45 * 2) / 343) * res.sr))) || 1;
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
    for (let k = 0; k < p.length; k++) { const x = (k / p.length) * w, y = h - 18 * dpr - clamp(p[k] / max, 0, 1) * (h - 30 * dpr); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.font = `${11 * dpr}px system-ui`;
    for (let m = 0; m <= 8; m += 2) ctx.fillText(m + ' m', (m / 8) * w + 2, h - 4 * dpr);
    ctx.fillText('Echo strength vs distance', 6 * dpr, 14 * dpr);
    if (res.dist) { const x = (res.dist / 8) * w; ctx.strokeStyle = css('--bad'); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]); }
  }
  function polarPts(list) { return list.map((p) => { const a = (p.heading * Math.PI) / 180; return { x: Math.sin(a) * p.dist, y: -Math.cos(a) * p.dist, p }; }); }
  function drawRoomBase(ctx, w, h, dpr, maxR) {
    const cx = w / 2, cy = h / 2, sc = (Math.min(w, h) / 2 - 24 * dpr) / maxR;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.font = `${11 * dpr}px system-ui`; ctx.lineWidth = 1;
    const step = maxR > 6 ? 2 : 1;
    for (let r = step; r <= maxR; r += step) { ctx.beginPath(); ctx.arc(cx, cy, r * sc, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(r + ' m', cx + r * sc + 2, cy - 2); }
    ctx.fillText('N', cx - 4 * dpr, 14 * dpr);
    ctx.fillStyle = css('--accent'); ctx.beginPath(); ctx.arc(cx, cy, 5 * dpr, 0, Math.PI * 2); ctx.fill();
    const hd = (getHeading() * Math.PI) / 180; ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(hd) * 30 * dpr, cy - Math.cos(hd) * 30 * dpr); ctx.stroke();
    return { cx, cy, sc };
  }
  function drawOutline(ctx, cx, cy, sc, dpr) {
    const pts = polarPts([...S.map.sonar].sort((a, b) => a.heading - b.heading));
    if (pts.length > 2) {
      ctx.fillStyle = css('--accent') + '22'; ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2 * dpr; ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(cx + q.x * sc, cy + q.y * sc) : ctx.moveTo(cx + q.x * sc, cy + q.y * sc)));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = css('--text');
    pts.forEach((q) => { ctx.beginPath(); ctx.arc(cx + q.x * sc, cy + q.y * sc, 3.5 * dpr, 0, Math.PI * 2); ctx.fill(); });
  }
  function drawPolar() {
    const c = $('sonar-polar'); if (!c.clientWidth) return;
    const { ctx, w, h, dpr } = fitCanvas(c);
    const maxR = Math.max(3, Math.ceil(Math.max(0, ...S.map.sonar.map((p) => p.dist))));
    const { cx, cy, sc } = drawRoomBase(ctx, w, h, dpr, maxR);
    drawOutline(ctx, cx, cy, sc, dpr);
  }
  $('sonar-ping').addEventListener('click', sonarPing);
  $('sonar-auto').addEventListener('click', async () => {
    if (sonar.auto) { clearInterval(sonar.auto); sonar.auto = null; $('sonar-auto').textContent = 'Auto ping (turn slowly)'; return; }
    if (!(await sonarInit())) return;
    let lastH = null;
    $('sonar-auto').textContent = 'Stop auto ping';
    sonar.auto = setInterval(() => {
      const hd = getHeading();
      if (lastH == null || Math.abs(((hd - lastH + 540) % 360) - 180) > 12 || !S.headingLive) { lastH = hd; sonarPing(); }
    }, 1300);
  });
  $('sonar-clear').addEventListener('click', () => { S.map.sonar = []; saveMap(); drawPolar(); status('sonar-status', 'Cleared.'); });
  setInterval(() => { if ($('tab-sonar').classList.contains('active') && S.headingLive) drawPolar(); }, 500);

  // ---------- Spectrogram ----------
  const au = { stream: null, an: null, raf: 0, peaks: new Map() };
  $('audio-start').addEventListener('click', async () => {
    if (!(await consent('microphone'))) return;
    try { au.stream = await getMic(); } catch (e) { return status('audio-status', 'Microphone error: ' + errMsg(e), true); }
    const ac = audioCtx();
    au.an = ac.createAnalyser(); au.an.fftSize = 4096; au.an.smoothingTimeConstant = 0.2; au.an.minDecibels = -120; au.an.maxDecibels = -20;
    ac.createMediaStreamSource(au.stream).connect(au.an);
    $('audio-nyq').textContent = (ac.sampleRate / 2000).toFixed(1) + ' kHz';
    $('audio-stop').disabled = false; status('audio-status', 'Listening. Bright horizontal lines high up = steady high-pitched tones.');
    audioLoop();
  });
  function audioLoop() {
    const an = au.an; if (!an) return;
    const c = $('audio-spec'); const { ctx, w, h, dpr } = fitCanvas(c, 1.5);
    const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins);
    const td = new Float32Array(an.fftSize); an.getFloatTimeDomainData(td);
    let rms = 0; for (const v of td) rms += v * v; rms = Math.sqrt(rms / td.length);
    const dbfs = 20 * Math.log10(rms + 1e-9);
    $('audio-db').textContent = `≈ ${Math.max(0, Math.round(dbfs + 100))} dB`;
    const sr = actx.sampleRate, binHz = sr / an.fftSize;
    let pk = 0; for (let i = 5; i < bins.length; i++) if (bins[i] > bins[pk]) pk = i;
    $('audio-peak').textContent = (pk * binHz / 1000).toFixed(2) + ' kHz';
    // scroll left
    const step = Math.max(1, Math.round(2 * dpr));
    ctx.drawImage(c, step, 0, w - step, h, 0, 0, w - step, h);
    for (let y = 0; y < h; y++) {
      const f = 1 - y / h, i = Math.floor(f * (bins.length - 1));
      const v = clamp((bins[i] + 120) / 100, 0, 1);
      ctx.fillStyle = heatColor(v); ctx.fillRect(w - step, y, step, 1);
    }
    // labels
    ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, 54 * dpr, h);
    ctx.fillStyle = '#cde'; ctx.font = `${10 * dpr}px system-ui`;
    for (let k = 0; k <= sr / 2000; k += 4) { const y = h - (k * 1000 / (sr / 2)) * h; ctx.fillText(k + ' kHz', 4 * dpr, clamp(y, 10 * dpr, h - 2)); }
    const y15 = h - (15000 / (sr / 2)) * h; ctx.strokeStyle = '#ff5d6c88'; ctx.beginPath(); ctx.moveTo(54 * dpr, y15); ctx.lineTo(w, y15); ctx.stroke();
    // ultrasonic tonal peaks
    const start = Math.floor(15000 / binHz);
    for (let i = start + 3; i < bins.length - 3; i++) {
      const loc = (bins[i - 3] + bins[i + 3] + bins[i - 2] + bins[i + 2]) / 4;
      if (bins[i] > -95 && bins[i] - loc > 18 && bins[i] >= bins[i - 1] && bins[i] >= bins[i + 1]) {
        const key = Math.round((i * binHz) / 100) * 100; const p = au.peaks.get(key) || { hz: key, n: 0, db: -200 };
        p.n++; p.db = Math.max(p.db, bins[i]); p.last = Date.now(); au.peaks.set(key, p);
      }
    }
    if (Math.random() < 0.05) {
      const list = [...au.peaks.values()].filter((p) => p.n > 30 && Date.now() - p.last < 5000).sort((a, b) => b.n - a.n).slice(0, 6);
      $('audio-peaks').innerHTML = list.length ? list.map((p) => `<div class="item"><div class="t">${(p.hz / 1000).toFixed(1)} kHz steady tone</div><div class="s">Above most adults' hearing. Common sources: chargers, monitors, motion sensors, pest repellers, cameras, ultrasonic beacons. Walk toward it — it gets brighter.</div><div class="r">${Math.round(p.db)} dB</div></div>`).join('') : '';
    }
    au.raf = requestAnimationFrame(audioLoop);
  }
  function heatColor(v) { const r = clamp(v * 3, 0, 1), g = clamp(v * 3 - 1, 0, 1), b = clamp(v * 3 - 2, 0, 1) * 0.8 + (v < 0.33 ? v * 1.2 : 0); return `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`; }
  $('audio-stop').addEventListener('click', () => { cancelAnimationFrame(au.raf); stopStream(au.stream); au.an = null; $('audio-stop').disabled = true; status('audio-status', 'Stopped.'); });

  // ---------- Doppler presence ----------
  const dop = { stream: null, osc: null, an: null, timer: 0, base: [], f: 19000 };
  $('dop-start').addEventListener('click', async () => {
    if (!(await consent('microphone'))) return;
    try { dop.stream = await getMic(); } catch (e) { return toast('Microphone error: ' + errMsg(e)); }
    const ac = audioCtx(); dop.f = Math.min(19000, ac.sampleRate / 2 - 2500);
    dop.osc = ac.createOscillator(); dop.osc.frequency.value = dop.f; const g = ac.createGain(); g.gain.value = 0.25;
    dop.osc.connect(g).connect(ac.destination); dop.osc.start();
    dop.an = ac.createAnalyser(); dop.an.fftSize = 8192; dop.an.smoothingTimeConstant = 0.5;
    ac.createMediaStreamSource(dop.stream).connect(dop.an);
    dop.base = []; $('dop-stop').disabled = false; $('dop-sub').textContent = 'Learning the room — stay still for 3 seconds…';
    let tries = 0;
    dop.timer = setInterval(() => {
      const bins = new Float32Array(dop.an.frequencyBinCount); dop.an.getFloatFrequencyData(bins);
      const bw = ac.sampleRate / dop.an.fftSize, c = Math.round(dop.f / bw);
      const carrier = Math.max(bins[c - 1], bins[c], bins[c + 1]);
      if (carrier < -90) {
        if (++tries > 15 && dop.f > 17000) { dop.f = 17500; dop.osc.frequency.value = dop.f; tries = 0; }
        else if (tries > 15) { $('dop-sub').textContent = 'This speaker/mic can\'t do high tones. Try another device.'; }
        return;
      }
      let e = 0; for (let k = 4; k <= 50; k++) { e += Math.pow(10, (bins[c + k] - carrier) / 10) + Math.pow(10, (bins[c - k] - carrier) / 10); }
      const lvl = 10 * Math.log10(e + 1e-12);
      if (dop.base.length < 30) { dop.base.push(lvl); if (dop.base.length === 30) $('dop-sub').textContent = 'Watching for motion…'; return; }
      const b = [...dop.base].sort((x, y) => x - y)[15];
      const m = clamp((lvl - b) * 8, 0, 100);
      $('dop-val').textContent = m > 35 ? 'Motion!' : m > 12 ? 'Slight' : 'Still';
      $('dop-bar').style.width = m + '%';
    }, 100);
  });
  $('dop-stop').addEventListener('click', () => {
    clearInterval(dop.timer); if (dop.osc) { dop.osc.stop(); dop.osc = null; } stopStream(dop.stream);
    $('dop-stop').disabled = true; $('dop-val').textContent = '–'; $('dop-bar').style.width = '0'; $('dop-sub').textContent = 'Motion level';
  });

  // ---------- Light ----------
  const lt = { stream: null, sensor: null, raf: 0, series: [], chart: new LineChart($('light-chart'), { min: 0, max: 100, unit: '%', dp: 0 }), wk: document.createElement('canvas') };
  function kv(id, pairs) { $(id).innerHTML = pairs.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(''); }
  $('light-start').addEventListener('click', async () => {
    const vals = {};
    if (has.als) {
      if (await consent('motion')) {
        try { lt.sensor = new AmbientLightSensor({ frequency: 10 }); lt.sensor.addEventListener('reading', () => { vals.lux = lt.sensor.illuminance; }); lt.sensor.start(); } catch (e) { /* ignore */ }
      }
    }
    if (!(await consent('camera'))) return;
    stopOtherCams('light'); stopLight();
    try { lt.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } }); } catch (e) { return status('light-status', 'Camera error: ' + errMsg(e), true); }
    const track = lt.stream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual' }, { exposureMode: 'manual' }] }); } catch (e) { /* not supported */ }
    const v = $('light-video'); v.srcObject = lt.stream; await v.play().catch(() => {});
    $('light-stop').disabled = false; status('light-status', 'Point the camera at the room (not at a lamp). Values from the camera are estimates.');
    const loop = () => {
      if (!lt.stream) return;
      const wk = lt.wk; wk.width = 96; wk.height = 128; const wc = wk.getContext('2d', { willReadFrequently: true });
      if (v.videoWidth) {
        wc.drawImage(v, 0, 0, 96, 128);
        const d = wc.getImageData(0, 0, 96, 128).data;
        let r = 0, g = 0, b = 0; const rows = new Float32Array(128);
        for (let y = 0; y < 128; y++) for (let x = 0; x < 96; x++) { const i = (y * 96 + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; rows[y] += d[i] + d[i + 1] + d[i + 2]; }
        const n = 96 * 128; r /= n; g /= n; b /= n;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lt.series.push(lum); if (lt.series.length > 90) lt.series.shift();
        const mean = lt.series.reduce((a, c) => a + c, 0) / lt.series.length;
        const sd = Math.sqrt(lt.series.reduce((a, c) => a + (c - mean) ** 2, 0) / lt.series.length);
        const flickIdx = mean > 1 ? (sd / mean) * 100 : 0;
        const band = bandingScore(rows);
        const K = cct(r, g, b);
        lt.chart.push((lum / 255) * 100);
        $('light-swatch').style.background = `rgb(${r | 0},${g | 0},${b | 0})`;
        kv('light-kv', [
          [vals.lux != null ? 'Illuminance (sensor)' : 'Relative brightness', vals.lux != null ? Math.round(vals.lux) + ' lux' : Math.round((lum / 255) * 100) + ' %'],
          ['Colour temperature', K ? `${Math.round(K / 50) * 50} K (${K < 3300 ? 'warm' : K < 5000 ? 'neutral' : 'cool / daylight'})` : '–'],
          ['Brightness variation', flickIdx.toFixed(1) + ' %'],
          ['Mains flicker banding', band > 6 ? 'Detected (LED / fluorescent)' : band > 3.5 ? 'Weak' : 'None seen'],
        ]);
      }
      lt.raf = requestAnimationFrame(loop);
    };
    loop();
  });
  function bandingScore(rows) {
    const n = rows.length, m = rows.reduce((a, b) => a + b, 0) / n; const x = rows.map((v) => v - m);
    for (let i = n - 1; i > 1; i--) x[i] = x[i] - x[i - 1] * 0.0; // keep
    let best = 0, sum = 0, cnt = 0;
    for (let p = 4; p <= 40; p++) {
      let re = 0, im = 0; for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / p; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); }
      const mag = Math.hypot(re, im); sum += mag; cnt++; if (mag > best) best = mag;
    }
    return sum ? best / (sum / cnt) : 0;
  }
  function cct(r, g, b) {
    if (r + g + b < 15) return null;
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const X = 0.4124 * R + 0.3576 * G + 0.1805 * B, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
    const x = X / (X + Y + Z), y = Y / (X + Y + Z), nn = (x - 0.332) / (0.1858 - y);
    return clamp(449 * nn ** 3 + 3525 * nn ** 2 + 6823.3 * nn + 5520.33, 1500, 12000);
  }
  function stopLight() { cancelAnimationFrame(lt.raf); stopStream(lt.stream); lt.stream = null; if (lt.sensor) { lt.sensor.stop(); lt.sensor = null; } $('light-stop').disabled = true; }
  registerCam('light', stopLight);
  $('light-stop').addEventListener('click', () => { stopLight(); status('light-status', 'Stopped.'); });

  // ---------- Thermal ----------
  const th = { stream: null, raf: 0, lut: null };
  function makeLut(name) {
    const lut = new Uint8ClampedArray(256 * 3);
    const stops = { iron: [[0, 0, 0, 0], [0.25, 60, 0, 140], [0.5, 200, 30, 90], [0.75, 255, 150, 0], [1, 255, 255, 220]], rainbow: [[0, 0, 0, 120], [0.25, 0, 160, 255], [0.5, 0, 220, 60], [0.75, 255, 220, 0], [1, 255, 30, 0]], white: [[0, 0, 0, 0], [1, 255, 255, 255]] }[name];
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1], f = (t - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
    }
    return lut;
  }
  async function listCams() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('thermal-cam'), cur = sel.value;
      sel.innerHTML = '<option value="">Choose a camera…</option>' + devs.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || 'Camera ' + (i + 1))}</option>`).join('');
      if (cur) sel.value = cur;
      const t = devs.find((d) => /therm|flir|infiray|topdon|hikmicro|seek|uti|tc00|p2 pro|ir cam/i.test(d.label)); if (t && !cur) sel.value = t.deviceId;
    } catch (e) { /* ignore */ }
  }
  $('thermal-start').addEventListener('click', async () => {
    if (!(await consent('camera'))) return;
    stopOtherCams('thermal'); stopThermal();
    const id = $('thermal-cam').value;
    try { th.stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } } }); } catch (e) { return status('thermal-status', 'Camera error: ' + errMsg(e), true); }
    await listCams();
    const label = th.stream.getVideoTracks()[0].label || '';
    const isThermal = /therm|flir|infiray|topdon|hikmicro|seek|uti|tc00|p2 pro|ir cam/i.test(label);
    status('thermal-status', isThermal ? `Thermal camera "${label}" — bright colours are hotter. Crosshair marks the hottest spot.` : `"${label || 'Camera'}" looks like an ordinary camera: colours show brightness, NOT heat. Plug in a USB thermal camera and choose it above.`, !isThermal);
    const v = $('thermal-video'); v.srcObject = th.stream; await v.play().catch(() => {});
    $('thermal-stop').disabled = false; th.lut = makeLut($('thermal-pal').value);
    const c = $('thermal-canvas');
    const loop = () => {
      if (!th.stream) return;
      const { ctx, w, h, dpr } = fitCanvas(c, 1);
      if (coverDraw(ctx, v, w, h)) {
        const img = ctx.getImageData(0, 0, w, h), d = img.data;
        let mn = 255, mx = 0, mxI = 0;
        for (let i = 0; i < d.length; i += 4) { const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i + 3] = l; if (l < mn) mn = l; if (l > mx) { mx = l; mxI = i; } }
        const rng = Math.max(1, mx - mn);
        for (let i = 0; i < d.length; i += 4) { const l = (((d[i + 3] - mn) / rng) * 255) | 0; d[i] = th.lut[l * 3]; d[i + 1] = th.lut[l * 3 + 1]; d[i + 2] = th.lut[l * 3 + 2]; d[i + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        const px = (mxI / 4) % w, py = Math.floor(mxI / 4 / w);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(px - 12, py); ctx.lineTo(px + 12, py); ctx.moveTo(px, py - 12); ctx.lineTo(px, py + 12); ctx.stroke();
      }
      th.raf = requestAnimationFrame(loop);
    };
    loop();
  });
  $('thermal-pal').addEventListener('change', (e) => { th.lut = makeLut(e.target.value); });
  function stopThermal() { cancelAnimationFrame(th.raf); stopStream(th.stream); th.stream = null; $('thermal-stop').disabled = true; }
  registerCam('thermal', stopThermal);
  $('thermal-stop').addEventListener('click', () => { stopThermal(); status('thermal-status', 'Stopped.'); });
  $('thermal-cam').addEventListener('focus', listCams);

  // ---------- Network ----------
  const net = { timer: 0, chart: new LineChart($('net-chart'), { unit: ' ms', dp: 0, min: 0 }) };
  function netInfo(lat) {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    kv('net-info', [
      ['Online', navigator.onLine ? 'Yes' : 'No'],
      ['Connection', c.type || 'hidden by browser'],
      ['Quality class', c.effectiveType ? c.effectiveType.toUpperCase() : 'hidden'],
      ['Downlink estimate', c.downlink != null ? c.downlink + ' Mbps' : 'hidden'],
      ['Browser RTT', c.rtt != null ? c.rtt + ' ms' : 'hidden'],
      ['Measured latency', lat != null ? Math.round(lat) + ' ms' : '–'],
      ['Data saver', c.saveData ? 'On' : 'Off'],
    ]);
  }
  netInfo();
  $('net-start').addEventListener('click', () => {
    clearInterval(net.timer); $('net-stop').disabled = false;
    const tick = async () => {
      const t0 = performance.now();
      try { await fetch('manifest.webmanifest?ping=' + Date.now(), { cache: 'no-store' }); const lat = performance.now() - t0; net.chart.push(lat); netInfo(lat); }
      catch (e) { net.chart.push(2000); netInfo(null); }
    };
    tick(); net.timer = setInterval(tick, 1000);
  });
  $('net-stop').addEventListener('click', () => { clearInterval(net.timer); $('net-stop').disabled = true; });
  const conn = navigator.connection; if (conn && conn.addEventListener) conn.addEventListener('change', () => netInfo());

  // ---------- Motion, level, vibration, GPS ----------
  const mo = { seis: new LineChart($('seis-chart'), { unit: ' m/s²', dp: 2, min: 0 }), lp: null, vals: {}, got: false, lastDraw: 0 };
  function sensTiles() {
    const v = mo.vals;
    $('sens-grid').innerHTML = Object.keys(v).map((k) => `<div><span>${k}</span><b>${v[k]}</b></div>`).join('');
  }
  $('sens-start').addEventListener('click', async () => {
    if (!(await consent('motion'))) return;
    try { await requestMotionPermission(); } catch (e) { return status('sens-status', 'Motion permission denied.', true); }
    startHeading();
    window.addEventListener('devicemotion', (e) => {
      mo.got = true;
      const g = e.accelerationIncludingGravity || {}, a = e.acceleration || {}, r = e.rotationRate || {};
      if (g.x == null) return;
      const pitch = (Math.atan2(g.y, Math.hypot(g.x, g.z)) * 180) / Math.PI, roll = (Math.atan2(-g.x, Math.hypot(g.y, g.z)) * 180) / Math.PI;
      const mag = Math.hypot(g.x, g.y, g.z);
      mo.lp = mo.lp == null ? mag : mo.lp * 0.9 + mag * 0.1;
      const vib = a.x != null ? Math.hypot(a.x, a.y, a.z) : Math.abs(mag - mo.lp);
      mo.vals['Tilt front/back'] = pitch.toFixed(1) + '°';
      mo.vals['Tilt left/right'] = roll.toFixed(1) + '°';
      mo.vals['Gravity'] = mag.toFixed(2) + ' m/s²';
      mo.vals['Vibration'] = vib.toFixed(3) + ' m/s²';
      if (r.alpha != null) mo.vals['Rotation'] = `${(r.alpha || 0).toFixed(0)}, ${(r.beta || 0).toFixed(0)}, ${(r.gamma || 0).toFixed(0)} °/s`;
      if (S.headingLive) mo.vals['Compass'] = Math.round(S.heading) + '°';
      const now = performance.now();
      if (now - mo.lastDraw > 60) { mo.lastDraw = now; mo.seis.push(vib); drawLevel(g); sensTiles(); }
    });
    setTimeout(() => { status('sens-status', mo.got ? 'Lay the device flat on a surface to use it as a level. Vibration graph shows footsteps, machines, appliances.' : 'No motion sensor found (most laptops have none). Try on a phone or tablet.', !mo.got); }, 1500);
  });
  function drawLevel(g) {
    const c = $('level-canvas'); const { ctx, w, h, dpr } = fitCanvas(c);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 16 * dpr;
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = css('--line'); ctx.lineWidth = 1.5 * dpr;
    [1, 0.5, 0.15].forEach((f) => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); });
    const s = (isIOS ? -1 : 1);
    const bx = cx + clamp((s * -g.x) / 9.81, -1, 1) * R, by = cy + clamp((s * g.y) / 9.81, -1, 1) * R;
    const lev = Math.hypot(bx - cx, by - cy) < R * 0.15 / 1.5;
    ctx.fillStyle = lev ? css('--ok') : css('--warn'); ctx.beginPath(); ctx.arc(bx, by, 16 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css('--muted'); ctx.font = `${12 * dpr}px system-ui`; ctx.fillText(lev ? 'Level' : 'Bubble level', 10 * dpr, 18 * dpr);
  }
  $('geo-start').addEventListener('click', async () => {
    if (!has.geo) return status('sens-status', 'No location in this browser.', true);
    if (!(await consent('location'))) return;
    navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      mo.vals['Latitude'] = c.latitude.toFixed(6); mo.vals['Longitude'] = c.longitude.toFixed(6);
      mo.vals['GPS accuracy'] = '±' + Math.round(c.accuracy) + ' m';
      if (c.altitude != null) mo.vals['Altitude'] = Math.round(c.altitude) + ' m';
      if (c.speed != null) mo.vals['Speed'] = (c.speed * 3.6).toFixed(1) + ' km/h';
      sensTiles();
    }, (e) => status('sens-status', 'Location error: ' + errMsg(e), true), { enableHighAccuracy: true });
  });

  // ---------- NFC ----------
  $('nfc-start').addEventListener('click', async () => {
    if (!has.nfc) return status('addon-status', 'NFC needs Chrome or Samsung Internet on an Android phone with NFC turned on.', true);
    if (!(await consent('nfc'))) return;
    try {
      const r = new NDEFReader(); await r.scan();
      status('addon-status', 'NFC on. Hold the back of the phone against objects, stickers and cards.');
      r.onreadingerror = () => toast('Tag found but unreadable (may be encrypted, e.g. a bank or transit card).');
      r.onreading = (ev) => {
        const recs = [...ev.message.records].map((rec) => {
          let data = '';
          try { if (rec.recordType === 'text' || rec.recordType === 'url' || rec.recordType === 'absolute-url') data = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data); else if (rec.mediaType && rec.mediaType.startsWith('text')) data = new TextDecoder().decode(rec.data); else data = (rec.data ? rec.data.byteLength : 0) + ' bytes'; } catch (e) { data = '?'; }
          return `${rec.recordType}${rec.mediaType ? ' (' + rec.mediaType + ')' : ''}: ${data}`;
        });
        S.nfc.unshift({ serial: ev.serialNumber, recs, t: Date.now() });
        $('nfc-list').innerHTML = S.nfc.map((n) => `<div class="item"><div class="t">NFC tag ${escapeHtml(n.serial || '')}</div><div class="s">${n.recs.length ? n.recs.map(escapeHtml).join('<br>') : 'Empty tag'}</div><div class="r"><small>${new Date(n.t).toLocaleTimeString()}</small></div></div>`).join('');
        toast('NFC tag read');
      };
    } catch (e) { status('addon-status', 'NFC error: ' + errMsg(e), true); }
  });

  // ---------- Bluetooth Environmental Sensing ----------
  const ESS = {
    0x2a6e: ['Temperature', (v) => (v.getInt16(0, true) / 100).toFixed(2) + ' °C'],
    0x2a6f: ['Humidity', (v) => (v.getUint16(0, true) / 100).toFixed(1) + ' %'],
    0x2a6d: ['Pressure', (v) => (v.getUint32(0, true) / 1000).toFixed(1) + ' hPa'],
    0x2a76: ['UV index', (v) => v.getUint8(0)],
    0x2a77: ['Irradiance', (v) => (v.getUint16(0, true) / 10).toFixed(1) + ' W/m²'],
    0x2a7b: ['Dew point', (v) => v.getInt8(0) + ' °C'],
    0x2a72: ['Wind speed', (v) => (v.getUint16(0, true) / 100).toFixed(1) + ' m/s'],
    0x2a73: ['Wind direction', (v) => (v.getUint16(0, true) / 100).toFixed(0) + '°'],
    0x2a6c: ['Elevation', (v) => (((v.getUint8(0) | (v.getUint8(1) << 8) | (v.getInt8(2) << 16))) / 100).toFixed(1) + ' m'],
    0x2a19: ['Battery', (v) => v.getUint8(0) + ' %'],
  };
  function addonTile(k, v) { S.addon[k] = v; $('addon-grid').innerHTML = Object.keys(S.addon).map((key) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(String(S.addon[key]))}</b></div>`).join(''); }
  $('ess-start').addEventListener('click', async () => {
    if (!has.bt) return status('addon-status', isIOS ? 'Use the Bluefy browser on iPhone/iPad for Bluetooth sensors.' : 'This browser has no Web Bluetooth.', true);
    if (!(await consent('bluetooth'))) return;
    try {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['environmental_sensing'] }], optionalServices: ['battery_service'] });
      status('addon-status', 'Connecting to ' + (dev.name || 'sensor') + '…');
      const gatt = await dev.gatt.connect();
      const svcs = [await gatt.getPrimaryService('environmental_sensing')];
      try { svcs.push(await gatt.getPrimaryService('battery_service')); } catch (e) { /* none */ }
      let n = 0;
      for (const s of svcs) {
        for (const ch of await s.getCharacteristics()) {
          const short = parseInt(ch.uuid.slice(4, 8), 16), def = ESS[short];
          const name = (dev.name ? dev.name + ' · ' : '') + (def ? def[0] : 'Value 0x' + short.toString(16));
          const show = (v) => addonTile(name, def ? def[1](v) : [...new Uint8Array(v.buffer)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
          try {
            if (ch.properties.notify) { ch.addEventListener('characteristicvaluechanged', (e) => show(e.target.value)); await ch.startNotifications(); }
            if (ch.properties.read) { show(await ch.readValue()); if (!ch.properties.notify) setInterval(() => ch.readValue().then(show).catch(() => {}), 3000); }
            n++;
          } catch (e) { /* skip */ }
        }
      }
      status('addon-status', `Connected to ${dev.name || 'sensor'} — ${n} readings live.`);
      dev.addEventListener('gattserverdisconnected', () => status('addon-status', (dev.name || 'Sensor') + ' disconnected.', true));
    } catch (e) { if (e.name !== 'NotFoundError') status('addon-status', 'Bluetooth sensor error: ' + errMsg(e), true); }
  });

  // ---------- Serial ----------
  $('ser-start').addEventListener('click', async () => {
    if (!has.serial) return status('addon-status', 'USB serial needs Chrome or Edge on Windows, Mac, Linux, ChromeOS or Android.', true);
    if (!(await consent('serial'))) return;
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: +$('ser-baud').value });
      status('addon-status', 'USB device connected. Waiting for data lines…');
      const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += value; const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const line of lines) parseSerial(line.trim());
      }
    } catch (e) { if (e.name !== 'NotFoundError') status('addon-status', 'USB error: ' + errMsg(e), true); }
  });
  function parseSerial(line) {
    if (!line) return;
    if (line[0] === '{') { try { const o = JSON.parse(line); Object.keys(o).forEach((k) => addonTile(k, o[k])); return; } catch (e) { /* not json */ } }
    const kvs = [...line.matchAll(/([A-Za-z_][\w.\-%]*)\s*[=:]\s*(-?[\d.]+\s*[A-Za-z°%µ/³²]*)/g)];
    if (kvs.length) { kvs.forEach((m) => addonTile(m[1], m[2])); return; }
    const nums = line.split(/[,;\t ]+/).filter((x) => x !== '' && !isNaN(+x));
    if (nums.length) nums.forEach((x, i) => addonTile('value ' + (i + 1), x)); else addonTile('last message', line.slice(0, 80));
  }

  // ---------- Room map ----------
  function drawMap() {
    const c = $('map-canvas'); if (!c.clientWidth) return;
    const { ctx, w, h, dpr } = fitCanvas(c);
    const all = [...S.map.sonar, ...S.map.devices, ...S.map.notes];
    const maxR = Math.max(3, Math.ceil(Math.max(0, ...all.map((p) => p.dist || 0))));
    const { cx, cy, sc } = drawRoomBase(ctx, w, h, dpr, maxR);
    drawOutline(ctx, cx, cy, sc, dpr);
    const mark = (p, color, label) => {
      const a = (p.heading * Math.PI) / 180, x = cx + Math.sin(a) * p.dist * sc, y = cy - Math.cos(a) * p.dist * sc;
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css('--text'); ctx.font = `${11 * dpr}px system-ui`; ctx.fillText(label.slice(0, 22), x + 9 * dpr, y + 4 * dpr);
    };
    S.map.devices.forEach((d) => mark(d, d.alert ? css('--bad') : '#5aa9ff', d.name));
    S.map.notes.forEach((n) => mark(n, n.kind === 'lens' ? css('--bad') : css('--warn'), n.text));
    const items = [
      ...S.map.devices.map((d, i) => ['devices', i, `ᛒ ${d.name}`, `${Math.round(d.heading)}° · ~${fmtDist(d.dist)}`]),
      ...S.map.notes.map((n, i) => ['notes', i, `✎ ${n.text}`, `${Math.round(n.heading)}° · ~${fmtDist(n.dist)}`]),
    ];
    $('map-list').innerHTML = (S.map.sonar.length ? `<div class="item"><div class="t">◠ Room outline</div><div class="s">${S.map.sonar.length} sonar pings</div><div class="r"></div></div>` : '') +
      items.map(([k, i, t, s]) => `<div class="item"><div class="t">${escapeHtml(t)}</div><div class="s">${s}</div><div class="r"><button class="btn small ghost" data-del="${k}:${i}">Remove</button></div></div>`).join('');
  }
  $('map-list').addEventListener('click', (e) => { const d = e.target.dataset.del; if (!d) return; const [k, i] = d.split(':'); S.map[k].splice(+i, 1); saveMap(); });
  $('map-add').addEventListener('click', async () => {
    await startHeading();
    const text = prompt(`Note at ${Math.round(getHeading())}° (what is it?)`, 'Smoke detector'); if (!text) return;
    const dist = parseFloat(prompt('Roughly how far away, in metres?', '2')) || 2;
    S.map.notes.push({ text, heading: getHeading(), dist, kind: 'note', t: Date.now() }); saveMap();
  });
  $('map-clear').addEventListener('click', () => { if (!confirm('Clear the whole room map?')) return; S.map = { sonar: [], devices: [], notes: [] }; saveMap(); drawPolar(); });
  function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  $('map-export').addEventListener('click', () => {
    const data = {
      app: 'Genzineers Environment Scanner', exported: new Date().toISOString(), map: S.map,
      bluetooth: [...S.bt.values()].map((d) => ({ name: d.name, rssi: d.rssi, estDistanceM: d.rssi != null ? +rssiToDist(d.rssi, d.tx).toFixed(2) : null, tags: classify(d).tags })),
      nfc: S.nfc, addonSensors: S.addon, points3d: window.ES3D ? window.ES3D.count() : 0,
    };
    download(`room-scan-${Date.now()}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  });
  window.addEventListener('resize', () => { drawMap(); drawPolar(); });

  // ---------- add-on pills ----------
  function pill(id, ok, text) { const p = $(id); p.className = 'pill ' + (ok ? 'ok' : 'no'); p.textContent = text || (ok ? 'available' : 'not here'); }
  pill('nfc-pill', has.nfc); pill('ess-pill', has.bt); pill('ser-pill', has.serial);

  // ---------- boot ----------
  window.ES = { S, $, toast, status, consent, fitCanvas, registerCam, stopOtherCams, stopStream, startHeading, getHeading, errMsg, download, css, isIOS, has };
  renderCaps(); renderPerms(); checkXR();
  const start = (location.hash || '').slice(1);
  if (start && $('tab-' + start)) showTab(start);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
