import { $, esc, icon, fmtDate, plural, api, toast } from './core.js';

const grab = document.createElement('canvas');
const ctx = grab.getContext('2d', { willReadFrequently: true });
let stream = null, timer = 0, paused = false, busy = false;
const canCamera = !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

export function renderScan(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Scan</h1><p>Scan the member's QR code to see their trainer and when it expires.</p></div></div>
    <div class="scan-wrap">
      <section class="card">
        <div class="camera" id="camera">
          <video id="cam" playsinline muted hidden></video>
          <div class="cam-frame" id="cam-frame" hidden></div>
          <div class="cam-idle" id="cam-idle">${icon('scan')}<span>${canCamera ? 'Press Start camera and hold the QR code inside the square.' : 'The camera needs a secure (https) link. Use Scan from a photo below.'}</span></div>
        </div>
        <div class="scan-controls">
          ${canCamera ? `<button class="btn btn-primary btn-lg btn-block" type="button" id="cam-start">${icon('camera')}Start camera</button>
          <button class="btn btn-lg btn-block" type="button" id="cam-stop" hidden>${icon('stop')}Stop camera</button>` : ''}
          <button class="btn btn-block" type="button" id="photo-btn">${icon('image')}Scan from a photo</button>
          <input type="file" id="photo-in" accept="image/*" hidden>
        </div>
      </section>
      <div id="scan-out">
        <section class="card result"><div class="result-wait">${icon('qr', 40)}<p style="margin-top:10px">The result shows here: the member, their trainer and the expiry date.</p></div></section>
      </div>
    </div>`;
  $('#cam-start')?.addEventListener('click', startCamera);
  $('#cam-stop')?.addEventListener('click', stopCamera);
  $('#photo-btn').addEventListener('click', () => { const i = $('#photo-in'); i.value = ''; i.click(); });
  $('#photo-in').addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    showWait('Reading the QR code…');
    const text = await decodeFile(file);
    if (text) check(text);
    else showResult({ result: 'unknown', message: 'No QR code found in the photo. Try again with the code filling more of the picture.' }, false);
  });
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch {
    toast('Camera blocked. Allow camera access in the browser settings, or scan from a photo.', { bad: true });
    return;
  }
  const v = $('#cam'); if (!v) { stopCamera(); return; }
  v.srcObject = stream; v.hidden = false;
  try { await v.play(); } catch { /* muted video can play */ }
  $('#cam-idle').hidden = true; $('#cam-frame').hidden = false;
  $('#cam-start').hidden = true; $('#cam-stop').hidden = false;
  paused = false; tick();
}

export function stopCamera() {
  clearTimeout(timer);
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  const v = $('#cam'); if (!v) return;
  v.srcObject = null; v.hidden = true;
  $('#cam-idle').hidden = false; $('#cam-frame').hidden = true;
  if ($('#cam-start')) { $('#cam-start').hidden = false; $('#cam-stop').hidden = true; }
}

function tick() {
  if (!stream) return;
  const v = $('#cam');
  if (v && !paused && !busy && v.readyState >= 2 && v.videoWidth && window.jsQR) {
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    grab.width = Math.round(v.videoWidth * scale); grab.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, grab.width, grab.height);
    const img = ctx.getImageData(0, 0, grab.width, grab.height);
    const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (hit?.data) { navigator.vibrate?.(80); paused = true; check(hit.data); }
  }
  timer = setTimeout(tick, 150);
}

async function decodeFile(file) {
  let src;
  try { src = await createImageBitmap(file); } catch {
    src = await new Promise(res => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = URL.createObjectURL(file); });
  }
  if (!src) return null;
  if ('BarcodeDetector' in window) {
    try { const [code] = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(src); if (code?.rawValue) return code.rawValue; } catch { /* use jsQR */ }
  }
  for (const max of [1000, 1600, 2400]) {
    const scale = Math.min(1, max / Math.max(src.width, src.height));
    grab.width = Math.round(src.width * scale); grab.height = Math.round(src.height * scale);
    ctx.drawImage(src, 0, 0, grab.width, grab.height);
    const img = ctx.getImageData(0, 0, grab.width, grab.height);
    const hit = window.jsQR?.(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) return hit.data;
    if (scale === 1) break;
  }
  return null;
}

function showWait(text) {
  $('#scan-out').innerHTML = `<section class="card result"><div class="result-wait"><div class="spinner"></div>${esc(text)}</div></section>`;
}

async function check(code) {
  busy = true; showWait('Checking…');
  try { showResult(await api('/scan', { method: 'POST', body: { code } }), true); }
  catch (err) { showResult({ result: 'unknown', message: err.message }, true); }
  finally { busy = false; }
}

const LOOK = {
  valid: ['valid', 'check', 'Valid'], expired: ['expired', 'x', 'Expired'], replaced: ['replaced', 'x', 'Old QR code'],
  upcoming: ['upcoming', 'help', 'Not started'], unknown: ['unknown', 'help', 'Not recognised'],
};
function showResult(r, fromScan) {
  const [cls, ic, word] = LOOK[r.result] || LOOK.unknown;
  const days = r.result === 'valid' ? (r.days === 0 ? 'Last day today' : `${plural(r.days, 'day')} left`) : r.result === 'expired' ? `Ended ${plural(r.days, 'day')} ago` : '';
  const live = !!stream;
  $('#scan-out').innerHTML = `
    <section class="card result ${cls}" role="status">
      <div class="result-band">${icon(ic)}<div><div class="result-word">${word}</div><div class="result-msg">${esc(r.message || '')}</div></div></div>
      <div class="result-body">
        ${r.member ? `<div class="result-name">${esc(r.member.name)}</div>
        <dl class="facts">
          <div><dt>Trainer</dt><dd>${esc(r.trainer.name)}</dd></div>
          <div><dt>Expiry date</dt><dd>${esc(fmtDate(r.end))}</dd></div>
          <div><dt>Started</dt><dd>${esc(fmtDate(r.start))}</dd></div>
          <div><dt>Days</dt><dd>${esc(days || '—')}</dd></div>
        </dl>` : ''}
        <div class="btn-row">
          ${live ? `<button class="btn btn-primary btn-lg" type="button" id="scan-next">${icon('scan')}Scan next</button>` : ''}
          ${r.member ? `<button class="btn" type="button" data-action="open-member-load" data-id="${r.member.id}">${icon('qr')}Member details</button>` : ''}
        </div>
      </div>
    </section>`;
  $('#scan-next')?.addEventListener('click', () => {
    paused = false;
    $('#scan-out').innerHTML = `<section class="card result"><div class="result-wait">${icon('scan', 40)}<p style="margin-top:10px">Scanning… hold the next QR code in the square.</p></div></section>`;
  });
  if (fromScan && window.matchMedia('(max-width: 899px)').matches) $('#scan-out').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
