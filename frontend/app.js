'use strict';

// Alamat ini dipakai saat pengembangan lokal di laptop.
// Saat hosting, alamat akan diubah ke domain API HTTPS/WSS.
const API_BASE = 'http://127.0.0.1:8000';
const WS_URL = 'ws://127.0.0.1:8000/ws/detect';

const $ = (id) => document.getElementById(id);
const backendStatus = $('backendStatus');
const cameraVideo = $('cameraVideo');
const cameraOverlay = $('cameraOverlay');
const overlayContext = cameraOverlay.getContext('2d');
const frameCanvas = document.createElement('canvas');
const frameContext = frameCanvas.getContext('2d');

let cameraStream = null;
let cameraSocket = null;
let cameraRunning = false;
let frameInFlight = false;
let selectedObjectUrl = null;

// Penstabil tampilan: kotak yang sesaat terlewat model tidak langsung hilang.
// Ini hanya meredam kedipan visual; tidak mengubah prediksi model.
let cameraTracks = [];
let nextTrackId = 1;
const TRACK_TTL_MS = 650;
const MATCH_IOU_THRESHOLD = 0.15;
const BOX_SMOOTHING = 0.65;
const FRAME_INTERVAL_MS = 90;

function setBackendStatus(online, message) {
  backendStatus.textContent = message;
  backendStatus.parentElement.classList.toggle('online', online);
}

async function checkBackend() {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) throw new Error('Backend tidak merespons');
    const data = await response.json();
    setBackendStatus(Boolean(data.model_loaded), data.model_loaded ? 'Backend & AI aktif' : 'Model belum siap');
  } catch (_) {
    setBackendStatus(false, 'Backend tidak terhubung');
  }
}

function switchTab(tab) {
  const cameraMode = tab === 'camera';
  $('cameraTab').classList.toggle('active', cameraMode);
  $('uploadTab').classList.toggle('active', !cameraMode);
  $('cameraTab').setAttribute('aria-selected', String(cameraMode));
  $('uploadTab').setAttribute('aria-selected', String(!cameraMode));
  $('cameraPanel').hidden = !cameraMode;
  $('uploadPanel').hidden = cameraMode;
  if (!cameraMode) stopCamera();
}
$('cameraTab').addEventListener('click', () => switchTab('camera'));
$('uploadTab').addEventListener('click', () => switchTab('upload'));

function updateSummary(detections, statusText = 'Deteksi selesai') {
  const organic = detections.filter(item => String(item.class_name).toLowerCase() === 'organik').length;
  const inorganic = detections.filter(item => String(item.class_name).toLowerCase() === 'anorganik').length;
  $('organicCount').textContent = organic;
  $('inorganicCount').textContent = inorganic;
  $('totalCount').textContent = detections.length;
  $('resultStatus').textContent = statusText;
  $('resultStatus').className = 'pill success';

  const list = $('detectionList');
  if (!detections.length) {
    list.innerHTML = '<div class="empty-state"><span>⌕</span><div><strong>Tidak ditemukan objek sampah</strong><p>Coba arahkan kamera lebih dekat atau gunakan foto yang lebih jelas.</p></div></div>';
    return;
  }
  const rows = detections.map((item, index) => {
    const inorganicClass = String(item.class_name).toLowerCase() === 'anorganik';
    const confidence = (Number(item.confidence) * 100).toFixed(1).replace('.', ',');
    return `<div class="detection-row"><span class="detection-name"><i class="dot ${inorganicClass ? 'inorganic' : ''}"></i>${escapeHtml(item.class_name)} <span style="font-weight:500;color:#87958d">#${index + 1}</span></span><span class="confidence">${confidence}%</span></div>`;
  }).join('');
  list.innerHTML = `<div class="detection-items">${rows}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function clearOverlay() {
  overlayContext.clearRect(0, 0, cameraOverlay.width, cameraOverlay.height);
}

function iou(a, b) {
  const x1 = Math.max(Number(a.x1), Number(b.x1));
  const y1 = Math.max(Number(a.y1), Number(b.y1));
  const x2 = Math.min(Number(a.x2), Number(b.x2));
  const y2 = Math.min(Number(a.y2), Number(b.y2));
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, Number(a.x2) - Number(a.x1)) * Math.max(0, Number(a.y2) - Number(a.y1));
  const areaB = Math.max(0, Number(b.x2) - Number(b.x1)) * Math.max(0, Number(b.y2) - Number(b.y1));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function stabilizeCameraDetections(incoming) {
  const now = performance.now();
  const usedTrackIds = new Set();
  const updatedTracks = [];

  for (const detection of incoming || []) {
    let bestTrack = null;
    let bestScore = 0;
    for (const track of cameraTracks) {
      if (usedTrackIds.has(track.id)) continue;
      if (String(track.class_name) !== String(detection.class_name)) continue;
      const score = iou(track, detection);
      if (score > bestScore) {
        bestScore = score;
        bestTrack = track;
      }
    }

    if (bestTrack && bestScore >= MATCH_IOU_THRESHOLD) {
      const smoothed = { ...bestTrack };
      for (const key of ['x1', 'y1', 'x2', 'y2']) {
        smoothed[key] = Number(bestTrack[key]) * (1 - BOX_SMOOTHING) + Number(detection[key]) * BOX_SMOOTHING;
      }
      smoothed.confidence = Number(detection.confidence);
      smoothed.lastSeen = now;
      usedTrackIds.add(bestTrack.id);
      updatedTracks.push(smoothed);
    } else {
      updatedTracks.push({ ...detection, id: nextTrackId++, lastSeen: now });
    }
  }

  // Simpan kotak terakhir sebentar bila satu frame tidak mendeteksi objek.
  for (const track of cameraTracks) {
    if (!usedTrackIds.has(track.id) && now - track.lastSeen <= TRACK_TTL_MS) {
      updatedTracks.push(track);
    }
  }

  cameraTracks = updatedTracks.filter(track => now - track.lastSeen <= TRACK_TTL_MS);
  return cameraTracks;
}

function drawBoxes(data, detections) {
  if (!data || !data.image_width || !data.image_height) return;
  if (cameraOverlay.width !== data.image_width || cameraOverlay.height !== data.image_height) {
    cameraOverlay.width = data.image_width;
    cameraOverlay.height = data.image_height;
  }
  clearOverlay();
  const scale = Math.max(1, cameraOverlay.width / 640);
  overlayContext.lineWidth = 2.5 * scale;
  overlayContext.font = `bold ${Math.max(13, 14 * scale)}px Segoe UI, Arial`;
  overlayContext.textBaseline = 'bottom';

  for (const item of detections || []) {
    const isOrganic = String(item.class_name).toLowerCase() === 'organik';
    const color = isOrganic ? '#26c878' : '#55a0ff';
    const x = Number(item.x1), y = Number(item.y1);
    const width = Number(item.x2) - x, height = Number(item.y2) - y;
    overlayContext.strokeStyle = color;
    overlayContext.fillStyle = color;
    overlayContext.strokeRect(x, y, width, height);
    const label = `${item.class_name} ${(Number(item.confidence) * 100).toFixed(1)}%`;
    const textWidth = overlayContext.measureText(label).width;
    const labelHeight = Math.max(22, 22 * scale);
    const labelY = Math.max(labelHeight, y);
    overlayContext.fillRect(x, labelY - labelHeight, textWidth + 12, labelHeight);
    overlayContext.fillStyle = '#10251b';
    overlayContext.fillText(label, x + 6, labelY - 4 * scale);
  }
}

async function startCamera() {
  if (cameraRunning) return;
  $('cameraHelp').textContent = 'Meminta izin kamera...';
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser tidak menyediakan akses kamera. Gunakan localhost atau HTTPS.');
    }
    const facingMode = $('cameraFacing').value;
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
    if (!cameraVideo.videoWidth) {
      await new Promise((resolve, reject) => {
        cameraVideo.onloadedmetadata = resolve;
        cameraVideo.onerror = reject;
      });
    }
    $('cameraStage').style.aspectRatio = `${cameraVideo.videoWidth} / ${cameraVideo.videoHeight}`;
    $('cameraStage').classList.add('active');
    $('cameraPlaceholder').hidden = true;
    $('liveLabel').hidden = false;
    $('cameraStatus').textContent = 'Menghubungkan deteksi...';
    $('cameraStatus').className = 'pill warning';
    $('startCamera').disabled = true;
    $('stopCamera').disabled = false;
    $('cameraFacing').disabled = true;
    cameraRunning = true;
    cameraTracks = [];
    nextTrackId = 1;

    frameCanvas.width = Math.min(640, cameraVideo.videoWidth);
    frameCanvas.height = Math.max(1, Math.round(cameraVideo.videoHeight * (frameCanvas.width / cameraVideo.videoWidth)));

    cameraSocket = new WebSocket(WS_URL);
    cameraSocket.binaryType = 'arraybuffer';
    cameraSocket.onopen = () => {
      $('cameraStatus').textContent = 'Kamera & AI aktif';
      $('cameraStatus').className = 'pill success';
      $('cameraHelp').textContent = 'Deteksi berjalan otomatis. Kotak dapat bertahan sesaat agar tidak berkedip.';
      sendNextFrame();
    };
    cameraSocket.onmessage = (event) => {
      frameInFlight = false;
      try {
        const data = JSON.parse(event.data);
        if (data.success) {
          const stableDetections = stabilizeCameraDetections(data.detections || []);
          drawBoxes(data, stableDetections);
          updateSummary(stableDetections, 'Deteksi kamera aktif');
        }
      } catch (error) {
        console.error('Respons kamera tidak dapat dibaca:', error);
      }
      if (cameraRunning) window.setTimeout(sendNextFrame, FRAME_INTERVAL_MS);
    };
    cameraSocket.onerror = () => {
      frameInFlight = false;
      $('cameraHelp').textContent = 'Koneksi deteksi kamera bermasalah. Periksa apakah backend masih berjalan.';
    };
    cameraSocket.onclose = () => {
      frameInFlight = false;
      if (cameraRunning) {
        $('cameraStatus').textContent = 'Koneksi terputus';
        $('cameraStatus').className = 'pill warning';
        $('cameraHelp').textContent = 'Koneksi deteksi terputus. Tutup lalu buka kamera kembali.';
      }
    };
  } catch (error) {
    stopCamera();
    let message = 'Kamera tidak dapat dibuka: ' + error.message;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      message = 'Akses kamera membutuhkan localhost atau HTTPS.';
    }
    $('cameraHelp').textContent = message;
    $('cameraStatus').textContent = 'Kamera gagal dibuka';
    $('cameraStatus').className = 'pill warning';
  }
}

function sendNextFrame() {
  if (!cameraRunning || !cameraSocket || cameraSocket.readyState !== WebSocket.OPEN || frameInFlight) return;
  if (!cameraVideo.videoWidth || !cameraVideo.videoHeight) return;
  frameInFlight = true;
  frameContext.drawImage(cameraVideo, 0, 0, frameCanvas.width, frameCanvas.height);
  frameCanvas.toBlob(blob => {
    if (!blob || !cameraRunning || !cameraSocket || cameraSocket.readyState !== WebSocket.OPEN) {
      frameInFlight = false;
      return;
    }
    cameraSocket.send(blob);
  }, 'image/jpeg', 0.65);
}

function stopCamera() {
  cameraRunning = false;
  frameInFlight = false;
  if (cameraSocket) {
    cameraSocket.onclose = null;
    if (cameraSocket.readyState === WebSocket.OPEN || cameraSocket.readyState === WebSocket.CONNECTING) cameraSocket.close();
    cameraSocket = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  cameraTracks = [];
  $('cameraStage').classList.remove('active');
  $('cameraStage').style.aspectRatio = '';
  $('cameraPlaceholder').hidden = false;
  $('liveLabel').hidden = true;
  $('startCamera').disabled = false;
  $('stopCamera').disabled = true;
  $('cameraFacing').disabled = false;
  $('cameraStatus').textContent = 'Kamera belum aktif';
  $('cameraStatus').className = 'pill neutral';
  $('cameraHelp').textContent = 'Kamera telah ditutup.';
  clearOverlay();
}
$('startCamera').addEventListener('click', startCamera);
$('stopCamera').addEventListener('click', stopCamera);
window.addEventListener('beforeunload', stopCamera);

$('photoInput').addEventListener('change', () => {
  const file = $('photoInput').files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    $('uploadHelp').textContent = 'Gunakan file JPG, PNG, atau WEBP.';
    $('photoInput').value = '';
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    $('uploadHelp').textContent = 'Ukuran foto melebihi batas 15 MB.';
    $('photoInput').value = '';
    return;
  }
  if (selectedObjectUrl) URL.revokeObjectURL(selectedObjectUrl);
  selectedObjectUrl = URL.createObjectURL(file);
  $('previewImage').src = selectedObjectUrl;
  $('selectedFileName').textContent = file.name;
  $('uploadPreview').hidden = false;
  $('uploadArea').hidden = true;
  $('analyzePhoto').disabled = false;
  $('uploadHelp').textContent = 'Foto siap dianalisis.';
});

$('removePhoto').addEventListener('click', () => {
  if (selectedObjectUrl) URL.revokeObjectURL(selectedObjectUrl);
  selectedObjectUrl = null;
  $('photoInput').value = '';
  $('previewImage').removeAttribute('src');
  $('uploadPreview').hidden = true;
  $('uploadArea').hidden = false;
  $('analyzePhoto').disabled = true;
  $('uploadHelp').textContent = 'Pilih foto untuk memulai pemeriksaan.';
});

$('analyzePhoto').addEventListener('click', async () => {
  const file = $('photoInput').files?.[0];
  if (!file) return;
  const button = $('analyzePhoto');
  button.disabled = true;
  button.textContent = 'Sedang menganalisis...';
  $('uploadHelp').textContent = 'Foto sedang dikirim ke model YOLO26.';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/api/detect`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Gagal memproses foto.');
    if (data.annotated_image) $('previewImage').src = data.annotated_image;
    updateSummary(data.detections || [], 'Analisis foto selesai');
    $('uploadHelp').textContent = `${data.total_objects} objek terdeteksi. Foto hasil deteksi ditampilkan di atas.`;
  } catch (error) {
    $('uploadHelp').textContent = 'Analisis gagal: ' + error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Analisis foto';
  }
});

checkBackend();
window.setInterval(checkBackend, 15000);
