/* MyTube — فيديوهات القنوات المشترك فيها فقط
   يعتمد على YouTube Data API v3 (OAuth) + Gemini API */
'use strict';

const LS = {
  settings: 'mytube.settings.v1',
  saved: 'mytube.saved.v1',
  watched: 'mytube.watched.v1',
  token: 'mytube.token.v1'
};

const state = {
  settings: loadJSON(LS.settings, {ytKey: '', clientId: '', geminiKey: ''}),
  token: loadJSON(LS.token, null),          // {access_token, expires_at}
  videos: [],
  channels: [],                             // [{id,title,thumb}]
  activeChannel: '',
  tab: 'feed',
  saved: loadJSON(LS.saved, []),
  watched: loadJSON(LS.watched, {}),
  current: null,
  player: null
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function setStatus(text, kind) {
  const s = $('#status');
  if (!text) { s.hidden = true; s.textContent = ''; return; }
  s.hidden = false;
  s.textContent = text;
  s.dataset.kind = kind || 'info';
}

/* ---------- Google OAuth (GIS token model) ---------- */

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
}

function validToken() {
  return state.token && state.token.access_token && state.token.expires_at > Date.now() + 30000
    ? state.token.access_token : '';
}

async function signIn() {
  const clientId = state.settings.clientId.trim();
  if (!clientId) {
    setStatus('أضف معرّف عميل OAuth من الإعدادات الأول.', 'warn');
    openSettings();
    return;
  }
  try {
    await loadGis();
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: 'consent',
      callback: (resp) => {
        if (resp.error) {
          setStatus('تعذر تسجيل الدخول: ' + resp.error, 'error');
          return;
        }
        state.token = {
          access_token: resp.access_token,
          expires_at: Date.now() + (resp.expires_in || 3600) * 1000
        };
        saveJSON(LS.token, state.token);
        renderAuth();
        loadFeed(true);
      }
    });
    client.requestAccessToken();
  } catch (e) {
    setStatus('مشكلة في تحميل تسجيل الدخول: ' + e.message, 'error');
  }
}

function signOut() {
  state.token = null;
  saveJSON(LS.token, null);
  state.videos = [];
  state.channels = [];
  renderAuth();
  renderGrid();
  renderChannels();
  setStatus('تم تسجيل الخروج. اربط الحساب من جديد لعرض فيديوهاتك.', 'info');
}

/* ---------- YouTube API ---------- */

async function yt(path, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const token = validToken();
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  else if (state.settings.ytKey) url.searchParams.set('key', state.settings.ytKey);
  else throw new Error('NO_KEYS');
  const res = await fetch(url, {headers});
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = res.status === 401 ? 'انتهت صلاحية الجلسة، اربط الحساب من جديد.'
      : res.status === 403 ? 'رفضت جوجل الطلب (حصة أو صلاحيات). راجع تفعيل YouTube Data API v3.'
      : 'خطأ من يوتيوب (' + res.status + ')';
    throw new Error(msg + (body ? ' — ' + body.slice(0, 140) : ''));
  }
  return res.json();
}

async function fetchSubscriptions() {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 4; i++) { // حتى 200 قناة
    const data = await yt('subscriptions', {
      part: 'snippet', mine: 'true', maxResults: 50, pageToken
    }, false);
    (data.items || []).forEach((it) => {
      out.push({
        id: it.snippet.resourceId.channelId,
        title: it.snippet.title,
        thumb: it.snippet.thumbnails?.default?.url || ''
      });
    });
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  out.sort((a, b) => a.title.localeCompare(b.title, 'ar'));
  return out;
}

async function fetchFeed() {
  // أنشطة الحساب = آخر فيديوهات القنوات المشترك فيها فقط
  const data = await yt('activities', {
    part: 'snippet,contentDetails', mine: 'true', maxResults: 50
  }, false);
  const videos = [];
  const seen = new Set();
  (data.items || []).forEach((it) => {
    const vid = it.contentDetails?.upload?.videoId;
    if (!vid || seen.has(vid)) return;
    seen.add(vid);
    videos.push({
      id: vid,
      title: it.snippet.title,
      channelId: it.snippet.channelId,
      channel: it.snippet.channelTitle,
      published: it.snippet.publishedAt,
      thumb: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '',
      desc: it.snippet.description || ''
    });
  });
  return videos;
}

async function enrichVideos(videos) {
  const ids = videos.map((v) => v.id).filter(Boolean);
  if (!ids.length) return videos;
  const data = await yt('videos', {
    part: 'contentDetails,statistics', id: ids.slice(0, 50).join(',')
  }, true);
  const map = new Map((data.items || []).map((it) => [it.id, it]));
  videos.forEach((v) => {
    const d = map.get(v.id);
    if (!d) return;
    v.duration = parseDuration(d.contentDetails?.duration || '');
    v.views = Number(d.statistics?.viewCount || 0);
  });
  return videos;
}

async function searchSubscribed(q) {
  const subIds = new Set(state.channels.map((c) => c.id));
  const data = await yt('search', {
    part: 'snippet', q, type: 'video', maxResults: 25, order: 'relevance'
  }, true);
  return (data.items || [])
    .filter((it) => subIds.has(it.snippet.channelId))
    .map((it) => ({
      id: it.id.videoId,
      title: it.snippet.title,
      channelId: it.snippet.channelId,
      channel: it.snippet.channelTitle,
      published: it.snippet.publishedAt,
      thumb: it.snippet.thumbnails?.medium?.url || '',
      desc: it.snippet.description || ''
    }));
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return '';
  const [, d, h, mi, s] = m.map((x) => (x ? parseInt(x, 10) : 0));
  const total = (d || 0) * 86400 + (h || 0) * 3600 + (mi || 0) * 60 + (s || 0);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(diff)) return '';
  if (diff < 3600) return 'منذ ' + Math.max(1, Math.round(diff / 60)) + ' دقيقة';
  if (diff < 86400) return 'منذ ' + Math.round(diff / 3600) + ' ساعة';
  if (diff < 2592000) return 'منذ ' + Math.round(diff / 86400) + ' يوم';
  if (diff < 31536000) return 'منذ ' + Math.round(diff / 2592000) + ' شهر';
  return 'منذ ' + Math.round(diff / 31536000) + ' سنة';
}

/* ---------- Rendering ---------- */

function renderAuth() {
  const signed = !!validToken();
  $('#authState').textContent = signed ? 'مرتبط — تظهر فيديوهات قنواتك فقط' : 'لم يتم الربط بعد';
  $('#signInBtn').classList.toggle('hidden', signed);
  $('#signOutBtn').classList.toggle('hidden', !signed);
}

function renderChips() {
  const wrap = $('#chips');
  wrap.textContent = '';
  const all = el('button', 'chip' + (state.activeChannel ? '' : ' active'), 'الكل');
  all.onclick = () => { state.activeChannel = ''; renderChips(); renderGrid(); };
  wrap.appendChild(all);
  const channels = state.channels.filter((c) => state.videos.some((v) => v.channelId === c.id)).slice(0, 12);
  channels.forEach((c) => {
    const b = el('button', 'chip' + (state.activeChannel === c.id ? ' active' : ''), c.title);
    b.onclick = () => { state.activeChannel = c.id; renderChips(); renderGrid(); };
    wrap.appendChild(b);
  });
}

function currentList() {
  if (state.tab === 'saved') {
    return state.saved.map((id) => state.videos.find((v) => v.id === id) || {id, title: 'فيديو محفوظ', channel: '', thumb: ''});
  }
  let list = state.videos;
  if (state.activeChannel) list = list.filter((v) => v.channelId === state.activeChannel);
  return list;
}

function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const list = currentList();
  $('#empty').hidden = list.length > 0;
  list.forEach((v) => grid.appendChild(videoCard(v)));
}

function videoCard(v) {
  const card = el('article', 'card');
  card.tabIndex = 0;

  const thumbWrap = el('div', 'thumb');
  if (v.thumb) {
    const img = new Image();
    img.src = v.thumb;
    img.alt = v.title;
    img.loading = 'lazy';
    thumbWrap.appendChild(img);
  }
  if (v.duration) thumbWrap.appendChild(el('span', 'duration', v.duration));
  if (state.watched[v.id]) thumbWrap.appendChild(el('span', 'watched-badge', 'تمت المشاهدة'));
  card.appendChild(thumbWrap);

  const meta = el('div', 'meta');
  meta.appendChild(el('h3', '', v.title));
  const sub = el('div', 'sub');
  sub.appendChild(el('span', 'channel', v.channel || '—'));
  if (v.published) sub.appendChild(el('span', '', '• ' + timeAgo(v.published)));
  if (v.views) sub.appendChild(el('span', '', '• ' + formatViews(v.views) + ' مشاهدة'));
  meta.appendChild(sub);
  card.appendChild(meta);

  const open = () => openPlayer(v);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return card;
}

function formatViews(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' مليون';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + ' ألف';
  return String(n);
}

function renderChannels() {
  const list = $('#channelList');
  list.textContent = '';
  if (!state.channels.length) {
    list.appendChild(el('li', 'side-note', 'اربط حساب Google لعرض القنوات.'));
    return;
  }
  state.channels.forEach((c) => {
    const li = el('li');
    const b = el('button', 'channel-btn');
    if (c.thumb) {
      const img = new Image();
      img.src = c.thumb; img.alt = ''; img.loading = 'lazy';
      b.appendChild(img);
    }
    b.appendChild(el('span', '', c.title));
    b.onclick = () => {
      state.tab = 'feed';
      state.activeChannel = c.id;
      renderTabs(); renderChips(); renderGrid();
      closeSidebar();
    };
    li.appendChild(b);
    list.appendChild(li);
  });
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
  });
}

/* ---------- Feed loading ---------- */

async function loadFeed(force) {
  if (!validToken()) {
    renderAuth();
    if (!state.settings.clientId || !state.settings.ytKey) {
      setStatus('أضف المفاتيح من الإعدادات ثم اربط حساب Google.', 'warn');
    } else {
      setStatus('اربط حساب Google لعرض فيديوهات قنواتك.', 'warn');
    }
    return;
  }
  setStatus('بأجيب آخر فيديوهات قنواتك…', 'info');
  try {
    if (force || !state.channels.length) state.channels = await fetchSubscriptions();
    const videos = await fetchFeed();
    await enrichVideos(videos).catch(() => videos);
    state.videos = videos;
    setStatus(videos.length ? 'آخر ' + videos.length + ' فيديو من قنواتك.' : 'مفيش فيديوهات جديدة من قنواتك حالياً.', 'ok');
    renderChips();
    renderGrid();
    renderChannels();
  } catch (e) {
    if (e.message === 'NO_TOKEN') {
      renderAuth();
      setStatus('اربط حساب Google من جديد.', 'warn');
    } else {
      setStatus('تعذر تحميل الفيديوهات: ' + e.message, 'error');
    }
  }
}

/* ---------- Player ---------- */

function openPlayer(v) {
  state.current = v;
  $('#playerTitle').textContent = v.title || 'فيديو';
  $('#playerMeta').textContent = [v.channel, v.published ? timeAgo(v.published) : '', v.views ? formatViews(v.views) + ' مشاهدة' : '']
    .filter(Boolean).join(' • ');
  $('#playerDesc').textContent = v.desc || '';
  $('#openYouTube').href = 'https://www.youtube.com/watch?v=' + v.id;
  $('#saveBtn').textContent = state.saved.includes(v.id) ? '★' : '☆';
  const frame = $('#playerFrame');
  frame.textContent = '';
  const iframe = document.createElement('iframe');
  iframe.src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?autoplay=1&rel=0&modestbranding=1';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.title = v.title || 'player';
  frame.appendChild(iframe);
  $('#playerOverlay').hidden = false;
  document.body.classList.add('locked');
  state.watched[v.id] = Date.now();
  saveJSON(LS.watched, state.watched);
}

function closePlayer() {
  $('#playerOverlay').hidden = true;
  $('#playerFrame').textContent = '';
  document.body.classList.remove('locked');
}

function toggleSave() {
  const v = state.current;
  if (!v) return;
  const i = state.saved.indexOf(v.id);
  if (i >= 0) state.saved.splice(i, 1); else state.saved.push(v.id);
  saveJSON(LS.saved, state.saved);
  $('#saveBtn').textContent = i >= 0 ? '☆' : '★';
  if (state.tab === 'saved') renderGrid();
}

/* ---------- Gemini ---------- */

function pushChat(role, text) {
  const log = $('#chatLog');
  const m = el('div', 'msg ' + role);
  m.textContent = text;
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
  return m;
}

async function askGemini(question, extra) {
  const key = state.settings.geminiKey.trim();
  if (!key) {
    pushChat('bot', 'أضف مفتاح Gemini من الإعدادات الأول.');
    return;
  }
  const contextVideos = (state.videos.length ? state.videos : currentList()).slice(0, 40)
    .map((v, i) => (i + 1) + ') ' + v.title + ' — ' + v.channel + (v.published ? ' — ' + timeAgo(v.published) : ''))
    .join('\n');
  const prompt = [
    'أنت مساعد داخل تطبيق MyTube يعرض فقط فيديوهات القنوات التي يشترك فيها المستخدم.',
    'ردّ بالعربية وباختصار وبشكل عملي.',
    contextVideos ? 'قائمة أحدث الفيديوهات المتاحة:\n' + contextVideos : 'لا توجد قائمة فيديوهات محمّلة.',
    extra ? 'سياق إضافي: ' + extra : '',
    'سؤال المستخدم: ' + question
  ].filter(Boolean).join('\n\n');

  const bubble = pushChat('bot', '…');
  try {
    const body = {contents: [{role: 'user', parts: [{text: prompt}]}]};
    let res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
    });
    if (!res.ok && res.status === 404) {
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
      });
    }
    if (!res.ok) throw new Error('خطأ ' + res.status);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('\n').trim();
    bubble.textContent = text || 'مفيش رد من Gemini.';
  } catch (e) {
    bubble.textContent = 'تعذر الوصول لـ Gemini: ' + e.message;
  }
}

/* ---------- Settings ---------- */

function openSettings() {
  $('#ytKey').value = state.settings.ytKey;
  $('#clientId').value = state.settings.clientId;
  $('#geminiKey').value = state.settings.geminiKey;
  $('#settingsModal').hidden = false;
}
function closeSettings() { $('#settingsModal').hidden = true; }

function saveSettings() {
  state.settings = {
    ytKey: $('#ytKey').value.trim(),
    clientId: $('#clientId').value.trim(),
    geminiKey: $('#geminiKey').value.trim()
  };
  saveJSON(LS.settings, state.settings);
  closeSettings();
  setStatus('تم حفظ الإعدادات على جهازك.', 'ok');
  if (validToken()) loadFeed(true);
}

/* ---------- Sidebar / drawers ---------- */

function toggleSidebar() { $('#sidebar').classList.toggle('open'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); }
function openGemini() { $('#geminiDrawer').hidden = false; }
function closeGemini() { $('#geminiDrawer').hidden = true; }

/* ---------- Events ---------- */

function wire() {
  $('#menuBtn').onclick = toggleSidebar;
  $('#brandLink').onclick = (e) => { e.preventDefault(); state.tab = 'feed'; state.activeChannel = ''; renderTabs(); renderChips(); renderGrid(); };
  $('#settingsBtn').onclick = openSettings;
  $('#closeSettings').onclick = closeSettings;
  $('#saveSettings').onclick = saveSettings;
  $('#signInBtn').onclick = signIn;
  $('#signOutBtn').onclick = signOut;
  $('#refreshBtn').onclick = () => loadFeed(true);
  $('#geminiBtn').onclick = openGemini;
  $('#closeGemini').onclick = closeGemini;
  $('#closePlayer').onclick = closePlayer;
  $('#saveBtn').onclick = toggleSave;
  $('#askGeminiAbout').onclick = () => {
    if (!state.current) return;
    openGemini();
    askGemini('لخّص لي هذا الفيديو وقلّي يستاهل أتفرج عليه ولا لأ، واقترح ٣ فيديوهات بديلة من القائمة.',
      'الفيديو: ' + state.current.title + ' — ' + (state.current.channel || ''));
  };
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const q = $('#chatInput').value.trim();
    if (!q) return;
    $('#chatInput').value = '';
    pushChat('user', q);
    askGemini(q);
  };
  $('#clearData').onclick = () => {
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
    state.settings = {ytKey: '', clientId: '', geminiKey: ''};
    state.token = null; state.videos = []; state.channels = []; state.saved = []; state.watched = {};
    renderAuth(); renderGrid(); renderChannels();
    closeSettings();
    setStatus('تم مسح البيانات المحلية.', 'ok');
  };
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      state.tab = t.dataset.tab;
      state.activeChannel = '';
      renderTabs(); renderChips(); renderGrid();
      if (state.tab === 'saved' && !state.saved.length) setStatus('لسه مفيش فيديوهات محفوظة — اضغط ☆ في المشغل.', 'info');
    };
  });
  $('#searchForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) { renderGrid(); return; }
    if (!validToken() || !state.channels.length) {
      setStatus('اربط حساب Google الأول للبحث في قنواتك.', 'warn');
      return;
    }
    setStatus('بأبحث في قنواتك عن «' + q + '»…', 'info');
    try {
      const found = await searchSubscribed(q);
      await enrichVideos(found).catch(() => found);
      state.tab = 'feed'; state.activeChannel = '';
      state.videos = found.length ? found : state.videos;
      renderTabs(); renderChips(); renderGrid();
      setStatus(found.length ? 'نتائج البحث داخل قنواتك.' : 'مفيش نتائج في القنوات المشترك فيها بس.', found.length ? 'ok' : 'warn');
    } catch (err) {
      setStatus('تعذر البحث: ' + err.message, 'error');
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePlayer(); closeSettings(); closeGemini(); closeSidebar(); }
  });
  window.addEventListener('mytube-open-settings', openSettings);
}

/* ---------- Boot ---------- */

function boot() {
  wire();
  $('#originHint').textContent = location.origin;
  renderAuth();
  renderTabs();
  renderChips();
  renderGrid();
  renderChannels();
  const missing = !state.settings.clientId || !state.settings.ytKey;
  if (missing) {
    setStatus('مرحباً! أضف مفاتيح YouTube وOAuth من الإعدادات (⚙️) واربط Google ليبدأ التطبيق.', 'warn');
  } else if (validToken()) {
    loadFeed(false);
  } else {
    setStatus('اضغط «ربط حساب Google» لعرض فيديوهات قنواتك المشترك فيها فقط.', 'info');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
