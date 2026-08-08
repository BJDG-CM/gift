import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { LocalNotifications } from '@capacitor/local-notifications';
import { TIER_META, TIER_OPTIONS, buildScheduleDates, daysUntilExpiryOn } from './notification-schedule.mjs';

const isNative = Capacitor.isNativePlatform();
const isAndroid = Capacitor.getPlatform() === 'android';

/* ---------------- storage ---------------- */
const ITEMS_KEY = 'gk_items_v1';
const SETTINGS_KEY = 'gk_settings_v1';

const CATEGORIES = ['카페', '편의점', '치킨', '디저트', '뷰티', '기타'];

const THEMES = [
  ['#FF7E5F', '#FFEBE3', '#E2542F'],
  ['#F79256', '#FDE9D6', '#C86A2B'],
  ['#F58EA3', '#FCE3E9', '#C65B72'],
  ['#E8896B', '#F7E4DC', '#B65538']
];

function defaultSettings() {
  return {
    viewMode: 'list',
    theme: 0,
    notifyTime: '10:00',
    tiers: { t1: 'monthly', t2: 'weekly', t3: 'daily' },
    nextNotifBase: 1000
  };
}

function loadItems() {
  try { return JSON.parse(localStorage.getItem(ITEMS_KEY)) || []; }
  catch { return []; }
}
function saveItems(items) { localStorage.setItem(ITEMS_KEY, JSON.stringify(items)); }

function loadSettings() {
  try { return { ...defaultSettings(), ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
  catch { return defaultSettings(); }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

let items = loadItems();
let settings = loadSettings();

/* ---------------- date helpers ---------------- */
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function daysLeft(dateStr) {
  const exp = new Date(dateStr + 'T00:00:00');
  return Math.round((exp - todayMidnight()) / 86400000);
}
function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}.${m}.${d}`;
}
function urgencyClass(dl) {
  if (dl <= 3) return 'urgent';
  if (dl <= 14) return 'soon';
  return 'ok';
}
function ddayLabel(dl) {
  if (dl < 0) return '만료';
  if (dl === 0) return 'D-day';
  return `D-${dl}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- theme ---------------- */
function applyTheme() {
  const [a, soft, ink] = THEMES[settings.theme] || THEMES[0];
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-soft', soft);
  document.documentElement.style.setProperty('--accent-ink', ink);
}

/* ---------------- derived data ---------------- */
function activeItems() { return items.filter(i => i.status === 'active'); }
function sortedActive() {
  return activeItems().slice().sort((a, b) => daysLeft(a.expiry) - daysLeft(b.expiry));
}
function expiringSoonCount(maxDays) {
  return activeItems().filter(i => daysLeft(i.expiry) <= maxDays && daysLeft(i.expiry) >= 0).length;
}

/* ---------------- image helper ---------------- */
function compressImage(dataUrl, maxDim = 900, quality = 0.72) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function pickPhoto() {
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      quality: 80,
      promptLabelHeader: '사진 추가',
      promptLabelPhoto: '앨범에서 선택',
      promptLabelPicture: '사진 촬영'
    });
    return await compressImage(photo.dataUrl);
  } catch (e) {
    return null;
  }
}

/* ---------------- notifications ---------------- */
const NOTIFICATION_CHANNEL_ID = 'gift-expiry-v2';
const TEST_NOTIFICATION_ID = 999;
let notificationState = {
  kind: isNative ? 'checking' : 'web',
  message: isNative ? '알림 상태를 확인하고 있어요.' : '알림 상태는 Android 앱에서 확인할 수 있어요.',
  permission: 'unknown',
  exactAlarm: 'unknown',
  scheduled: 0
};
let rescheduleQueue = Promise.resolve();

async function ensureNotifPermission() {
  if (!isNative) return true;
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return true;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === 'granted';
}

async function ensureNotificationChannel() {
  if (!isAndroid) return;
  await LocalNotifications.createChannel({
    id: NOTIFICATION_CHANNEL_ID,
    name: '기프티콘 만료 알림',
    description: '등록한 기프티콘의 만료일을 미리 알려드려요.',
    importance: 4,
    visibility: 1,
    vibration: true
  });
}

function refreshNotificationStatus() {
  const status = app?.querySelector('#notificationStatusText');
  if (status) status.textContent = notificationState.message;
  const card = app?.querySelector('#notificationStatusCard');
  if (card) card.dataset.kind = notificationState.kind;
}

async function performReschedule() {
  if (!isNative) return;
  notificationState = { ...notificationState, kind: 'checking', message: '알림을 다시 예약하고 있어요.' };
  refreshNotificationStatus();

  try {
    const cancelIds = [];
    for (const it of items) {
      if (it.notifBase == null) continue;
      for (let i = 0; i < 40; i++) cancelIds.push({ id: it.notifBase + i });
    }
    if (cancelIds.length) await LocalNotifications.cancel({ notifications: cancelIds });

    const permitted = await ensureNotifPermission();
    if (!permitted) {
      notificationState = {
        kind: 'blocked',
        message: '알림 권한이 꺼져 있어요. 아래 버튼을 눌러 권한을 허용해 주세요.',
        permission: 'denied',
        exactAlarm: 'unknown',
        scheduled: 0
      };
      return;
    }

    await ensureNotificationChannel();

    const toSchedule = [];
    for (const it of activeItems()) {
      if (it.notifBase == null) {
        it.notifBase = settings.nextNotifBase;
        settings.nextNotifBase += 40;
      }
      if (daysLeft(it.expiry) < 0) continue;
      const dates = buildScheduleDates(it.expiry, settings.tiers, settings.notifyTime);
      dates.forEach((date, idx) => {
        const scheduledDaysLeft = daysUntilExpiryOn(it.expiry, date);
        toSchedule.push({
          id: it.notifBase + idx,
          title: '기프티콘 만료 임박',
          body: `${it.brand ? it.brand + ' · ' : ''}${it.name} — ${ddayLabel(scheduledDaysLeft)} (${fmtDate(it.expiry)}까지)`,
          channelId: NOTIFICATION_CHANNEL_ID,
          schedule: { at: date, allowWhileIdle: true }
        });
      });
    }
    saveSettings(settings);
    saveItems(items);
    if (toSchedule.length) await LocalNotifications.schedule({ notifications: toSchedule });

    const exactAlarm = isAndroid
      ? (await LocalNotifications.checkExactNotificationSetting()).exact_alarm
      : 'granted';
    const pending = await LocalNotifications.getPending();
    const scheduledIds = new Set(toSchedule.map(notification => notification.id));
    const scheduled = pending.notifications.filter(notification => scheduledIds.has(notification.id)).length;
    const timingNote = exactAlarm === 'granted' ? '' : ' 정확 알람 권한을 켜면 절전 중에도 더 정확해요.';
    notificationState = {
      kind: exactAlarm === 'granted' ? 'ready' : 'warning',
      message: scheduled > 0 ? `정상 · ${scheduled}개 예약됨.${timingNote}` : `알림 권한 정상 · 예약할 알림이 없어요.${timingNote}`,
      permission: 'granted',
      exactAlarm,
      scheduled
    };
  } catch (error) {
    console.error('Failed to reschedule notifications', error);
    notificationState = {
      ...notificationState,
      kind: 'error',
      message: `알림 예약 실패: ${error?.message || '알 수 없는 오류'}`,
      scheduled: 0
    };
  } finally {
    refreshNotificationStatus();
  }
}

function rescheduleAll() {
  rescheduleQueue = rescheduleQueue.then(performReschedule, performReschedule);
  return rescheduleQueue;
}

async function sendTestNotification() {
  const permitted = await ensureNotifPermission();
  if (!permitted) throw new Error('알림 권한이 필요해요.');
  await ensureNotificationChannel();
  await LocalNotifications.schedule({
    notifications: [{
      id: TEST_NOTIFICATION_ID,
      title: '알림 테스트 완료',
      body: '기프티콘 만료 알림이 정상적으로 표시돼요.',
      channelId: NOTIFICATION_CHANNEL_ID
    }]
  });
}

/* ---------------- router ---------------- */
function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, arg] = hash.split('/');
  return { name: name || 'home', arg };
}
window.addEventListener('hashchange', render);

function go(path) { location.hash = path; }

/* ---------------- rendering ---------------- */
const app = document.getElementById('app');

function render() {
  applyTheme();
  const { name, arg } = currentRoute();
  let html = '';
  let showNav = true;
  if (name === 'home') html = renderHome();
  else if (name === 'urgent') html = renderUrgent();
  else if (name === 'add') { html = renderAdd(); showNav = false; }
  else if (name === 'detail') { html = renderDetail(arg); showNav = false; }
  else if (name === 'archive') html = renderArchive();
  else if (name === 'settings') html = renderSettings();
  else if (name === 'present') { html = renderPresent(arg); showNav = false; }
  else html = renderHome();

  app.innerHTML = `<div class="screen">${html}</div>${showNav ? renderNav(name) : ''}`;
  attachHandlers(name, arg);
}

function renderNav(active) {
  const items = [
    { key: 'home', icon: '🏠', label: '홈' },
    { key: 'urgent', icon: '⏰', label: '임박' },
    { key: 'fab', icon: '+', label: '' },
    { key: 'archive', icon: '🗂️', label: '보관함' },
    { key: 'settings', icon: '⚙️', label: '설정' }
  ];
  return `<div class="bottom-nav">
    ${items.map(it => {
      if (it.key === 'fab') return `<button class="nav-fab" data-nav="add">+</button>`;
      return `<button class="nav-item ${active === it.key ? 'active' : ''}" data-nav="${it.key}">
        <span class="ic">${it.icon}</span>${it.label}
      </button>`;
    }).join('')}
  </div>`;
}

/* ---- home ---- */
function renderHome() {
  const list = sortedActive();
  const soonCount = expiringSoonCount(3);
  const name = escapeHtml(settings.userName || '');
  const banner = soonCount > 0 ? `
    <button class="alert-banner" data-nav="urgent" style="border:none;width:calc(100% - 40px);">
      <span class="badge">${soonCount}</span>
      <div style="flex:1;text-align:left;">
        <div class="t1">3일 안에 만료되는 게 ${soonCount}개 있어요</div>
        <div class="t2">지금 확인하고 사용하세요</div>
      </div>
      <span class="chev">›</span>
    </button>` : '';

  let body;
  if (list.length === 0) {
    body = `<div class="empty-state">
      <div class="e-icon">🎁</div>
      <div class="e-title">등록된 기프티콘이 없어요</div>
      <div class="e-sub">+ 버튼을 눌러 첫 기프티콘을 등록해보세요</div>
    </div>`;
  } else if (settings.viewMode === 'grid') {
    body = `<div class="item-grid" style="margin-top:14px;">${list.map(gridCard).join('')}</div>`;
  } else {
    const groups = [
      { label: '곧 만료돼요', dot: '#ED5E4C', color: '#C13F2E', test: dl => dl <= 7 },
      { label: '이번 달 안에', dot: '#E0982F', color: '#B87A1E', test: dl => dl > 7 && dl <= 30 },
      { label: '여유 있어요', dot: '#5FA97E', color: '#3F8F5F', test: dl => dl > 30 }
    ];
    body = groups.map(g => {
      const rows = list.filter(it => g.test(daysLeft(it.expiry)));
      if (!rows.length) return '';
      return `<div class="group-label"><span class="dot" style="background:${g.dot};"></span><span class="txt" style="color:${g.color};">${g.label}</span></div>
        <div class="item-list">${rows.map(listRow).join('')}</div>`;
    }).join('');
  }

  return `<div class="topbar">
      <div><div class="greet">안녕하세요 👋</div><h1>내 기프티콘 <span>${activeItems().length}</span></h1></div>
      <div class="icon-row">
        <button class="icon-btn" data-toggle-view>${settings.viewMode === 'grid' ? '☰' : '▦'}</button>
      </div>
    </div>
    ${banner}
    <div class="scroll" style="padding-bottom:20px;">${body}</div>`;
}

function listRow(it) {
  const dl = daysLeft(it.expiry);
  const uc = urgencyClass(dl);
  return `<button class="item-row" data-nav="detail/${it.id}">
    <div class="item-thumb">${it.photo ? `<img src="${it.photo}">` : '🎁'}</div>
    <div class="item-info">
      <div class="item-brand">${escapeHtml(it.category)}${it.brand ? ' · ' + escapeHtml(it.brand) : ''}</div>
      <div class="item-name">${escapeHtml(it.name)}</div>
      <div class="item-date">~${fmtDate(it.expiry)}</div>
    </div>
    <div class="dday ${uc}"><span>${ddayLabel(dl)}</span></div>
  </button>`;
}

function gridCard(it) {
  const dl = daysLeft(it.expiry);
  const uc = urgencyClass(dl);
  return `<button class="grid-card" data-nav="detail/${it.id}">
    <div class="grid-thumb">
      ${it.photo ? `<img src="${it.photo}">` : '🎁'}
      <span class="grid-badge ${uc}">${ddayLabel(dl)}</span>
    </div>
    <div class="grid-body">
      <div class="grid-brand">${escapeHtml(it.brand || it.category)}</div>
      <div class="grid-name">${escapeHtml(it.name)}</div>
      <div class="grid-date">~${fmtDate(it.expiry).slice(5)}</div>
    </div>
  </button>`;
}

/* ---- urgent ---- */
function renderUrgent() {
  const list = sortedActive().filter(it => daysLeft(it.expiry) >= 0);
  const c3 = expiringSoonCount(3);
  const c7 = expiringSoonCount(7);
  const c30 = expiringSoonCount(30);
  const rows = list.filter(it => daysLeft(it.expiry) <= 90);
  return `<div class="hero-header">
      <div class="h-eyebrow">만료 임박</div>
      <div class="h-title">서두르면 다 쓸 수 있어요</div>
      <div class="hero-stats">
        <div class="hero-stat"><div class="n mono">${c3}</div><div class="l">3일 이내</div></div>
        <div class="hero-stat"><div class="n mono">${c7}</div><div class="l">이번 주</div></div>
        <div class="hero-stat"><div class="n mono">${c30}</div><div class="l">이번 달</div></div>
      </div>
    </div>
    <div class="scroll" style="padding:16px 20px;display:flex;flex-direction:column;gap:12px;">
      ${rows.length ? rows.map(it => {
        const dl = daysLeft(it.expiry);
        const uc = urgencyClass(dl);
        const borderColor = uc === 'urgent' ? '#ED5E4C' : uc === 'soon' ? '#E0982F' : '#5FA97E';
        const textColor = uc === 'urgent' || uc === 'soon' ? (uc === 'urgent' ? '#D8442F' : '#B87A1E') : '#3F8F5F';
        return `<button class="urgent-row" style="border-left:5px solid ${borderColor};" data-nav="detail/${it.id}">
          <div class="item-thumb">${it.photo ? `<img src="${it.photo}">` : '🎁'}</div>
          <div style="flex:1;min-width:0;">
            <div class="item-brand">${escapeHtml(it.brand || it.category)}</div>
            <div class="item-name">${escapeHtml(it.name)}</div>
            <div style="font-size:12px;font-weight:800;color:${textColor};">D-${dl} · ${fmtDate(it.expiry)} 만료</div>
          </div>
          <span class="mono" style="font-weight:900;font-size:19px;color:${textColor};">${ddayLabel(dl)}</span>
        </button>`;
      }).join('') : `<div class="empty-state"><div class="e-icon">✅</div><div class="e-title">임박한 기프티콘이 없어요</div></div>`}
    </div>`;
}

/* ---- add ---- */
let addPhoto = null;
function renderAdd() {
  addPhoto = addPhoto || null;
  const cats = CATEGORIES;
  return `<div class="subhead-row">
      <button class="back-btn" data-nav="home">‹</button>
      <span class="page-title" style="flex:1;">새 기프티콘</span>
      <button class="back-btn" data-nav="home" style="font-size:14px;font-weight:700;color:var(--faint);width:auto;">취소</button>
    </div>
    <div class="scroll">
      <div class="form-wrap">
        <div class="photo-picker" id="photoPicker">
          ${addPhoto ? `<img src="${addPhoto}"><button type="button" class="photo-remove" id="removePhoto">✕</button>` : `
            <div class="pp-icon">📷</div>
            <div class="pp-t1">사진 촬영 또는 앨범에서 선택</div>
            <div class="pp-t2">기프티콘 이미지를 저장해 두어요</div>`}
        </div>
        <div class="field"><label>상품명</label><input type="text" id="f-name" placeholder="예: 아이스 아메리카노 T"></div>
        <div class="field-row">
          <div class="field"><label>브랜드</label><input type="text" id="f-brand" placeholder="예: 스타벅스"></div>
          <div class="field"><label>유효기간</label><input type="date" id="f-expiry"></div>
        </div>
        <div class="field">
          <label>카테고리</label>
          <div class="cat-grid">${cats.map((c, i) => `<button type="button" class="cat-chip ${i === 0 ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}</div>
        </div>
        <div class="field"><label>메모 (선택)</label><textarea id="f-memo" placeholder="예: 엄마 생일선물 🎁"></textarea></div>
      </div>
    </div>
    <div class="form-footer"><button class="primary-btn" id="saveBtn">등록하기</button></div>`;
}

/* ---- detail ---- */
function renderDetail(id) {
  const it = items.find(i => i.id === id);
  if (!it) return `<div class="empty-state"><div class="e-title">항목을 찾을 수 없어요</div></div>`;
  const dl = daysLeft(it.expiry);
  const uc = urgencyClass(dl);
  const ddayBg = uc === 'urgent' ? '#FCE1DD' : uc === 'soon' ? '#FBECD3' : '#E1F0E6';
  const ddayColor = uc === 'urgent' ? 'var(--danger)' : uc === 'soon' ? 'var(--amber)' : 'var(--green)';
  const statusBadge = it.status === 'used' ? `<span class="status-pill used">사용완료</span>`
    : it.status === 'expired' ? `<span class="status-pill expired">기간만료</span>` : '';

  return `<div class="detail-hero">
      <div class="detail-hero-top">
        <button class="back-btn" data-nav="home">‹</button>
        <button class="menu-btn" id="menuBtn">⋯</button>
      </div>
      <div class="detail-photo-wrap">
        <div class="detail-photo">${it.photo ? `<img src="${it.photo}">` : '🎁'}</div>
      </div>
      <div class="detail-spacer"></div>
    </div>
    <div class="detail-body">
      <div class="detail-title-row">
        <div><div class="detail-brand">${escapeHtml(it.category)}${it.brand ? ' · ' + escapeHtml(it.brand) : ''}</div>
        <div class="detail-name">${escapeHtml(it.name)}</div></div>
        ${it.status === 'active' ? `<span class="detail-dday" style="background:${ddayBg};color:${ddayColor};">${ddayLabel(dl)}</span>` : statusBadge}
      </div>
      <div class="info-card">
        <div class="info-row"><span class="k">유효기간</span><span class="v">${fmtDate(it.expiry)} 까지</span></div>
        <div class="info-row"><span class="k">카테고리</span><span class="v">${escapeHtml(it.category)}</span></div>
        ${it.memo ? `<div class="info-row"><span class="k">메모</span><span class="v">${escapeHtml(it.memo)}</span></div>` : ''}
      </div>
      ${it.photo ? `<div class="hint-card"><span class="hi">🖼️</span><div class="ht">바코드가 포함된 <b>원본 이미지</b>를 그대로 저장했어요. 매장에선 이 이미지를 보여주면 돼요.</div></div>` : ''}
      ${it.status === 'active' ? `
      <div class="detail-actions">
        <button class="ghost-btn" id="markUsed">사용완료</button>
        <button class="primary-btn" id="presentBtn">화면 밝게 · 바코드 제시</button>
      </div>` : `
      <div class="detail-actions">
        <button class="ghost-btn" id="restoreBtn" style="flex:1;">다시 활성화하기</button>
      </div>`}
    </div>`;
}

/* ---- present (barcode) ---- */
function renderPresent(id) {
  const it = items.find(i => i.id === id);
  if (!it) return `<div class="empty-state"><div class="e-title">항목을 찾을 수 없어요</div></div>`;
  return `<div class="present-screen">
    <div class="present-top">
      <button class="present-close" data-nav="detail/${id}">‹ 닫기</button>
      <span class="brightness-pill">🔆 화면을 밝게 해주세요</span>
    </div>
    <div class="present-mid">
      <div class="present-name"><div class="b">${escapeHtml(it.category)}${it.brand ? ' · ' + escapeHtml(it.brand) : ''}</div><div class="n">${escapeHtml(it.name)}</div></div>
      <div class="present-photo">${it.photo ? `<img src="${it.photo}">` : `<div class="ph-empty">이미지 없음</div>`}</div>
      <div class="present-note">직원에게 화면을 보여주세요<br>스캔이 끝나면 아래 버튼을 눌러요</div>
    </div>
    <button class="primary-btn" style="background:#302823;" id="doneBtn">사용완료로 표시</button>
  </div>`;
}

/* ---- archive ---- */
let archiveTab = 'used';
function renderArchive() {
  const used = items.filter(i => i.status === 'used');
  const expired = items.filter(i => i.status === 'expired');
  const list = archiveTab === 'used' ? used : expired;
  return `<div class="subhead-row"><span class="page-title">보관함</span></div>
    <div class="chip-row">
      <button class="chip ${archiveTab === 'used' ? 'active' : ''}" data-tab="used">사용완료 ${used.length}</button>
      <button class="chip ${archiveTab === 'expired' ? 'active' : ''}" data-tab="expired">만료 ${expired.length}</button>
    </div>
    <div class="scroll" style="padding:14px 20px 20px;display:flex;flex-direction:column;gap:10px;">
      ${list.length ? list.map(it => `
        <button class="archive-row" data-nav="detail/${it.id}">
          <div class="archive-thumb">${it.photo ? `<img src="${it.photo}">` : ''}${it.status === 'used' ? '<div class="check">✓</div>' : ''}</div>
          <div style="flex:1;min-width:0;">
            <div class="archive-brand">${escapeHtml(it.brand || it.category)}</div>
            <div class="archive-name">${escapeHtml(it.name)}</div>
          </div>
          <span class="status-pill ${it.status}">${it.status === 'used' ? '사용완료' : '기간만료'}</span>
        </button>`).join('') : `<div class="empty-state"><div class="e-icon">📭</div><div class="e-title">항목이 없어요</div></div>`}
    </div>`;
}

/* ---- settings ---- */
function renderSettings() {
  return `<div class="subhead-row"><span class="page-title">설정</span></div>
    <div class="scroll">
      <div class="settings-section" style="padding-top:6px;">
        <p class="settings-desc">만료가 가까워질수록 더 자주 알려드려요. 구간별로 자유롭게 바꿀 수 있어요.</p>
        <div class="notification-status" id="notificationStatusCard" data-kind="${notificationState.kind}">
          <div class="notification-status-copy">
            <span class="notification-status-dot"></span>
            <span id="notificationStatusText">${escapeHtml(notificationState.message)}</span>
          </div>
          ${isNative ? `<div class="notification-status-actions">
            <button type="button" id="notifFixBtn">${notificationState.exactAlarm === 'denied' ? '정확한 알림 켜기' : '알림 다시 확인'}</button>
            <button type="button" id="testNotifBtn">테스트 알림</button>
          </div>` : ''}
        </div>
        ${TIER_META.map(meta => `
          <div class="tier-card">
            <div class="tier-head"><span class="dot" style="background:${meta.dot};"></span><span class="lbl">${meta.label}</span></div>
            <div class="freq-row">
              ${TIER_OPTIONS[meta.key].map(o => `<button class="freq-opt ${settings.tiers[meta.key] === o.key ? 'active' : ''}" data-tier="${meta.key}" data-freq="${o.key}">${o.label}</button>`).join('')}
            </div>
          </div>`).join('')}

        <div class="settings-row">
          <span class="lbl">알림 시각</span>
          <input type="time" id="notifyTime" value="${settings.notifyTime}">
        </div>

        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px;">
          <span class="lbl">홈 화면 보기 방식</span>
          <div class="segmented">
            <button class="${settings.viewMode === 'list' ? 'active' : ''}" data-view="list">리스트</button>
            <button class="${settings.viewMode === 'grid' ? 'active' : ''}" data-view="grid">그리드</button>
          </div>
        </div>

        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px;">
          <span class="lbl">테마 색상</span>
          <div class="theme-row">
            ${THEMES.map((t, i) => `<button class="theme-dot ${settings.theme === i ? 'active' : ''}" data-theme="${i}" style="background:${t[0]};"></button>`).join('')}
          </div>
        </div>

        <button class="danger-btn" id="resetBtn">모든 데이터 초기화</button>
      </div>
    </div>`;
}

/* ---------------- event handlers ---------------- */
function attachHandlers(routeName, arg) {
  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => go('/' + el.getAttribute('data-nav')));
  });

  if (routeName === 'home') {
    const t = app.querySelector('[data-toggle-view]');
    if (t) t.addEventListener('click', () => { settings.viewMode = settings.viewMode === 'grid' ? 'list' : 'grid'; saveSettings(settings); render(); });
  }

  if (routeName === 'add') {
    let selectedCat = CATEGORIES[0];
    app.querySelectorAll('.cat-chip').forEach(el => {
      el.addEventListener('click', () => {
        selectedCat = el.getAttribute('data-cat');
        app.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('active', c === el));
      });
    });
    const picker = app.querySelector('#photoPicker');
    if (picker) picker.addEventListener('click', async (e) => {
      if (e.target.id === 'removePhoto') return;
      const photo = await pickPhoto();
      if (photo) { addPhoto = photo; render(); }
    });
    const removeBtn = app.querySelector('#removePhoto');
    if (removeBtn) removeBtn.addEventListener('click', (e) => { e.stopPropagation(); addPhoto = null; render(); });

    app.querySelector('#saveBtn').addEventListener('click', async () => {
      const name = app.querySelector('#f-name').value.trim();
      const expiry = app.querySelector('#f-expiry').value;
      if (!name || !expiry) { alert('상품명과 유효기간을 입력해주세요.'); return; }
      const brand = app.querySelector('#f-brand').value.trim();
      const memo = app.querySelector('#f-memo').value.trim();
      items.push({
        id: 'g' + Date.now() + Math.floor(Math.random() * 1000),
        name, brand, memo,
        category: selectedCat,
        expiry,
        photo: addPhoto,
        status: 'active',
        createdAt: Date.now()
      });
      saveItems(items);
      addPhoto = null;
      await rescheduleAll();
      go('/home');
    });
  }

  if (routeName === 'detail') {
    const it = items.find(i => i.id === arg);
    const menuBtn = app.querySelector('#menuBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => {
      if (confirm('이 기프티콘을 삭제할까요?')) {
        items = items.filter(i => i.id !== arg);
        saveItems(items);
        rescheduleAll();
        go('/home');
      }
    });
    const markUsed = app.querySelector('#markUsed');
    if (markUsed) markUsed.addEventListener('click', async () => {
      it.status = 'used';
      saveItems(items);
      await rescheduleAll();
      go('/archive');
    });
    const presentBtn = app.querySelector('#presentBtn');
    if (presentBtn) presentBtn.addEventListener('click', () => go('/present/' + arg));
    const restoreBtn = app.querySelector('#restoreBtn');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      it.status = 'active';
      saveItems(items);
      await rescheduleAll();
      go('/home');
    });
  }

  if (routeName === 'present') {
    const it = items.find(i => i.id === arg);
    const doneBtn = app.querySelector('#doneBtn');
    if (doneBtn) doneBtn.addEventListener('click', async () => {
      it.status = 'used';
      saveItems(items);
      await rescheduleAll();
      go('/archive');
    });
  }

  if (routeName === 'archive') {
    app.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', () => { archiveTab = el.getAttribute('data-tab'); render(); });
    });
  }

  if (routeName === 'settings') {
    const notifFixBtn = app.querySelector('#notifFixBtn');
    if (notifFixBtn) notifFixBtn.addEventListener('click', async () => {
      if (notificationState.permission === 'granted' && notificationState.exactAlarm === 'denied' && isAndroid) {
        await LocalNotifications.changeExactNotificationSetting();
      }
      await rescheduleAll();
      render();
    });
    const testNotifBtn = app.querySelector('#testNotifBtn');
    if (testNotifBtn) testNotifBtn.addEventListener('click', async () => {
      try {
        await sendTestNotification();
      } catch (error) {
        alert(error?.message || '테스트 알림을 보낼 수 없어요.');
      }
    });
    app.querySelectorAll('[data-tier]').forEach(el => {
      el.addEventListener('click', async () => {
        settings.tiers[el.getAttribute('data-tier')] = el.getAttribute('data-freq');
        saveSettings(settings);
        await rescheduleAll();
        render();
      });
    });
    const timeInput = app.querySelector('#notifyTime');
    if (timeInput) timeInput.addEventListener('change', async () => {
      settings.notifyTime = timeInput.value;
      saveSettings(settings);
      await rescheduleAll();
    });
    app.querySelectorAll('[data-view]').forEach(el => {
      el.addEventListener('click', () => { settings.viewMode = el.getAttribute('data-view'); saveSettings(settings); render(); });
    });
    app.querySelectorAll('[data-theme]').forEach(el => {
      el.addEventListener('click', () => { settings.theme = Number(el.getAttribute('data-theme')); saveSettings(settings); render(); });
    });
    const resetBtn = app.querySelector('#resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (confirm('모든 기프티콘과 설정을 삭제할까요? 이 작업은 되돌릴 수 없어요.')) {
        localStorage.removeItem(ITEMS_KEY);
        localStorage.removeItem(SETTINGS_KEY);
        items = []; settings = defaultSettings();
        rescheduleAll();
        render();
      }
    });
  }
}

/* ---------------- expire sweep ---------------- */
function sweepExpired() {
  let changed = false;
  for (const it of items) {
    if (it.status === 'active' && daysLeft(it.expiry) < 0) { it.status = 'expired'; changed = true; }
  }
  if (changed) saveItems(items);
}

/* ---------------- init ---------------- */
sweepExpired();
render();
rescheduleAll();
