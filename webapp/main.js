import { Capacitor, registerPlugin } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { LocalNotifications } from '@capacitor/local-notifications';
import { parseGiftText } from './gift-text-parser.mjs';
import { TIER_META, TIER_OPTIONS, buildScheduleDates, daysUntilExpiryOn } from './notification-schedule.mjs';

const isNative = Capacitor.isNativePlatform();
const isAndroid = Capacitor.getPlatform() === 'android';
const GiftOcr = registerPlugin('GiftOcr');

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

function categoryGlyph(category) {
  return ({ 카페: '☕', 편의점: '◇', 치킨: '♨', 디저트: '✦', 뷰티: '◌', 기타: '⌁' })[category] || '✦';
}

function listPhotoPlaceholder(it) {
  const label = it.photo ? `${it.name} 기프티콘 사진` : `${it.category || '기프티콘'} 기본 커버`;
  return `<span class="gift-art ${it.photo ? 'has-photo' : ''}" aria-label="${escapeHtml(label)}">
    <span class="gift-art-fallback" aria-hidden="true"><b>${categoryGlyph(it.category)}</b><small>${escapeHtml(it.brand || it.category || 'GIFT')}</small></span>
    ${it.photo ? `<img src="${it.photo}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">` : ''}
    <span class="gift-art-shine" aria-hidden="true"></span>
  </span>`;
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
function compressImage(dataUrl, maxDim = 960, quality = 0.76) {
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
// Android terminates the app when the 501st alarm is registered. Keep ample
// headroom and clear the plugin's real pending list before rebuilding it.
const MAX_PENDING_NOTIFICATIONS = 200;
let notificationState = {
  kind: isNative ? 'checking' : 'web',
  message: isNative ? '알림 상태를 확인하고 있어요.' : '알림 상태는 Android 앱에서 확인할 수 있어요.',
  permission: 'unknown',
  exactAlarm: 'unknown',
  scheduled: 0
};
let rescheduleQueue = Promise.resolve();

async function ensureNotifPermission(requestIfNeeded = false) {
  if (!isNative) return true;
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return true;
  if (!requestIfNeeded) return false;
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

async function performReschedule(requestPermission = false) {
  if (!isNative) return;
  notificationState = { ...notificationState, kind: 'checking', message: '알림을 다시 예약하고 있어요.' };
  refreshNotificationStatus();

  try {
    const existingPending = await LocalNotifications.getPending();
    if (existingPending.notifications.length) {
      await LocalNotifications.cancel({ notifications: existingPending.notifications.map(({ id }) => ({ id })) });
    }

    const active = activeItems();
    if (!active.length) {
      notificationState = {
        ...notificationState,
        kind: 'ready',
        message: '등록된 기프티콘이 생기면 알림을 예약해 드려요.',
        scheduled: 0
      };
      return;
    }

    const permitted = await ensureNotifPermission(requestPermission);
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
    toSchedule.sort((a, b) => a.schedule.at.getTime() - b.schedule.at.getTime());
    const safeSchedule = toSchedule.slice(0, MAX_PENDING_NOTIFICATIONS);
    if (safeSchedule.length) await LocalNotifications.schedule({ notifications: safeSchedule });

    const exactAlarm = isAndroid
      ? (await LocalNotifications.checkExactNotificationSetting()).exact_alarm
      : 'granted';
    const pending = await LocalNotifications.getPending();
    const scheduledIds = new Set(safeSchedule.map(notification => notification.id));
    const scheduled = pending.notifications.filter(notification => scheduledIds.has(notification.id)).length;
    const timingNote = exactAlarm === 'granted' ? '' : ' 정확 알람 권한을 켜면 절전 중에도 더 정확해요.';
    const limitNote = toSchedule.length > safeSchedule.length
      ? ` 가까운 순서로 최대 ${MAX_PENDING_NOTIFICATIONS}개만 예약했어요.`
      : '';
    notificationState = {
      kind: exactAlarm === 'granted' ? 'ready' : 'warning',
      message: scheduled > 0 ? `정상 · ${scheduled}개 예약됨.${limitNote}${timingNote}` : `알림 권한 정상 · 예약할 알림이 없어요.${timingNote}`,
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

function rescheduleAll(requestPermission = false) {
  const schedule = () => performReschedule(requestPermission);
  rescheduleQueue = rescheduleQueue.then(schedule, schedule);
  return rescheduleQueue;
}

async function sendTestNotification() {
  const permitted = await ensureNotifPermission(true);
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
let suppressAddUntil = 0;

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

  app.innerHTML = `<main class="screen ${showNav ? 'screen-with-nav' : 'screen-full'}">${html}</main>${showNav ? renderNav(name) : ''}`;
  attachHandlers(name, arg);
}

function navIcon(key) {
  const icons = {
    home: '<path d="M3.5 10.5 12 3l8.5 7.5"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-6h5v6"/>',
    urgent: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4.5l3 2M8 3.5 6 5M16 3.5 18 5"/>',
    archive: '<path d="M4 7h16v13H4zM3 4h18v4H3zM9 11h6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`;
}

function renderNav(active) {
  const items = [
    { key: 'home', label: '홈' },
    { key: 'urgent', label: '임박' },
    { key: 'fab', label: '추가' },
    { key: 'archive', label: '보관함' },
    { key: 'settings', label: '설정' }
  ];
  return `<nav class="bottom-nav" aria-label="주요 메뉴">
    ${items.map(it => {
      if (it.key === 'fab') return `<button class="nav-fab" data-nav="add" aria-label="새 기프티콘 추가"><span>+</span><small>${it.label}</small></button>`;
      return `<button class="nav-item ${active === it.key ? 'active' : ''}" data-nav="${it.key}" ${active === it.key ? 'aria-current="page"' : ''}>
        <span class="ic">${navIcon(it.key)}</span><span>${it.label}</span>
      </button>`;
    }).join('')}
  </nav>`;
}

/* ---- home ---- */
let homeQuery = '';
let homeCategory = '전체';
let homeSort = 'expiry';

function visibleHomeItems() {
  const query = homeQuery.trim().toLocaleLowerCase('ko');
  const filtered = activeItems().filter(it => {
    const categoryMatches = homeCategory === '전체' || it.category === homeCategory;
    const queryMatches = !query || [it.name, it.brand, it.category, it.memo]
      .some(value => String(value || '').toLocaleLowerCase('ko').includes(query));
    return categoryMatches && queryMatches;
  });
  return filtered.sort((a, b) => homeSort === 'added'
    ? (b.createdAt || 0) - (a.createdAt || 0)
    : daysLeft(a.expiry) - daysLeft(b.expiry));
}

function renderHome() {
  const list = visibleHomeItems();
  const soonCount = expiringSoonCount(3);
  const isFiltering = Boolean(homeQuery.trim()) || homeCategory !== '전체';
  const banner = soonCount > 0 ? `
    <button class="alert-banner" data-nav="urgent">
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
      <div class="e-icon">${isFiltering ? '🔎' : '🎁'}</div>
      <div class="e-title">${isFiltering ? '조건에 맞는 기프티콘이 없어요' : '등록된 기프티콘이 없어요'}</div>
      <div class="e-sub">${isFiltering ? '검색어나 필터를 바꿔보세요' : '가운데 + 버튼으로 첫 기프티콘을 등록해보세요'}</div>
      ${isFiltering ? '<button class="empty-reset" id="clearHomeFilters">필터 초기화</button>' : ''}
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
      <div><div class="greet">오늘도 놓치지 않게</div><h1>내 기프티콘 <span>${activeItems().length}</span></h1></div>
      <div class="icon-row">
        <button class="icon-btn" data-toggle-view aria-label="${settings.viewMode === 'grid' ? '리스트로 보기' : '그리드로 보기'}">
          ${settings.viewMode === 'grid'
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>'}
        </button>
      </div>
    </div>
    ${banner}
    <div class="home-tools">
      <div class="search-box">
        <span aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></span>
        <input id="homeSearch" type="search" value="${escapeHtml(homeQuery)}" placeholder="상품명, 브랜드, 메모 검색" aria-label="기프티콘 검색">
        ${homeQuery ? '<button id="clearSearch" aria-label="검색어 지우기">×</button>' : ''}
      </div>
      <select id="homeSort" class="sort-select" aria-label="정렬 방식">
        <option value="expiry" ${homeSort === 'expiry' ? 'selected' : ''}>만료 임박순</option>
        <option value="added" ${homeSort === 'added' ? 'selected' : ''}>최근 등록순</option>
      </select>
    </div>
    <div class="chip-row home-filters">
      ${['전체', ...CATEGORIES].map(category => `<button class="chip ${homeCategory === category ? 'active' : ''}" data-home-category="${category}">${category}</button>`).join('')}
    </div>
    <div class="result-summary"><span>${isFiltering ? `검색 결과 ${list.length}개` : `사용 가능한 ${list.length}개`}</span></div>
    <div class="scroll home-scroll">${body}</div>`;
}

function listRow(it) {
  const dl = daysLeft(it.expiry);
  const uc = urgencyClass(dl);
  return `<button class="item-row" data-nav="detail/${it.id}">
    <div class="item-thumb">${listPhotoPlaceholder(it)}</div>
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
      ${listPhotoPlaceholder(it)}
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
          <div class="item-thumb">${listPhotoPlaceholder(it)}</div>
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
function emptyAddDraft() {
  return {
    name: '',
    brand: '',
    expiry: '',
    category: CATEGORIES[0],
    categoryTouched: false,
    memo: '',
    photo: null,
    ocrState: 'idle',
    ocrMessage: '',
    error: ''
  };
}

let addDraft = null;
let addSaving = false;

function ensureAddDraft() {
  if (!addDraft) addDraft = emptyAddDraft();
  return addDraft;
}

function syncAddDraftFromForm() {
  if (!addDraft) return;
  const read = id => app.querySelector(id)?.value ?? '';
  addDraft.name = read('#f-name');
  addDraft.brand = read('#f-brand');
  addDraft.expiry = read('#f-expiry');
  addDraft.memo = read('#f-memo');
}

function draftHasContent() {
  return Boolean(addDraft && (addDraft.name.trim() || addDraft.brand.trim() || addDraft.expiry || addDraft.memo.trim() || addDraft.photo));
}

async function analyzeAddPhoto() {
  if (!addDraft?.photo) return;
  if (!isAndroid) {
    addDraft.ocrState = 'unavailable';
    addDraft.ocrMessage = '자동 읽기는 Android 앱에서 사용할 수 있어요.';
    render();
    return;
  }

  addDraft.ocrState = 'scanning';
  addDraft.ocrMessage = '사진에서 상품명과 유효기간을 읽고 있어요…';
  render();
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('OCR_TIMEOUT')), 15000));
    const result = await Promise.race([GiftOcr.recognize({ dataUrl: addDraft.photo }), timeout]);
    const parsed = parseGiftText(result.text);
    let applied = 0;
    if (!addDraft.name.trim() && parsed.name) { addDraft.name = parsed.name; applied += 1; }
    if (!addDraft.brand.trim() && parsed.brand) { addDraft.brand = parsed.brand; applied += 1; }
    if (!addDraft.expiry && parsed.expiry) { addDraft.expiry = parsed.expiry; applied += 1; }
    if (!addDraft.categoryTouched && parsed.category !== '기타') { addDraft.category = parsed.category; applied += 1; }
    addDraft.ocrState = applied ? 'success' : 'empty';
    addDraft.ocrMessage = applied
      ? `${applied}개 항목을 자동으로 채웠어요. 저장 전에 한 번 확인해 주세요.`
      : '읽은 내용에서 채울 정보를 찾지 못했어요. 직접 입력해 주세요.';
  } catch (error) {
    console.error('OCR failed', error);
    addDraft.ocrState = 'error';
    const modelPreparing = error?.code === 'OCR_MODEL_DOWNLOADING'
      || String(error?.message || '').includes('OCR 모델을 준비 중');
    addDraft.ocrMessage = modelPreparing
      ? 'OCR 모델을 준비 중이에요. 인터넷에 연결한 상태에서 잠시 후 다시 읽어 주세요.'
      : '사진을 자동으로 읽지 못했어요. 선명한 이미지로 다시 시도해 주세요.';
  }
  render();
}

function renderAdd() {
  const draft = ensureAddDraft();
  const cats = CATEGORIES;
  return `<div class="subhead-row">
      <button class="back-btn" data-cancel-add aria-label="등록 취소">‹</button>
      <span class="page-title" style="flex:1;">새 기프티콘</span>
      <button class="text-btn" data-cancel-add>취소</button>
    </div>
    <div class="scroll">
      <div class="form-wrap">
        <div class="form-intro"><strong>사진 한 장이면 더 빨라요</strong><span>상품명과 유효기간을 자동으로 찾아드려요.</span></div>
        <div class="photo-card ${draft.photo ? 'has-photo' : ''}">
          <button type="button" class="photo-picker" id="photoPicker" aria-label="기프티콘 사진 선택">
          ${draft.photo ? `<img src="${draft.photo}" alt="선택한 기프티콘">` : `
            <div class="pp-icon">📷</div>
            <div class="pp-t1">사진 촬영 또는 앨범에서 선택</div>
            <div class="pp-t2">이미지는 기기 안에만 저장돼요</div>`}
          </button>
          ${draft.photo ? `<div class="photo-actions">
            <button type="button" id="replacePhoto">사진 바꾸기</button>
            <button type="button" id="removePhoto">사진 삭제</button>
          </div>` : ''}
        </div>
        ${draft.ocrState !== 'idle' ? `<div class="ocr-status ${draft.ocrState}" role="status" aria-live="polite">
          <span class="ocr-status-icon">${draft.ocrState === 'scanning' ? '<span class="spinner"></span>' : draft.ocrState === 'success' ? '✓' : 'i'}</span>
          <span>${escapeHtml(draft.ocrMessage)}</span>
          ${draft.photo && draft.ocrState !== 'scanning' && isAndroid ? `<button type="button" id="runOcr">${draft.ocrState === 'ready' ? '자동 입력' : '다시 읽기'}</button>` : ''}
        </div>` : ''}
        ${draft.error ? `<div class="form-error" role="alert">${escapeHtml(draft.error)}</div>` : ''}
        <div class="field"><label for="f-name">상품명 <em>필수</em></label><input type="text" id="f-name" value="${escapeHtml(draft.name)}" placeholder="예: 아이스 아메리카노 T" autocomplete="off"></div>
        <div class="field-row">
          <div class="field"><label for="f-brand">브랜드</label><input type="text" id="f-brand" value="${escapeHtml(draft.brand)}" placeholder="예: 스타벅스" autocomplete="off"></div>
          <div class="field"><label for="f-expiry">유효기간 <em>필수</em></label><input type="date" id="f-expiry" value="${escapeHtml(draft.expiry)}"></div>
        </div>
        <div class="field">
          <label>카테고리</label>
          <div class="cat-grid">${cats.map(c => `<button type="button" class="cat-chip ${draft.category === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}</div>
        </div>
        <div class="field"><label for="f-memo">메모 <span>(선택)</span></label><textarea id="f-memo" placeholder="받은 사람이나 사용 계획을 적어두세요">${escapeHtml(draft.memo)}</textarea></div>
      </div>
    </div>
    <div class="form-footer"><button class="primary-btn" id="saveBtn" ${addSaving ? 'disabled' : ''}>${addSaving ? '등록 중…' : '기프티콘 등록'}</button></div>`;
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
        <div class="detail-photo">${it.photo ? `<img src="${it.photo}" decoding="async">` : '🎁'}</div>
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
      <div class="present-photo">${it.photo ? `<img src="${it.photo}" decoding="async">` : `<div class="ph-empty">이미지 없음</div>`}</div>
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
          <div class="archive-thumb">${listPhotoPlaceholder(it)}${it.status === 'used' ? '<div class="check">✓</div>' : ''}</div>
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
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      if (target === 'add' && performance.now() < suppressAddUntil) return;
      go('/' + target);
    });
  });

  if (routeName === 'home') {
    const t = app.querySelector('[data-toggle-view]');
    if (t) t.addEventListener('click', () => { settings.viewMode = settings.viewMode === 'grid' ? 'list' : 'grid'; saveSettings(settings); render(); });
    const search = app.querySelector('#homeSearch');
    if (search) search.addEventListener('input', () => {
      homeQuery = search.value;
      render();
      const nextSearch = app.querySelector('#homeSearch');
      nextSearch?.focus();
      nextSearch?.setSelectionRange(homeQuery.length, homeQuery.length);
    });
    app.querySelector('#clearSearch')?.addEventListener('click', () => { homeQuery = ''; render(); app.querySelector('#homeSearch')?.focus(); });
    app.querySelector('#homeSort')?.addEventListener('change', event => { homeSort = event.target.value; render(); });
    app.querySelectorAll('[data-home-category]').forEach(el => {
      el.addEventListener('click', () => { homeCategory = el.getAttribute('data-home-category'); render(); });
    });
    app.querySelector('#clearHomeFilters')?.addEventListener('click', () => { homeQuery = ''; homeCategory = '전체'; render(); });
  }

  if (routeName === 'add') {
    ensureAddDraft();
    app.querySelectorAll('[data-cancel-add]').forEach(el => {
      el.addEventListener('click', () => {
        syncAddDraftFromForm();
        if (draftHasContent() && !confirm('작성 중인 내용을 지우고 나갈까요?')) return;
        addDraft = null;
        addSaving = false;
        go('/home');
      });
    });
    ['#f-name', '#f-brand', '#f-expiry', '#f-memo'].forEach(selector => {
      app.querySelector(selector)?.addEventListener('input', () => {
        syncAddDraftFromForm();
        addDraft.error = '';
      });
    });
    app.querySelectorAll('.cat-chip').forEach(el => {
      el.addEventListener('click', () => {
        addDraft.category = el.getAttribute('data-cat');
        addDraft.categoryTouched = true;
        app.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('active', c === el));
      });
    });
    const choosePhoto = async () => {
      syncAddDraftFromForm();
      const photo = await pickPhoto();
      if (!photo) return;
      addDraft.photo = photo;
      addDraft.ocrState = isAndroid ? 'ready' : 'unavailable';
      addDraft.ocrMessage = isAndroid
        ? '원할 때 자동 입력을 눌러 상품명과 유효기간을 읽을 수 있어요.'
        : '자동 읽기는 Android 앱에서 사용할 수 있어요.';
      render();
    };
    app.querySelector('#photoPicker')?.addEventListener('click', choosePhoto);
    app.querySelector('#replacePhoto')?.addEventListener('click', choosePhoto);
    const removeBtn = app.querySelector('#removePhoto');
    if (removeBtn) removeBtn.addEventListener('click', () => {
      syncAddDraftFromForm();
      addDraft.photo = null;
      addDraft.ocrState = 'idle';
      addDraft.ocrMessage = '';
      render();
    });
    app.querySelector('#runOcr')?.addEventListener('click', async () => {
      syncAddDraftFromForm();
      await analyzeAddPhoto();
    });

    app.querySelector('#saveBtn').addEventListener('click', async () => {
      if (addSaving) return;
      syncAddDraftFromForm();
      const name = addDraft.name.trim();
      const expiry = addDraft.expiry;
      if (!name || !expiry) {
        addDraft.error = !name && !expiry ? '상품명과 유효기간을 입력해 주세요.' : !name ? '상품명을 입력해 주세요.' : '유효기간을 입력해 주세요.';
        render();
        app.querySelector(!name ? '#f-name' : '#f-expiry')?.focus();
        return;
      }

      addSaving = true;
      const button = app.querySelector('#saveBtn');
      if (button) { button.disabled = true; button.textContent = '등록 중…'; }
      const createdAt = Date.now();
      const item = {
        id: globalThis.crypto?.randomUUID?.() || `g${createdAt}${Math.floor(Math.random() * 1000)}`,
        name,
        brand: addDraft.brand.trim(),
        memo: addDraft.memo.trim(),
        category: addDraft.category,
        expiry,
        photo: addDraft.photo,
        status: 'active',
        createdAt
      };

      try {
        items.push(item);
        saveItems(items);
        addDraft = null;
        suppressAddUntil = performance.now() + 700;
        go('/home');
        void rescheduleAll(true);
      } catch (error) {
        items = items.filter(existing => existing.id !== item.id);
        addSaving = false;
        addDraft = { ...emptyAddDraft(), ...item, error: '저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.' };
        console.error('Failed to save item', error);
        render();
      } finally {
        if (!addDraft) addSaving = false;
      }
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
      await rescheduleAll(true);
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
      await rescheduleAll(true);
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
        await rescheduleAll(true);
        render();
      });
    });
    const timeInput = app.querySelector('#notifyTime');
    if (timeInput) timeInput.addEventListener('change', async () => {
      settings.notifyTime = timeInput.value;
      saveSettings(settings);
      await rescheduleAll(true);
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
rescheduleAll(false);
