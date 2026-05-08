/**
 * Music Player – app.js
 * Features:
 *   • File upload + drag-and-drop (multiple audio formats)
 *   • Full playback controls: play/pause, next/prev, seek
 *   • Shuffle & repeat (off / one / all)
 *   • Volume control + mute
 *   • Playback speed selector
 *   • Web Audio API visualizer (frequency bars)
 *   • 10-band parametric equalizer
 *   • ID3 / metadata parsing for title, artist, album
 *   • Marquee animation for long titles
 *   • Keyboard shortcuts
 *   • localStorage persistence (volume, speed, eq, repeat, shuffle)
 *   • Toast notifications
 */

'use strict';

/* ─── Utility ─────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = s => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/* ─── State ───────────────────────────────────────────────── */
const state = {
  tracks: [],          // { name, artist, album, art, url, duration }
  current: -1,
  playing: false,
  shuffle: false,
  repeat: 'off',       // 'off' | 'one' | 'all'
  muted: false,
  volume: 1,
  speed: 1,
  vizVisible: true,
  eqVisible: false,
  shuffleHistory: [],
  audioCtx: null,
  analyser: null,
  gainNode: null,
  eqNodes: [],
  sourceNode: null,
  rafId: null,
};

/* ─── Audio element ───────────────────────────────────────── */
const audio = new Audio();
audio.preload = 'auto';

/* ─── DOM refs ────────────────────────────────────────────── */
const sidebar      = $('#sidebar');
const overlay      = (() => {
  const el = document.createElement('div');
  el.className = 'overlay';
  document.body.appendChild(el);
  return el;
})();
const openBtn      = $('#openSidebar');
const closeBtn     = $('#closeSidebar');
const uploadArea   = $('#uploadArea');
const fileInput    = $('#fileInput');
const driveUrlInput = $('#driveUrlInput');
const btnDriveImport = $('#btnDriveImport');
const playlist     = $('#playlist');
const vizWrap      = $('#vizWrap');
const canvas       = $('#visualizer');
const ctx2d        = canvas.getContext('2d');
const artworkWrap  = $('.artwork-wrap');
const artworkImg   = $('#artworkImg');
const artPlaceholder = $('.artwork-placeholder');
const trackTitle   = $('#trackTitle');
const trackArtist  = $('#trackArtist');
const trackAlbum   = $('#trackAlbum');
const currentTimeEl= $('#currentTime');
const totalTimeEl  = $('#totalTime');
const progressBar  = $('#progressBar');
const progressFill = $('#progressFill');
const progressThumb= $('#progressThumb');
const btnPlay      = $('#btnPlay');
const btnPrev      = $('#btnPrev');
const btnNext      = $('#btnNext');
const btnShuffle   = $('#btnShuffle');
const btnRepeat    = $('#btnRepeat');
const btnMute      = $('#btnMute');
const volumeSlider = $('#volumeSlider');
const speedSelect  = $('#speedSelect');
const toggleEqBtn  = $('#toggleEq');
const eqSection    = $('#eqSection');
const eqBands      = $('#eqBands');
const btnEqReset   = $('#btnEqReset');
const toast        = $('#toast');

/* ─── EQ band definitions ─────────────────────────────────── */
const EQ_BANDS = [
  { freq: 32,   label: '32' },
  { freq: 64,   label: '64' },
  { freq: 125,  label: '125' },
  { freq: 250,  label: '250' },
  { freq: 500,  label: '500' },
  { freq: 1000, label: '1k' },
  { freq: 2000, label: '2k' },
  { freq: 4000, label: '4k' },
  { freq: 8000, label: '8k' },
  { freq: 16000,label: '16k' },
];

/* ─── Persistence helpers ─────────────────────────────────── */
const ls = {
  get: (k, def) => { try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ─── Toast ───────────────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/* ─── Web Audio setup ─────────────────────────────────────── */
function initAudioContext() {
  if (state.audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  state.audioCtx = new AudioContext();

  /* Create 10-band EQ filter chain */
  state.eqNodes = EQ_BANDS.map(({ freq }) => {
    const f = state.audioCtx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = 1.2;
    f.gain.value = 0;
    return f;
  });

  /* Gain node for volume */
  state.gainNode = state.audioCtx.createGain();

  /* Analyser for visualizer */
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 256;

  /* Chain: source → EQ filters → gain → analyser → destination */
  state.sourceNode = state.audioCtx.createMediaElementSource(audio);

  let prev = state.sourceNode;
  for (const f of state.eqNodes) { prev.connect(f); prev = f; }
  prev.connect(state.gainNode);
  state.gainNode.connect(state.analyser);
  state.analyser.connect(state.audioCtx.destination);

  /* Apply saved EQ gains */
  const saved = ls.get('eq', null);
  if (saved && Array.isArray(saved)) {
    saved.forEach((g, i) => {
      if (state.eqNodes[i]) state.eqNodes[i].gain.value = g;
    });
  }
  updateEqUI();
}

/* ─── Build EQ sliders ────────────────────────────────────── */
function buildEqUI() {
  eqBands.innerHTML = '';
  EQ_BANDS.forEach(({ label }, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-band';

    const valEl = document.createElement('span');
    valEl.className = 'eq-val';
    valEl.id = `eqVal${i}`;
    valEl.textContent = '0dB';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-12';
    slider.max = '12';
    slider.step = '0.5';
    slider.value = '0';
    slider.id = `eqSlider${i}`;
    slider.addEventListener('input', () => {
      const g = parseFloat(slider.value);
      valEl.textContent = (g >= 0 ? '+' : '') + g + 'dB';
      if (state.eqNodes[i]) state.eqNodes[i].gain.value = g;
      saveEq();
    });

    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.htmlFor = slider.id;

    wrap.appendChild(valEl);
    wrap.appendChild(slider);
    wrap.appendChild(lbl);
    eqBands.appendChild(wrap);
  });
}

function updateEqUI() {
  EQ_BANDS.forEach((_, i) => {
    const slider = $(`#eqSlider${i}`);
    const valEl  = $(`#eqVal${i}`);
    if (!slider || !valEl) return;
    const g = state.eqNodes[i] ? state.eqNodes[i].gain.value : 0;
    slider.value = g;
    valEl.textContent = (g >= 0 ? '+' : '') + g + 'dB';
  });
}

function saveEq() {
  const gains = state.eqNodes.map(f => f.gain.value);
  ls.set('eq', gains);
}

/* ─── Visualizer ──────────────────────────────────────────── */
function drawVisualizer() {
  state.rafId = requestAnimationFrame(drawVisualizer);

  if (!state.analyser || vizWrap.classList.contains('hidden')) return;

  const W = canvas.width;
  const H = canvas.height;
  const bufLen = state.analyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  state.analyser.getByteFrequencyData(data);

  ctx2d.clearRect(0, 0, W, H);

  const barCount = Math.min(bufLen, 64);
  const barW = W / barCount - 1;

  for (let i = 0; i < barCount; i++) {
    const v = data[i] / 255;
    const h = v * H;
    const x = i * (barW + 1);
    const hue = 260 + v * 60;
    ctx2d.fillStyle = `hsl(${hue},80%,${50 + v * 30}%)`;
    ctx2d.beginPath();
    ctx2d.roundRect(x, H - h, barW, h, 3);
    ctx2d.fill();
  }
}

function resizeCanvas() {
  canvas.width  = vizWrap.clientWidth  || 400;
  canvas.height = vizWrap.clientHeight || 100;
}

/* ─── File handling ───────────────────────────────────────── */
async function loadFiles(files) {
  const added = [];
  for (const file of files) {
    if (!isAudioFile(file)) continue;
    const url = URL.createObjectURL(file);
    const meta = await readMeta(file);
    const track = {
      name:     meta.title  || stripExt(file.name),
      artist:   meta.artist || '不明なアーティスト',
      album:    meta.album  || '',
      art:      meta.art    || null,
      url,
      duration: 0,
      file,
    };
    state.tracks.push(track);
    added.push(track);
  }
  if (added.length === 0) {
    showToast('取り込み可能な音声ファイルがありません');
    return;
  }
  renderPlaylist();
  if (state.current === -1) {
    selectTrack(0);
  }
  showToast(`${added.length}曲追加しました`);
}

function extractGoogleDriveFileId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^(drive|docs)\.google\.com$/i.test(url.hostname)) return null;

    const idFromQuery = url.searchParams.get('id');
    if (idFromQuery) return idFromQuery;

    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch) return fileMatch[1];

    const dMatch = url.pathname.match(/\/d\/([^/]+)/);
    if (dMatch) return dMatch[1];

    return null;
  } catch {
    return null;
  }
}

function pickAudioExtension(mimeType) {
  const map = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
  };
  return map[mimeType?.toLowerCase()] || '';
}

function extractFileNameFromContentDisposition(header) {
  if (!header) return '';
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].replace(/["']/g, ''));
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

function isAudioByName(name) {
  return /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)$/i.test(name || '');
}

function isAudioFile(file) {
  return file.type.startsWith('audio/') || isAudioByName(file.name);
}

function updateDriveImportButton(isLoading) {
  btnDriveImport.disabled = isLoading;
  if (driveUrlInput) driveUrlInput.disabled = isLoading;
  btnDriveImport.textContent = isLoading ? '取込中...' : 'Drive取込';
}

async function importFromGoogleDrive(rawUrl) {
  const fileId = extractGoogleDriveFileId(rawUrl);
  if (!fileId) {
    showToast('drive.google.com / docs.google.com の共有URLを入力してください');
    return;
  }

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  updateDriveImportButton(true);

  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`download failed (${res.status})`);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const contentDisposition = res.headers.get('content-disposition') || '';
    const headerFileName = extractFileNameFromContentDisposition(contentDisposition);
    const fallbackExt = pickAudioExtension(contentType);
    const fileName = headerFileName || `google-drive-${fileId}${fallbackExt}`;

    const blob = await res.blob();
    const looksAudio = contentType.startsWith('audio/') || blob.type.startsWith('audio/') || isAudioByName(fileName);
    if (!looksAudio) {
      throw new Error(`unsupported non-audio file (${contentType || 'unknown'})`);
    }

    const file = new File([blob], fileName, {
      type: blob.type || contentType || 'audio/mpeg',
    });
    initAudioContext();
    await loadFiles([file]);
    openSidebar();
    if (driveUrlInput) driveUrlInput.value = '';
  } catch (error) {
    console.error('Google Drive import failed:', error);
    const msg = String(error?.message || '');
    if (msg.includes('unsupported non-audio file')) {
      showToast('音声ファイルのみ取り込みできます');
    } else if (msg.includes('download failed (403)')) {
      showToast('Google Driveの共有設定を確認してください（403）');
    } else if (msg.includes('download failed (404)')) {
      showToast('ファイルが見つかりません（404）');
    } else if (msg.includes('Failed to fetch')) {
      showToast('通信エラーが発生しました。ネットワークを確認してください');
    } else {
      showToast('Google Driveからの取り込みに失敗しました（URL/公開設定/通信を確認してください）');
    }
  } finally {
    updateDriveImportButton(false);
  }
}

/* Minimal ID3v2 / metadata reader using FileReader */
async function readMeta(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const buf = e.target.result;
      const bytes = new Uint8Array(buf);
      const meta = parseID3(bytes);
      resolve(meta);
    };
    reader.onerror = () => resolve({});
    /* read first 256KB for metadata */
    reader.readAsArrayBuffer(file.slice(0, 262144));
  });
}

/* Very small ID3v2.3/v2.4 parser for title/artist/album/cover */
function parseID3(bytes) {
  const meta = {};
  /* Check ID3 header: "ID3" */
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return meta;
  const version = bytes[3]; // 2, 3, or 4
  const flags   = bytes[5];
  let size = syncsafe(bytes, 6);

  /* Extended header */
  let pos = 10;
  if (flags & 0x40) {
    const extSize = version === 4 ? syncsafe(bytes, pos) : readUint32(bytes, pos);
    pos += extSize;
  }

  const end = 10 + size;
  while (pos < end - 10) {
    /* Frame ID: 4 bytes for ID3v2.3/2.4, 3 bytes for ID3v2.2 */
    const frameId = version === 2
      ? String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2])
      : String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    const headerLen = version === 2 ? 6 : 10;
    const frameSize = version === 2
      ? (bytes[pos+3] << 16) | (bytes[pos+4] << 8) | bytes[pos+5]
      : version === 4
        ? syncsafe(bytes, pos + 4)
        : readUint32(bytes, pos + 4);
    if (frameSize === 0) { pos++; continue; }
    const dataStart = pos + headerLen;
    const dataEnd   = dataStart + frameSize;

    if (dataEnd > bytes.length) break;

    const isTitle  = frameId === 'TIT2' || frameId === 'TT2';
    const isArtist = frameId === 'TPE1' || frameId === 'TP1';
    const isAlbum  = frameId === 'TALB' || frameId === 'TAL';
    const isCover  = frameId === 'APIC' || frameId === 'PIC';

    if (isTitle || isArtist || isAlbum) {
      const enc  = bytes[dataStart];
      const text = decodeFrame(bytes.slice(dataStart + 1, dataEnd), enc);
      if (isTitle)  meta.title  = text;
      if (isArtist) meta.artist = text;
      if (isAlbum)  meta.album  = text;
    } else if (isCover && !meta.art) {
      /* APIC: encoding(1) + mimeType(null-terminated) + pictureType(1) + desc(null-terminated) + data */
      let p = dataStart + 1;
      while (p < dataEnd && bytes[p] !== 0) p++;
      p++; /* skip null */
      p++; /* skip picture type */
      while (p < dataEnd && bytes[p] !== 0) p++;
      p++; /* skip null */
      const imgBytes = bytes.slice(p, dataEnd);
      const blob = new Blob([imgBytes]);
      meta.art = URL.createObjectURL(blob);
    }

    pos += headerLen + frameSize;
  }
  return meta;
}

function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) |
         ((bytes[offset+1] & 0x7f) << 14) |
         ((bytes[offset+2] & 0x7f) << 7) |
          (bytes[offset+3] & 0x7f);
}

function readUint32(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset+1] << 16) |
         (bytes[offset+2] << 8) | bytes[offset+3];
}

function decodeFrame(bytes, enc) {
  try {
    if (enc === 0) {
      /* ISO-8859-1 */
      return [...bytes].map(b => String.fromCharCode(b)).join('').replace(/\0/g, '');
    }
    if (enc === 1 || enc === 2) {
      /* UTF-16 (with or without BOM) */
      return new TextDecoder('utf-16').decode(bytes).replace(/\0/g, '');
    }
    /* UTF-8 */
    return new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '');
  } catch {
    return '';
  }
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

/* ─── Playlist rendering ──────────────────────────────────── */
function renderPlaylist() {
  playlist.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'playlist-item' + (i === state.current ? ' active' : '');
    li.dataset.index = i;

    const num = document.createElement('span');
    num.className = 'item-num';
    num.textContent = i + 1;

    const info = document.createElement('div');
    info.className = 'item-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'item-name';
    nameEl.textContent = t.name;

    const durEl = document.createElement('div');
    durEl.className = 'item-dur';
    durEl.textContent = t.duration ? fmt(t.duration) : '—';

    const delBtn = document.createElement('button');
    delBtn.className = 'item-del';
    delBtn.title = '削除';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeTrack(i);
    });

    info.appendChild(nameEl);
    info.appendChild(durEl);
    li.appendChild(num);
    li.appendChild(info);
    li.appendChild(delBtn);

    li.addEventListener('click', () => {
      selectTrack(i);
      play();
    });

    playlist.appendChild(li);
  });
}

function updatePlaylistActive() {
  $$('.playlist-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.index) === state.current);
  });
}

function removeTrack(index) {
  const track = state.tracks[index];
  if (!track) return;
  cleanupTrackResources(track);
  state.tracks.splice(index, 1);

  if (state.current === index) {
    audio.pause();
    state.playing = false;
    if (state.tracks.length > 0) {
      selectTrack(Math.min(index, state.tracks.length - 1));
    } else {
      resetPlayer();
    }
  } else if (state.current > index) {
    state.current--;
  }
  renderPlaylist();
}

function cleanupTrackResources(track) {
  if (track.url && track.url.startsWith('blob:')) {
    URL.revokeObjectURL(track.url);
  }
  if (track.art && track.art.startsWith('blob:')) {
    URL.revokeObjectURL(track.art);
  }
}

/* ─── Track selection ─────────────────────────────────────── */
function selectTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;
  state.current = index;
  const t = state.tracks[index];

  audio.src = t.url;
  audio.playbackRate = state.speed;
  audio.volume = state.muted ? 0 : state.volume;

  /* UI */
  setTitle(t.name);
  trackArtist.textContent = t.artist || '—';
  trackAlbum.textContent  = t.album  || '';

  if (t.art) {
    artworkImg.src = t.art;
    artworkImg.hidden = false;
    artPlaceholder.style.display = 'none';
  } else {
    artworkImg.hidden = true;
    artworkImg.src = '';
    artPlaceholder.style.display = '';
  }

  progressFill.style.width  = '0%';
  progressThumb.style.left  = '0%';
  currentTimeEl.textContent = '0:00';
  totalTimeEl.textContent   = t.duration ? fmt(t.duration) : '0:00';

  updatePlaylistActive();
  scrollPlaylistToActive();
}

function setTitle(name) {
  trackTitle.textContent = name;
  trackTitle.classList.remove('scrolling');
  /* Trigger reflow then check if text overflows */
  requestAnimationFrame(() => {
    if (trackTitle.scrollWidth > trackTitle.parentElement.clientWidth) {
      trackTitle.classList.add('scrolling');
    }
  });
}

function scrollPlaylistToActive() {
  const active = $('.playlist-item.active', playlist);
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ─── Playback ────────────────────────────────────────────── */
function play() {
  if (state.current === -1) return;
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
  audio.play().catch(() => {});
}

function pause() {
  audio.pause();
}

function togglePlay() {
  if (state.current === -1) {
    if (state.tracks.length > 0) { selectTrack(0); play(); }
    return;
  }
  state.playing ? pause() : play();
}

function nextTrack() {
  if (state.tracks.length === 0) return;
  if (state.shuffle) {
    const idx = randomExcluding(state.current, state.tracks.length);
    state.shuffleHistory.push(state.current);
    selectTrack(idx);
  } else {
    const next = (state.current + 1) % state.tracks.length;
    selectTrack(next);
  }
  play();
}

function prevTrack() {
  if (state.tracks.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (state.shuffle && state.shuffleHistory.length > 0) {
    selectTrack(state.shuffleHistory.pop());
  } else {
    const prev = (state.current - 1 + state.tracks.length) % state.tracks.length;
    selectTrack(prev);
  }
  play();
}

function randomExcluding(current, len) {
  if (len <= 1) return current;
  let r;
  do { r = Math.floor(Math.random() * len); } while (r === current);
  return r;
}

function resetPlayer() {
  state.current = -1;
  state.playing = false;
  audio.src = '';
  setTitle('曲を選んでください');
  trackArtist.textContent = '—';
  trackAlbum.textContent  = '';
  artworkImg.hidden = true;
  artPlaceholder.style.display = '';
  progressFill.style.width = '0%';
  progressThumb.style.left = '0%';
  currentTimeEl.textContent = '0:00';
  totalTimeEl.textContent   = '0:00';
  btnPlay.textContent = '▶';
  artworkWrap.classList.remove('playing');
}

/* ─── Audio event handlers ────────────────────────────────── */
audio.addEventListener('play', () => {
  state.playing = true;
  btnPlay.textContent = '⏸';
  artworkWrap.classList.add('playing');
});

audio.addEventListener('pause', () => {
  state.playing = false;
  btnPlay.textContent = '▶';
  artworkWrap.classList.remove('playing');
});

audio.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    play();
  } else if (state.repeat === 'all' || state.current < state.tracks.length - 1 || state.shuffle) {
    nextTrack();
  } else {
    state.playing = false;
    btnPlay.textContent = '▶';
    artworkWrap.classList.remove('playing');
  }
});

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  progressFill.style.width  = pct + '%';
  progressThumb.style.left  = pct + '%';
  currentTimeEl.textContent = fmt(audio.currentTime);
});

audio.addEventListener('loadedmetadata', () => {
  totalTimeEl.textContent = fmt(audio.duration);
  if (state.current >= 0) {
    state.tracks[state.current].duration = audio.duration;
    /* Update duration in playlist */
    const items = $$('.playlist-item');
    const el = items[state.current];
    if (el) el.querySelector('.item-dur').textContent = fmt(audio.duration);
  }
});

audio.addEventListener('error', () => {
  showToast('再生エラーが発生しました');
});

/* ─── Progress bar seeking ────────────────────────────────── */
let seeking = false;

function seek(e) {
  const rect = progressBar.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audio.duration) {
    audio.currentTime = pct * audio.duration;
  }
}

progressBar.addEventListener('mousedown', e => { seeking = true; seek(e); });
document.addEventListener('mousemove', e => { if (seeking) seek(e); });
document.addEventListener('mouseup', () => { seeking = false; });

progressBar.addEventListener('touchstart', e => {
  seeking = true;
  seek(e.touches[0]);
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (seeking) seek(e.touches[0]);
}, { passive: true });
document.addEventListener('touchend', () => { seeking = false; });

/* ─── Volume ──────────────────────────────────────────────── */
function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  if (!state.muted) audio.volume = state.volume;
  volumeSlider.value = state.volume;
  updateMuteIcon();
  ls.set('volume', state.volume);
  if (state.gainNode) state.gainNode.gain.value = state.muted ? 0 : state.volume;
}

function toggleMute() {
  state.muted = !state.muted;
  audio.volume = state.muted ? 0 : state.volume;
  if (state.gainNode) state.gainNode.gain.value = state.muted ? 0 : state.volume;
  updateMuteIcon();
  showToast(state.muted ? 'ミュート' : 'ミュート解除');
}

function updateMuteIcon() {
  if (state.muted || state.volume === 0) {
    btnMute.textContent = '🔇';
  } else if (state.volume < 0.4) {
    btnMute.textContent = '🔉';
  } else {
    btnMute.textContent = '🔊';
  }
}

volumeSlider.addEventListener('input', () => setVolume(parseFloat(volumeSlider.value)));
btnMute.addEventListener('click', toggleMute);

/* ─── Speed ───────────────────────────────────────────────── */
speedSelect.addEventListener('change', () => {
  state.speed = parseFloat(speedSelect.value);
  audio.playbackRate = state.speed;
  ls.set('speed', state.speed);
  showToast(`再生速度: ${state.speed}×`);
});

/* ─── Shuffle ─────────────────────────────────────────────── */
btnShuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  btnShuffle.classList.toggle('active', state.shuffle);
  state.shuffleHistory = [];
  ls.set('shuffle', state.shuffle);
  showToast(state.shuffle ? 'シャッフル ON' : 'シャッフル OFF');
});

/* ─── Repeat ──────────────────────────────────────────────── */
const REPEAT_MODES = ['off', 'all', 'one'];
const REPEAT_ICONS = { off: '🔁', all: '🔁', one: '🔂' };
const REPEAT_LABELS = { off: 'リピートなし', all: '全曲リピート', one: '1曲リピート' };

btnRepeat.addEventListener('click', () => {
  const idx = REPEAT_MODES.indexOf(state.repeat);
  state.repeat = REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
  btnRepeat.textContent = REPEAT_ICONS[state.repeat];
  btnRepeat.classList.toggle('active', state.repeat !== 'off');
  ls.set('repeat', state.repeat);
  showToast(REPEAT_LABELS[state.repeat]);
});

/* ─── Main control buttons ────────────────────────────────── */
btnPlay.addEventListener('click', () => {
  initAudioContext();
  togglePlay();
});
btnPrev.addEventListener('click', prevTrack);
btnNext.addEventListener('click', nextTrack);

/* ─── Visualizer toggle ───────────────────────────────────── */
$('#toggleEq').addEventListener('click', () => {
  state.vizVisible = !state.vizVisible;
  vizWrap.classList.toggle('hidden', !state.vizVisible);
  ls.set('vizVisible', state.vizVisible);
});

/* ─── EQ toggle ───────────────────────────────────────────── */
/* Reuse the same button to toggle the EQ panel */
/* (button id is toggleEq but we wire a separate eq toggle via topbar) */
/* Actually #toggleEq toggles visualizer; EQ panel toggled from its own location */
/* Let's make the EQ accessible via the EQ section heading click */
const eqTitleEl = $('.eq-title');
if (eqTitleEl) {
  eqTitleEl.style.cursor = 'pointer';
}

/* Small tweak: add a dedicated EQ button to topbar on the right side */
/* We use the existing #toggleEq for visualizer already, so let's just
   add a separate button programmatically */
(function addEqToggleButton() {
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.id = 'btnEqToggle';
  btn.title = 'イコライザー (E)';
  btn.textContent = '🎚';
  btn.addEventListener('click', () => {
    state.eqVisible = !state.eqVisible;
    eqSection.classList.toggle('visible', state.eqVisible);
    btn.classList.toggle('active', state.eqVisible);
    if (state.eqVisible) initAudioContext();
  });
  /* Insert between toggleEq and end of topbar */
  const topbar = $('.topbar');
  topbar.insertBefore(btn, toggleEqBtn);
})();

/* ─── EQ reset ────────────────────────────────────────────── */
btnEqReset.addEventListener('click', () => {
  state.eqNodes.forEach(f => { f.gain.value = 0; });
  updateEqUI();
  saveEq();
  showToast('EQをリセットしました');
});

/* ─── Sidebar ─────────────────────────────────────────────── */
function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('visible');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('visible');
}
openBtn.addEventListener('click', openSidebar);
closeBtn.addEventListener('click', closeSidebar);
overlay.addEventListener('click', closeSidebar);

/* ─── File upload ─────────────────────────────────────────── */
fileInput.addEventListener('change', e => {
  initAudioContext();
  loadFiles(e.target.files);
  fileInput.value = '';
});

async function submitDriveImport() {
  const url = (driveUrlInput?.value || '').trim();
  if (!url) {
    showToast('Google Driveの共有URLを入力してください');
    driveUrlInput?.focus();
    return;
  }
  await importFromGoogleDrive(url);
}

btnDriveImport.addEventListener('click', submitDriveImport);
driveUrlInput?.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitDriveImport();
});

uploadArea.addEventListener('dragover', e => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  initAudioContext();
  loadFiles(e.dataTransfer.files);
});

/* Drag-and-drop onto the whole page */
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    initAudioContext();
    openSidebar();
    loadFiles(files);
  }
});

/* ─── Keyboard shortcuts ──────────────────────────────────── */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      initAudioContext();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      nextTrack();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      prevTrack();
      break;
    case 'ArrowUp':
      e.preventDefault();
      setVolume(state.volume + 0.05);
      showToast(`音量: ${Math.round(state.volume * 100)}%`);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setVolume(state.volume - 0.05);
      showToast(`音量: ${Math.round(state.volume * 100)}%`);
      break;
    case 'KeyM':
      toggleMute();
      break;
    case 'KeyS':
      btnShuffle.click();
      break;
    case 'KeyR':
      btnRepeat.click();
      break;
    case 'KeyE': {
      const eqBtn = document.querySelector('#btnEqToggle');
      if (eqBtn) eqBtn.click();
      break;
    }
  }
});

/* ─── Resize canvas ───────────────────────────────────────── */
const ro = new ResizeObserver(resizeCanvas);
ro.observe(vizWrap);
resizeCanvas();

/* ─── Restore preferences ─────────────────────────────────── */
function restorePrefs() {
  /* Volume */
  const vol = ls.get('volume', 1);
  setVolume(vol);

  /* Speed */
  const spd = ls.get('speed', 1);
  state.speed = spd;
  audio.playbackRate = spd;
  speedSelect.value = String(spd);

  /* Shuffle */
  state.shuffle = ls.get('shuffle', false);
  btnShuffle.classList.toggle('active', state.shuffle);

  /* Repeat */
  const rep = ls.get('repeat', 'off');
  state.repeat = REPEAT_MODES.includes(rep) ? rep : 'off';
  btnRepeat.textContent = REPEAT_ICONS[state.repeat];
  btnRepeat.classList.toggle('active', state.repeat !== 'off');

  /* Visualizer */
  const viz = ls.get('vizVisible', true);
  state.vizVisible = viz;
  vizWrap.classList.toggle('hidden', !viz);
}

/* ─── Init ────────────────────────────────────────────────── */
buildEqUI();
restorePrefs();
drawVisualizer();
