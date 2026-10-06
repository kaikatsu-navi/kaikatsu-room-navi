let allStores = [];
let userLocation = null; // { lat: number, lng: number }

// === GPS / 現在地・距離計算 ===
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // 地球の半径 (km)
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getStoreDistance(store) {
  if (!userLocation || !store || store.lat === null || store.lat === undefined || store.lng === null || store.lng === undefined) {
    return null;
  }
  return calculateDistanceKm(userLocation.lat, userLocation.lng, parseFloat(store.lat), parseFloat(store.lng));
}

function formatDistance(distKm) {
  if (distKm === null || distKm === undefined || isNaN(distKm)) return '';
  if (distKm < 1.0) {
    return `${Math.round(distKm * 1000)}m`;
  }
  return `${distKm.toFixed(1)}km`;
}

function requestNearMeSearch(isAuto = false) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (!isAuto) {
        showToast('お使いの端末・ブラウザは位置情報に対応していません。');
      }
      const sortSelect = document.getElementById('sortSelect');
      if (sortSelect && sortSelect.value === 'distance_asc') {
        sortSelect.value = 'default';
        renderStores();
      }
      resolve(false);
      return;
    }

    if (!isAuto) {
      showToast('📍 現在地を取得しています...');
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude
        };
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) sortSelect.value = 'distance_asc';
        renderStores();
        showToast('📍 現在地から近い順に並び替えました！');
        resolve(true);
      },
      (err) => {
        console.warn('Geolocation error:', err);
        if (!isAuto) {
          let msg = '位置情報を取得できませんでした。';
          if (err.code === 1) {
            msg = '位置情報の利用が許可されませんでした。ブラウザの設定から許可してください。';
          } else if (err.code === 2) {
            msg = '位置情報を特定できませんでした。電波環境の良い場所で再試行してください。';
          } else if (err.code === 3) {
            msg = '位置情報の取得がタイムアウトしました。';
          }
          showToast(msg);
        } else if (err.code === 1) {
          showToast('📍 位置情報が未許可のため、標準（都道府県順）で表示します。');
        }
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect && sortSelect.value === 'distance_asc') {
          sortSelect.value = 'default';
          renderStores();
        }
        resolve(false);
      },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 }
    );
  });
}

// === X (旧Twitter) Web Intent シェア ===
function shareStoreOnX(storeCode, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const s = allStores.find(item => String(item['店舗コード']) === String(storeCode));
  if (!s) return;
  const name = s['店舗名'] || '';
  const pref = s['都道府県'] || '';
  const h3 = s['平日_3hパック'] ? `平日3h:${s['平日_3hパック']}円〜` : '';
  const toast = s['無料トースト'] ? '🍞無料トースト' : '';
  const shower = s['無料シャワー'] ? '🚿無料シャワー' : '';
  const features = [h3, toast, shower].filter(Boolean).join(' / ');
  
  const text = `快活CLUB ${name}（${pref}）の鍵付完全個室料金・設備をチェック！\n${features ? features + '\n' : ''}\n`;
  const url = `https://kaikatsu-navi.github.io/kaikatsu-room-navi/?pref=${encodeURIComponent(pref)}&q=${encodeURIComponent(name)}`;
  const hashtags = '快活CLUB,完全個室,快活ナビ';
  const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}&hashtags=${encodeURIComponent(hashtags)}`;
  window.open(shareUrl, '_blank', 'noopener,noreferrer');
}

// === リアルタイム空席情報 (AWS API Gateway 連携) ===
const VACANCY_API_KEY = "VBVkOEaMZR5WKLi7mpKiAaFS5INR2rAR6Bgw7aOs";
const vacancyCache = new Map(); // storeCode -> { data, timestamp }
const VACANCY_CACHE_TTL = 90 * 1000; // 90秒キャッシュ

async function fetchStoreVacancy(storeCode) {
  const sCode = String(storeCode);
  const now = Date.now();
  if (vacancyCache.has(sCode)) {
    const cached = vacancyCache.get(sCode);
    if (now - cached.timestamp < VACANCY_CACHE_TTL) {
      return cached.data;
    }
  }

  const url = `https://jx5rl6ilkg.execute-api.ap-northeast-1.amazonaws.com/prd/empty_seat?store_cd=${sCode}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': VACANCY_API_KEY
    }
  });

  if (!resp.ok) {
    throw new Error(`Vacancy API error: ${resp.status}`);
  }

  const data = await resp.json();
  vacancyCache.set(sCode, { data, timestamp: now });
  return data;
}

async function toggleStoreVacancy(storeCode, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const sCode = String(storeCode);
  const container = document.getElementById(`store-vacancy-${sCode}`);
  const btn = document.getElementById(`vacancy-btn-${sCode}`);
  if (!container) return;

  // すでに開いていて読み込み完了している場合は折りたたむ
  if (!container.classList.contains('hidden') && !container.dataset.loading) {
    container.classList.add('hidden');
    if (btn) {
      btn.classList.remove('bg-emerald-600', 'text-white');
      btn.classList.add('bg-emerald-50', 'text-emerald-700');
    }
    return;
  }

  // 展開してローディング表示
  container.classList.remove('hidden');
  container.dataset.loading = "true";
  container.innerHTML = `
    <div class="bg-emerald-50/50 rounded-lg p-3 border border-emerald-100 flex items-center justify-center gap-2 text-xs text-emerald-800">
      <i class="fa-solid fa-circle-notch fa-spin text-emerald-600"></i>
      <span>最新のリアルタイム空席状況を取得中...</span>
    </div>
  `;
  if (btn) {
    btn.classList.remove('bg-emerald-50', 'text-emerald-700');
    btn.classList.add('bg-emerald-600', 'text-white');
  }

  try {
    const data = await fetchStoreVacancy(sCode);
    container.dataset.loading = "";
    renderVacancyContent(sCode, data, container);
  } catch (err) {
    console.error('Failed to fetch vacancy:', err);
    container.dataset.loading = "";
    container.innerHTML = `
      <div class="bg-red-50 rounded-lg p-3 border border-red-200 text-xs text-red-700 flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <i class="fa-solid fa-triangle-exclamation text-red-500"></i>
          <span>空席情報の取得に失敗しました。</span>
        </div>
        <a href="https://www.kaikatsu.jp/shop/detail/vacancy.html?store_code=${sCode}" target="_blank" rel="noopener noreferrer" class="underline text-red-800 font-bold ml-2">
          公式画面で見る
        </a>
      </div>
    `;
  }
}

function formatVacancyTime(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hours}:${minutes} 時点`;
}

function refreshStoreVacancy(storeCode, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const sCode = String(storeCode);
  vacancyCache.delete(sCode);
  const container = document.getElementById(`store-vacancy-${sCode}`);
  if (container) {
    container.classList.add('hidden');
    container.dataset.loading = "";
  }
  toggleStoreVacancy(sCode, event);
}

function renderVacancyContent(storeCode, data, container, timestamp) {
  const seats = (data && data.seat_type) ? data.seat_type : [];
  if (seats.length === 0) {
    container.innerHTML = `
      <div class="bg-slate-50 rounded-lg p-2.5 border border-slate-200 text-xs text-slate-500 text-center">
        現在取得できる空席情報がありません。
      </div>
    `;
    return;
  }

  // 鍵付個室とその他を分類
  const keySeats = seats.filter(s => (s.seat_name || '').includes('鍵付'));
  const otherSeats = seats.filter(s => !(s.seat_name || '').includes('鍵付'));

  const makeSeatBadge = (s) => {
    const name = s.seat_name || '';
    const status = s.seat_status || '';
    const isFull = s.status_no === '4' || status.includes('満席');
    const badgeBg = isFull 
      ? 'bg-rose-50 text-rose-700 border-rose-200' 
      : 'bg-emerald-50 text-emerald-800 border-emerald-300 font-bold';
    const statusIcon = isFull 
      ? '<i class="fa-solid fa-ban text-rose-500"></i>' 
      : '<i class="fa-solid fa-circle-check text-emerald-600"></i>';

    return `
      <div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg border ${badgeBg} text-xs shadow-2xs">
        <span class="truncate pr-2">${name}</span>
        <span class="flex items-center gap-1 flex-shrink-0 text-[11px] font-bold">${statusIcon} ${status}</span>
      </div>
    `;
  };

  const timeStr = formatVacancyTime(timestamp || (vacancyCache.get(String(storeCode)) || {}).timestamp);

  container.innerHTML = `
    <div class="bg-gradient-to-r from-emerald-50/70 to-slate-50 rounded-xl p-3 border border-emerald-200 shadow-2xs space-y-2">
      <!-- 空席ヘッダー: タイトル ＆ 日時 ＆ 更新アクション -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between text-xs pb-2 border-b border-emerald-200/60 gap-1.5">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="font-bold text-slate-800 flex items-center gap-1">
            <i class="fa-solid fa-door-open text-emerald-600"></i>
            <span>リアルタイム空席速報</span>
          </span>
          <span class="text-[11px] font-bold text-emerald-900 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded shadow-2xs">
            🕒 ${timeStr}
          </span>
        </div>
        <div class="flex items-center gap-2 self-end sm:self-auto">
          <button type="button" onclick="refreshStoreVacancy('${storeCode}', event)" 
                  class="text-[11px] text-emerald-700 hover:text-emerald-900 font-bold flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-emerald-100/60 transition" 
                  title="最新の空き状況を再取得">
            <i class="fa-solid fa-rotate-right text-[10px]"></i> 更新
          </button>
          <a href="https://www.kaikatsu.jp/shop/detail/vacancy.html?store_code=${storeCode}" target="_blank" rel="noopener noreferrer" 
             class="text-[11px] text-orange-600 hover:underline flex items-center gap-0.5 font-medium">
            公式詳細 <i class="fa-solid fa-arrow-up-right-from-square text-[9px]"></i>
          </a>
          <button type="button" onclick="toggleStoreVacancy('${storeCode}', event)" class="text-[11px] text-slate-400 hover:text-slate-600 ml-0.5" title="閉じる">
            <i class="fa-solid fa-chevron-up"></i>
          </button>
        </div>
      </div>

      ${keySeats.length > 0 ? `
        <div>
          <div class="text-[10px] font-bold text-emerald-800 mb-1 flex items-center gap-1">
            <i class="fa-solid fa-key text-emerald-600"></i> 鍵付完全個室
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5">
            ${keySeats.map(makeSeatBadge).join('')}
          </div>
        </div>
      ` : ''}

      ${otherSeats.length > 0 ? `
        <div class="pt-1">
          <div class="text-[10px] font-semibold text-slate-500 mb-1">その他席種（ブース・カフェ等）</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5">
            ${otherSeats.map(makeSeatBadge).join('')}
          </div>
        </div>
      ` : ''}

      <div class="text-[10px] text-slate-400 text-right pt-0.5">
        ※更新時刻により実際の空き状況と異なる場合がございます
      </div>
    </div>
  `;
}

async function checkNearMeVacancyBatch() {
  const currentList = Array.from(document.querySelectorAll('.store-card'));
  if (!currentList || currentList.length === 0) {
    showToast('現在表示されている店舗がありません。');
    return;
  }

  // 現在地がある場合は純粋な距離順（お気に入りピン留めを無視）、なければ現在の表示順で上位10店舗を抽出
  let targetCards = [...currentList];
  if (userLocation) {
    targetCards.sort((a, b) => {
      const codeA = a.id.replace('store-', '');
      const codeB = b.id.replace('store-', '');
      const storeA = allStores.find(s => String(s['店舗コード']) === codeA);
      const storeB = allStores.find(s => String(s['店舗コード']) === codeB);
      const distA = storeA ? getStoreDistance(storeA) : 999999;
      const distB = storeB ? getStoreDistance(storeB) : 999999;
      return (distA !== null ? distA : 999999) - (distB !== null ? distB : 999999);
    });
  }

  const topCards = targetCards.slice(0, 10);
  showToast(`⚡ 近い順の上位${topCards.length}店舗の空席情報を一括取得中...`);
  
  const promises = topCards.map(async (card) => {
    const code = card.id.replace('store-', '');
    if (!code) return;
    const container = document.getElementById(`store-vacancy-${code}`);
    const btn = document.getElementById(`vacancy-btn-${code}`);
    if (container) {
      container.classList.remove('hidden');
      container.innerHTML = `
        <div class="bg-emerald-50/50 rounded-lg p-2 border border-emerald-100 flex items-center justify-center gap-1.5 text-xs text-emerald-800">
          <i class="fa-solid fa-circle-notch fa-spin text-emerald-600 text-xs"></i>
          <span>取得中...</span>
        </div>
      `;
    }
    try {
      const data = await fetchStoreVacancy(code);
      if (container) renderVacancyContent(code, data, container);
      if (btn) {
        btn.classList.remove('bg-emerald-50', 'text-emerald-700');
        btn.classList.add('bg-emerald-600', 'text-white');
      }
    } catch (e) {
      if (container) container.classList.add('hidden');
    }
  });

  await Promise.allSettled(promises);
  showToast(`⚡ 近い順の上位${topCards.length}店舗のリアルタイム空席を表示しました！`);
}

// === お気に入り店舗（LocalStorage）管理 ===
const FAV_STORAGE_KEY = 'kaikatsu_fav_stores';

function getFavoriteStores() {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load favorites from localStorage', e);
    return [];
  }
}

function saveFavoriteStores(favList) {
  try {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(favList));
  } catch (e) {
    console.error('Failed to save favorites to localStorage', e);
  }
}

function isFavorite(storeCode) {
  const favList = getFavoriteStores();
  return favList.includes(String(storeCode));
}

function toggleFavorite(storeCode, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const sCode = String(storeCode);
  let favList = getFavoriteStores();
  if (favList.includes(sCode)) {
    favList = favList.filter(id => id !== sCode);
  } else {
    favList.push(sCode);
  }
  saveFavoriteStores(favList);
  updateHeaderFavBadge();
  renderStores();
}

function updateHeaderFavBadge() {
  const favList = getFavoriteStores();
  const badge = document.getElementById('headerFavCountBadge');
  const favBtn = document.getElementById('headerFavBtn');
  if (badge) {
    if (favList.length > 0) {
      badge.textContent = favList.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  if (favBtn) {
    const cb = document.getElementById('favoriteOnlyCheckbox');
    const isFavOnly = cb && cb.checked;
    if (isFavOnly) {
      favBtn.className = 'bg-amber-400 text-slate-900 font-bold px-2 sm:px-3 py-1 sm:py-1.5 rounded-full transition flex items-center gap-1 text-xs shadow-sm active:scale-95 whitespace-nowrap flex-shrink-0';
    } else {
      favBtn.className = 'bg-white/20 hover:bg-white/30 text-white font-medium px-2 sm:px-3 py-1 sm:py-1.5 rounded-full transition flex items-center gap-1 text-xs shadow-sm active:scale-95 whitespace-nowrap flex-shrink-0';
    }
  }
}

function toggleFavoriteFilterFromHeader() {
  const cb = document.getElementById('favoriteOnlyCheckbox');
  if (cb) {
    cb.checked = !cb.checked;
    updateHeaderFavBadge();
    renderStores();
  }
}

// === 誤り報告（Googleフォーム連携） ===
const GOOGLE_FORM_BASE = "https://docs.google.com/forms/d/e/1FAIpQLSfThvH546qVXt1_OCQgZc5duYQt_2qbiW6Yt5Ze2Expr2sWow/viewform";
const ENTRY_STORE_NAME = "entry.66072148";
const ENTRY_ERROR_TYPE = "entry.1702933364";

function openReportForm(storeCode = '', storeName = '', errorType = '料金の誤り') {
  let url = `${GOOGLE_FORM_BASE}?usp=pp_url`;
  if (storeName || storeCode) {
    const fullStoreStr = storeCode ? `${storeName} (店舗コード: ${storeCode})` : storeName;
    url += `&${ENTRY_STORE_NAME}=${encodeURIComponent(fullStoreStr)}`;
  }
  if (errorType) {
    url += `&${ENTRY_ERROR_TYPE}=${encodeURIComponent(errorType)}`;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

let currentReportStore = { code: '', name: '' };

function submitModalToGoogleForm() {
  openReportForm(currentReportStore.code, currentReportStore.name);
  toggleModal('feedbackModal');
}

    // モーダル開閉
    function toggleModal(id, storeName = '', storeCode = '') {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('hidden');
        if (id === 'feedbackModal') {
          currentReportStore = { code: storeCode, name: storeName };
          const displayEl = document.getElementById('reportStoreNameDisplay');
          if (displayEl) {
            displayEl.textContent = storeName ? `${storeName} ${storeCode ? `(コード: ${storeCode})` : ''}` : '全国（全店舗）';
          }
        }
      }
    }

    // === 料金改定速報＆ヒストリー関連ロジック ===
    let currentUpdatesFilter = 'all';

    function openPriceUpdatesModal() {
      currentUpdatesFilter = 'all';
      updateFilterButtonsUI();
      renderPriceUpdatesContent();
      toggleModal('priceUpdatesModal');
    }

    function filterUpdatesModal(type) {
      currentUpdatesFilter = type;
      updateFilterButtonsUI();
      renderPriceUpdatesContent();
    }

    function updateFilterButtonsUI() {
      const btnAll = document.getElementById('btnUpdatesAll');
      const btnDec = document.getElementById('btnUpdatesDec');
      const btnInc = document.getElementById('btnUpdatesInc');
      if (!btnAll || !btnDec || !btnInc) return;

      const baseClass = 'px-2.5 py-1 rounded-full border transition text-[11px]';
      btnAll.className = baseClass;
      btnDec.className = baseClass;
      btnInc.className = baseClass;

      if (currentUpdatesFilter === 'all') {
        btnAll.className += ' bg-orange-600 text-white border-orange-600 font-bold';
        btnDec.className += ' border-slate-300 bg-white text-emerald-700 hover:bg-emerald-50';
        btnInc.className += ' border-slate-300 bg-white text-red-700 hover:bg-red-50';
      } else if (currentUpdatesFilter === 'decrease') {
        btnDec.className += ' bg-emerald-600 text-white border-emerald-600 font-bold';
        btnAll.className += ' border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
        btnInc.className += ' border-slate-300 bg-white text-red-700 hover:bg-red-50';
      } else if (currentUpdatesFilter === 'increase') {
        btnInc.className += ' bg-red-600 text-white border-red-600 font-bold';
        btnAll.className += ' border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
        btnDec.className += ' border-slate-300 bg-white text-emerald-700 hover:bg-emerald-50';
      }
    }

    function renderPriceUpdatesContent() {
      const container = document.getElementById('priceUpdatesModalBody');
      const countEl = document.getElementById('priceUpdatesCount');
      if (!container || !countEl) return;

      // diffs を持っている店舗を抽出
      const storesWithDiff = allStores.filter(s => (s.diffs && s.diffs.length > 0) || s.has_diff);

      // フィルター適用
      const filtered = storesWithDiff.filter(s => {
        const diffs = s.diffs || [];
        const hasDec = diffs.some(d => (d.diff || '').startsWith('-'));
        const hasInc = diffs.some(d => !(d.diff || '').startsWith('-'));
        if (currentUpdatesFilter === 'decrease') return hasDec;
        if (currentUpdatesFilter === 'increase') return hasInc;
        return true;
      });

      // 改定日降順でソート
      filtered.sort((a, b) => {
        const dateA = a.last_price_change_date || '';
        const dateB = b.last_price_change_date || '';
        return dateB.localeCompare(dateA);
      });

      countEl.textContent = filtered.length;

      if (filtered.length === 0) {
        container.innerHTML = `
          <div class="p-6 sm:p-8 text-center text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-200 space-y-2">
            <div class="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-2 text-xl">
              <i class="fa-solid fa-clock-rotate-left"></i>
            </div>
            <div class="font-bold text-slate-800 text-sm">現在、改定検知データはありません</div>
            <p class="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              本サイトの価格改定監視・自動収集システムは <span class="font-bold text-orange-600">2026年10月3日</span> より正式稼働を開始しました！
            </p>
            <p class="text-[11px] text-slate-400">
              明日以降、快活CLUB公式HPで料金変更（値上げ・値下げ）が検知され次第、ここにリアルタイムで速報が自動蓄積されます。
            </p>
          </div>
        `;
        return;
      }

      // 日付ごとに店舗をグループ化
      const groupsByDate = {};
      filtered.forEach(s => {
        const dateKey = s.last_price_change_date || '最近の改定';
        if (!groupsByDate[dateKey]) {
          groupsByDate[dateKey] = [];
        }
        groupsByDate[dateKey].push(s);
      });

      const sortedDates = Object.keys(groupsByDate).sort((a, b) => b.localeCompare(a));

      container.innerHTML = sortedDates.map((dateKey, idx) => {
        const stores = groupsByDate[dateKey];
        const isFirst = idx === 0;
        const accId = `nat-acc-${idx}`;

        const incCount = stores.filter(s => (s.diffs || []).some(d => !(d.diff || '').startsWith('-'))).length;
        const decCount = stores.filter(s => (s.diffs || []).some(d => (d.diff || '').startsWith('-'))).length;

        let dateBadge = '';
        if (decCount > 0 && incCount === 0) {
          dateBadge = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-emerald-300">値下げ ${decCount}店</span>`;
        } else if (incCount > 0 && decCount === 0) {
          dateBadge = `<span class="bg-red-100 text-red-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-red-200">値上げ ${incCount}店</span>`;
        } else {
          dateBadge = `<span class="bg-amber-100 text-amber-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-amber-300">値上げ${incCount} / 値下げ${decCount}</span>`;
        }

        const storeCardsHtml = stores.map(s => {
          const code = s['店舗コード'];
          const name = s['店舗名'];
          const pref = s['都道府県'];
          const city = s['市区町村'];
          const diffs = s['diffs'] || [];
          const hasDec = diffs.some(d => (d.diff || '').startsWith('-'));
          const hasInc = diffs.some(d => !(d.diff || '').startsWith('-') && !(d.diff || '').includes('NEW') && !(d.diff || '').includes('閉店'));
          const isNewStore = diffs.some(d => (d.diff || '').includes('NEW') || (d.item || '').includes('新設'));
          const isClosedStore = s.is_closed || diffs.some(d => (d.diff || '').includes('閉店') || (d.item || '').includes('閉店'));

          let badgeHtml = '';
          if (isNewStore) {
            badgeHtml = '<span class="bg-blue-100 text-blue-800 border border-blue-300 text-[10px] font-bold px-1.5 py-0.2 rounded">🎉 新店舗/個室新設</span>';
          } else if (isClosedStore) {
            badgeHtml = '<span class="bg-slate-200 text-slate-800 border border-slate-300 text-[10px] font-bold px-1.5 py-0.2 rounded">⚠️ 閉店/個室終了</span>';
          } else if (hasDec && !hasInc) {
            badgeHtml = '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold px-1.5 py-0.2 rounded">🎉 値下げ</span>';
          } else if (hasInc && !hasDec) {
            badgeHtml = '<span class="bg-red-100 text-red-800 border border-red-200 text-[10px] font-bold px-1.5 py-0.2 rounded">値上げ</span>';
          } else {
            badgeHtml = '<span class="bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-bold px-1.5 py-0.2 rounded">改定あり</span>';
          }

          const summaryItems = diffs.slice(0, 3).map(d => {
            const isMinus = (d.diff || '').startsWith('-');
            const isNew = (d.diff || '').includes('NEW');
            const isClose = (d.diff || '').includes('閉店');
            let color = 'text-red-700 bg-red-50 border-red-200';
            if (isMinus) color = 'text-emerald-700 bg-emerald-50 border-emerald-200';
            if (isNew) color = 'text-blue-700 bg-blue-50 border-blue-200';
            if (isClose) color = 'text-slate-600 bg-slate-100 border-slate-300';

            const numBefore = Number(d.before);
            const numAfter = Number(d.after);
            const isNumeric = !isNaN(numBefore) && !isNaN(numAfter) && d.before !== '' && d.before !== '-' && d.after !== '' && d.after !== '-';

            let desc = '';
            if (isNumeric) {
              desc = `${d.item}: ${numBefore.toLocaleString()}円→${numAfter.toLocaleString()}円 (${d.diff})`;
            } else if (d.before && d.after && d.before !== '-' && d.after !== '-') {
              desc = `${d.item}: ${d.before}→${d.after} (${d.diff})`;
            } else {
              desc = `${d.item}: ${d.diff}`;
            }
            return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] ${color} font-medium border">${desc}</span>`;
          }).join(' ');

          const actionBtnText = isClosedStore 
            ? '<span class="text-[10px] text-slate-400 font-medium">※営業終了</span>' 
            : '<div class="text-[10px] text-orange-600 font-medium group-hover:underline flex items-center gap-0.5 whitespace-nowrap">カードへ移動 <i class="fa-solid fa-arrow-down text-[9px]"></i></div>';

          return `
            <div onclick="goToStoreFromModal('${code}', ${isClosedStore})" 
                 class="bg-white hover:bg-orange-50/50 p-2.5 sm:p-3 rounded-lg border border-slate-200 hover:border-orange-300 transition cursor-pointer shadow-2xs group">
              <div class="flex justify-between items-start gap-2 mb-1">
                <div>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded">${pref} ${city}</span>
                    <h4 class="font-bold text-slate-900 group-hover:text-orange-600 transition text-xs sm:text-sm flex items-center gap-1">
                      ${name}
                      <i class="fa-solid fa-angle-right text-[10px] text-slate-300 group-hover:text-orange-500 group-hover:translate-x-0.5 transition-transform"></i>
                    </h4>
                    ${badgeHtml}
                  </div>
                </div>
                ${actionBtnText}
              </div>
              <div class="flex flex-wrap gap-1 mt-1">
                ${summaryItems}
                ${diffs.length > 3 ? `<span class="text-[10px] text-slate-400 self-center">他${diffs.length - 3}項目</span>` : ''}
              </div>
            </div>
          `;
        }).join('');

        return `
          <div class="rounded-xl border border-slate-200 overflow-hidden shadow-2xs bg-slate-50/50 mb-3 last:mb-0">
            <button type="button" onclick="toggleHistoryAccordion('${accId}')" 
                    class="w-full py-2.5 px-3 bg-slate-100/80 hover:bg-slate-200/70 flex items-center justify-between transition text-left select-none border-b border-slate-200">
              <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                <i class="fa-regular fa-calendar-check text-orange-600 text-xs"></i>
                <span class="font-bold text-slate-800 text-xs sm:text-sm">${dateKey} 検知</span>
                <span class="text-[10px] sm:text-[11px] text-slate-500 font-medium">(${stores.length}店舗)</span>
                ${dateBadge}
              </div>
              <div class="flex items-center gap-1.5 text-slate-400">
                <span class="text-[10px] text-slate-400 hidden sm:inline" id="label-${accId}">${isFirst ? '閉じる' : '展開'}</span>
                <i id="arrow-${accId}" class="fa-solid fa-chevron-down text-xs transition-transform ${isFirst ? 'rotate-180' : ''}"></i>
              </div>
            </button>
            <div id="${accId}" class="${isFirst ? '' : 'hidden'} p-2 sm:p-2.5 space-y-2">
              ${storeCardsHtml}
            </div>
          </div>
        `;
      }).join('');
    }

    // モーダルから店舗へジャンプ＆ハイライト
    function goToStoreFromModal(storeCode, isClosed) {
      if (isClosed) {
        showToast('※ この店舗は営業終了または完全個室の提供を終了しました');
        return;
      }
      toggleModal('priceUpdatesModal');
      
      const targetStore = allStores.find(s => String(s['店舗コード']) === String(storeCode));
      if (targetStore) {
        let needRerender = false;
        if (selectedPrefs.size > 0 && !selectedPrefs.has(targetStore['都道府県'])) {
          selectedPrefs.clear();
          updatePrefTriggerButton();
          needRerender = true;
        }
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value.trim() !== '') {
          searchInput.value = '';
          needRerender = true;
        }
        if (needRerender) {
          renderStores();
        }
      }

      setTimeout(() => {
        const el = document.getElementById(`store-${storeCode}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-4', 'ring-orange-400', 'bg-orange-50/50');
          setTimeout(() => {
            el.classList.remove('ring-4', 'ring-orange-400', 'bg-orange-50/50');
          }, 2500);
        }
      }, 150);
    }

    // 店舗別改定ヒストリーモーダルを開く
    function openStoreHistoryModal(storeCode) {
      const store = allStores.find(s => String(s['店舗コード']) === String(storeCode));
      if (!store) return;

      document.getElementById('historyModalStoreName').textContent = store['店舗名'];
      document.getElementById('historyModalPrefCity').textContent = `${store['都道府県']} ${store['市区町村']}`;
      document.getElementById('historyModalDate').textContent = store['last_price_change_date'] 
        ? `最終検知日: ${store['last_price_change_date']}` 
        : '直近の改定検知データなし';
      document.getElementById('historyModalOfficialLink').href = `https://www.kaikatsu.jp/shop/detail/${storeCode}.html`;

      const badgeEl = document.getElementById('historyModalBadge');
      const diffs = store['diffs'] || [];
      const hasDec = diffs.some(d => (d.diff || '').startsWith('-'));
      const hasInc = diffs.some(d => !(d.diff || '').startsWith('-'));

      if (diffs.length > 0) {
        if (hasDec && !hasInc) {
          badgeEl.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300';
          badgeEl.textContent = '🎉 値下げあり';
        } else if (hasInc && !hasDec) {
          badgeEl.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-800 border border-red-200';
          badgeEl.textContent = '値上げあり';
        } else {
          badgeEl.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300';
          badgeEl.textContent = '改定あり';
        }
        badgeEl.classList.remove('hidden');
      } else {
        badgeEl.classList.add('hidden');
      }

      const bodyEl = document.getElementById('storeHistoryModalBody');
      if (diffs.length === 0) {
        bodyEl.innerHTML = `
          <div class="p-6 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
            <i class="fa-solid fa-circle-check text-emerald-500 text-3xl"></i>
            <div class="font-bold text-slate-800 text-sm">直近の料金改定はありません</div>
            <p class="text-xs text-slate-500">
              この店舗は <span class="font-bold text-slate-700">2026/10/03（データ収集開始日）</span> 以降、料金の変更がなく安定して稼働しています。
            </p>
          </div>
        `;
      } else {
        // 日付ごとに diffs をグループ化
        const defaultDate = store['last_price_change_date'] || '直近の改定';
        const groupsByDate = {};

        diffs.forEach(d => {
          const dateKey = d.date || defaultDate;
          if (!groupsByDate[dateKey]) {
            groupsByDate[dateKey] = [];
          }
          groupsByDate[dateKey].push(d);
        });

        // 日付の新しい順にソート
        const sortedDates = Object.keys(groupsByDate).sort((a, b) => b.localeCompare(a));

        const accordionsHtml = sortedDates.map((dateKey, idx) => {
          const items = groupsByDate[dateKey];
          const isFirst = idx === 0; // 最新日は初期オープン
          const accId = `hist-acc-${storeCode}-${idx}`;

          const groupInc = items.filter(d => !(d.diff || '').startsWith('-')).length;
          const groupDec = items.filter(d => (d.diff || '').startsWith('-')).length;

          let groupBadge = '';
          if (groupDec > 0 && groupInc === 0) {
            groupBadge = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-emerald-300">値下げ ${groupDec}件</span>`;
          } else if (groupInc > 0 && groupDec === 0) {
            groupBadge = `<span class="bg-red-100 text-red-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-red-200">値上げ ${groupInc}件</span>`;
          } else {
            groupBadge = `<span class="bg-amber-100 text-amber-800 text-[10px] font-bold px-1.5 py-0.2 rounded border border-amber-300">値上げ${groupInc} / 値下げ${groupDec}</span>`;
          }

          const rowsHtml = items.map(d => {
            const isMinus = (d.diff || '').startsWith('-');
            const diffColor = isMinus ? 'text-emerald-700 bg-emerald-50 font-bold' : 'text-red-700 bg-red-50 font-bold';
            return `
              <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                <td class="py-2 px-2.5 font-medium text-slate-800">${d.item}</td>
                <td class="py-2 px-2 text-right text-slate-400 line-through">${Number(d.before).toLocaleString()}円</td>
                <td class="py-2 px-2 text-right font-bold text-slate-900">${Number(d.after).toLocaleString()}円</td>
                <td class="py-2 px-2.5 text-right">
                  <span class="inline-block px-1.5 py-0.2 rounded text-[11px] ${diffColor}">${d.diff}</span>
                </td>
              </tr>
            `;
          }).join('');

          return `
            <div class="rounded-xl border border-slate-200 overflow-hidden shadow-2xs bg-white mb-2.5 last:mb-0">
              <button type="button" onclick="toggleHistoryAccordion('${accId}')" 
                      class="w-full py-2.5 px-3 bg-slate-50 hover:bg-slate-100 flex items-center justify-between transition text-left select-none border-b border-slate-200">
                <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                  <i class="fa-regular fa-calendar-check text-orange-600 text-xs"></i>
                  <span class="font-bold text-slate-800 text-xs sm:text-sm">${dateKey} 検知</span>
                  <span class="text-[10px] sm:text-[11px] text-slate-500 font-medium">(${items.length}項目改定)</span>
                  ${groupBadge}
                </div>
                <div class="flex items-center gap-1.5 text-slate-400">
                  <span class="text-[10px] text-slate-400 hidden sm:inline" id="label-${accId}">${isFirst ? '閉じる' : '展開'}</span>
                  <i id="arrow-${accId}" class="fa-solid fa-chevron-down text-xs transition-transform ${isFirst ? 'rotate-180' : ''}"></i>
                </div>
              </button>
              <div id="${accId}" class="${isFirst ? '' : 'hidden'} overflow-x-auto">
                <table class="w-full text-xs">
                  <thead class="bg-slate-50/80 text-slate-600 border-b border-slate-200 text-[11px]">
                    <tr>
                      <th class="py-2 px-2.5 text-left font-bold">対象パック・項目</th>
                      <th class="py-2 px-2 text-right font-semibold">改定前</th>
                      <th class="py-2 px-2 text-right font-semibold">改定後</th>
                      <th class="py-2 px-2.5 text-right font-bold">変動額</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rowsHtml}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        }).join('');

        bodyEl.innerHTML = `
          <div class="bg-amber-50/60 p-2.5 rounded-lg border border-amber-200/80 text-[11px] text-amber-900 mb-2.5 flex items-center justify-between">
            <span class="font-bold">改定履歴: 全 ${sortedDates.length} 回 / 計 ${diffs.length} 項目</span>
            <span class="text-[10px] text-amber-700">※ 各改定日をクリックで開閉できます</span>
          </div>
          <div>
            ${accordionsHtml}
          </div>
        `;
      }

      toggleModal('storeHistoryModal');
    }

    function toggleHistoryAccordion(id) {
      const bodyEl = document.getElementById(id);
      const arrowEl = document.getElementById(`arrow-${id}`);
      const labelEl = document.getElementById(`label-${id}`);
      if (bodyEl && arrowEl) {
        const isHidden = bodyEl.classList.contains('hidden');
        bodyEl.classList.toggle('hidden');
        arrowEl.classList.toggle('rotate-180', isHidden);
        if (labelEl) {
          labelEl.textContent = isHidden ? '閉じる' : '展開';
        }
      }
    }

    function updateHeaderDiffBadge() {
      const badge = document.getElementById('headerDiffCountBadge');
      if (!badge) return;
      const count = allStores.filter(s => (s.diffs && s.diffs.length > 0) || s.has_diff).length;
      if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    // アコーディオン開閉（スマホ用全パック）
    function toggleStoreDetails(storeCode) {
      const detailsEl = document.getElementById(`details-${storeCode}`);
      const btnEl = document.getElementById(`btn-details-${storeCode}`);
      const arrowEl = document.getElementById(`arrow-details-${storeCode}`);
      if (detailsEl) {
        const isHidden = detailsEl.classList.contains('hidden');
        detailsEl.classList.toggle('hidden');
        if (btnEl && arrowEl) {
          btnEl.querySelector('.btn-text').textContent = isHidden ? '閉じる' : '全パック料金を見る';
          arrowEl.classList.toggle('rotate-180', isHidden);
        }
      }
    }

    // 地方と都道府県の定義（グルーピング）
    const REGIONS = [
      { name: "北海道", prefs: ["北海道"] },
      { name: "東北", prefs: ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"] },
      { name: "関東", prefs: ["東京都", "神奈川県", "埼玉県", "千葉県", "茨城県", "栃木県", "群馬県"] },
      { name: "上信越・北陸", prefs: ["新潟県", "長野県", "山梨県", "富山県", "石川県", "福井県"] },
      { name: "東海", prefs: ["愛知県", "静岡県", "三重県", "岐阜県"] },
      { name: "関西", prefs: ["大阪府", "兵庫県", "京都府", "滋賀県", "奈良県", "和歌山県"] },
      { name: "中国", prefs: ["鳥取県", "島根県", "岡山県", "広島県", "山口県"] },
      { name: "四国", prefs: ["徳島県", "香川県", "愛媛県", "高知県"] },
      { name: "九州・沖縄", prefs: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"] },
    ];

    let selectedPrefs = new Set();
    let tempSelectedPrefs = new Set();

    // 都道府県選択モーダル開閉
    function togglePrefModal() {
      const modal = document.getElementById('prefModal');
      const isHidden = modal.classList.contains('hidden');
      if (isHidden) {
        tempSelectedPrefs = new Set(selectedPrefs);
        renderPrefModalContent();
        modal.classList.remove('hidden');
      } else {
        modal.classList.add('hidden');
      }
    }

    // 都道府県モーダルの中身を描画
    function renderPrefModalContent() {
      const container = document.getElementById('prefModalBody');
      const countEl = document.getElementById('prefModalSelectedCount');
      if (countEl) countEl.textContent = tempSelectedPrefs.size;

      // 各都道府県の店舗数を集計
      const storeCounts = {};
      allStores.forEach(s => {
        const p = s['都道府県'];
        if (p) storeCounts[p] = (storeCounts[p] || 0) + 1;
      });

      container.innerHTML = REGIONS.map((reg, regIdx) => {
        const regStoresCount = reg.prefs.reduce((acc, p) => acc + (storeCounts[p] || 0), 0);

        const chipsHtml = reg.prefs.map(p => {
          const cnt = storeCounts[p] || 0;
          const isChecked = tempSelectedPrefs.has(p);
          const activeClass = isChecked 
            ? 'bg-orange-500 text-white border-orange-600 font-bold shadow-xs' 
            : 'bg-white text-slate-700 border-slate-200 hover:border-orange-300 hover:bg-orange-50/50';

          return `
            <button type="button" onclick="togglePrefChip('${p}')" 
                    class="pref-chip px-2.5 py-1.5 rounded-lg border text-xs flex items-center justify-between gap-1 transition select-none ${activeClass}">
              <span>${p}</span>
              <span class="text-[10px] ${isChecked ? 'text-white/80' : 'text-slate-400'}">(${cnt})</span>
            </button>
          `;
        }).join('');

        return `
          <div class="bg-slate-50/80 rounded-xl p-3 border border-slate-200/80">
            <div class="flex justify-between items-center mb-2 pb-1.5 border-b border-slate-200/60">
              <div class="font-bold text-slate-800 flex items-center gap-1.5 text-xs sm:text-sm">
                <span class="w-1.5 h-3.5 bg-orange-500 rounded-full inline-block"></span>
                <span>${reg.name}</span>
                <span class="text-[11px] font-normal text-slate-500">(${regStoresCount}店舗)</span>
              </div>
              <div class="flex items-center gap-2 text-[11px]">
                <button type="button" onclick="toggleRegionPrefs(${regIdx}, true)" class="text-orange-600 hover:underline font-medium">この地方を選択</button>
                <span class="text-slate-300">/</span>
                <button type="button" onclick="toggleRegionPrefs(${regIdx}, false)" class="text-slate-400 hover:text-slate-600 hover:underline">解除</button>
              </div>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
              ${chipsHtml}
            </div>
          </div>
        `;
      }).join('');
    }

    function togglePrefChip(pref) {
      if (tempSelectedPrefs.has(pref)) {
        tempSelectedPrefs.delete(pref);
      } else {
        tempSelectedPrefs.add(pref);
      }
      renderPrefModalContent();
    }

    function toggleRegionPrefs(regIdx, isSelect) {
      const reg = REGIONS[regIdx];
      if (!reg) return;
      reg.prefs.forEach(p => {
        if (isSelect) tempSelectedPrefs.add(p);
        else tempSelectedPrefs.delete(p);
      });
      renderPrefModalContent();
    }

    function selectAllPrefs() {
      REGIONS.forEach(r => r.prefs.forEach(p => tempSelectedPrefs.add(p)));
      renderPrefModalContent();
    }

    function clearAllPrefs() {
      tempSelectedPrefs.clear();
      renderPrefModalContent();
    }

    function applyPrefSelection() {
      selectedPrefs = new Set(tempSelectedPrefs);
      updatePrefTriggerButton();
      renderStores();
      togglePrefModal();
    }

    function updatePrefTriggerButton() {
      const labelEl = document.getElementById('prefTriggerLabel');
      const badgeEl = document.getElementById('prefSelectedCountBadge');
      
      const count = selectedPrefs.size;
      if (count === 0) {
        labelEl.textContent = 'すべての都道府県';
        badgeEl.classList.add('hidden');
      } else {
        const arr = Array.from(selectedPrefs);
        if (count === 1) {
          labelEl.textContent = `${arr[0]}`;
        } else if (count <= 2) {
          labelEl.textContent = arr.join(', ');
        } else {
          labelEl.textContent = `${arr[0]}, ${arr[1]} +他${count - 2}県`;
        }
        badgeEl.textContent = count;
        badgeEl.classList.remove('hidden');
      }
    }

    // === URLパラメータ同期・復元・共有機能 ===
    function syncUrlParams() {
      const params = new URLSearchParams();

      // 都道府県
      if (selectedPrefs && selectedPrefs.size > 0) {
        params.set('pref', Array.from(selectedPrefs).join(','));
      }

      // キーワード検索
      const searchInput = document.getElementById('searchInput');
      if (searchInput && searchInput.value.trim()) {
        params.set('q', searchInput.value.trim());
      }

      // ソート順
      const sortSelect = document.getElementById('sortSelect');
      if (sortSelect && sortSelect.value !== 'default') {
        params.set('sort', sortSelect.value);
      }

      // チェックボックス
      const cbs = Array.from(document.querySelectorAll('.filter-cb:checked')).map(cb => cb.value);
      if (cbs.includes('favorite_only')) {
        params.set('fav', '1');
      }
      if (cbs.includes('decrease_only')) {
        params.set('dec', '1');
      }
      if (cbs.includes('night_pack_only')) {
        params.set('night', '1');
      }
      const amenityCbs = cbs.filter(c => !['favorite_only', 'decrease_only', 'night_pack_only'].includes(c));
      if (amenityCbs.length > 0) {
        params.set('amenity', amenityCbs.join(','));
      }

      const queryString = params.toString();
      const newUrl = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }

    function restoreFromUrlParams() {
      const params = new URLSearchParams(window.location.search);
      if (!params || params.toString() === '') return;

      // 都道府県復元
      if (params.has('pref')) {
        const prefList = params.get('pref').split(',').map(s => s.trim()).filter(Boolean);
        prefList.forEach(p => selectedPrefs.add(p));
        updatePrefTriggerButton();
      }

      // キーワード検索
      if (params.has('q')) {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = params.get('q');
      }

      // ソート順
      const sortSelect = document.getElementById('sortSelect');
      if (params.has('sort')) {
        const sortVal = params.get('sort');
        if (sortSelect) sortSelect.value = sortVal;
      } else {
        // パラメータ未指定時（初回アクセス）: デフォルトで現在地から近い順
        if (sortSelect) sortSelect.value = 'distance_asc';
      }

      // チェックボックス
      const targetCbs = new Set();
      if (params.get('fav') === '1') targetCbs.add('favorite_only');
      if (params.get('dec') === '1') targetCbs.add('decrease_only');
      if (params.get('night') === '1') targetCbs.add('night_pack_only');
      if (params.has('amenity')) {
        params.get('amenity').split(',').map(s => s.trim()).filter(Boolean).forEach(a => targetCbs.add(a));
      }

      if (targetCbs.size > 0) {
        document.querySelectorAll('.filter-cb').forEach(cb => {
          if (targetCbs.has(cb.value)) {
            cb.checked = true;
          }
        });
        // 設備フィルターを自動展開
        const amenityFiltersContainer = document.getElementById('amenityFiltersContainer');
        const filterArrow = document.getElementById('filterArrow');
        if (amenityFiltersContainer && amenityFiltersContainer.classList.contains('hidden')) {
          amenityFiltersContainer.classList.remove('hidden');
          if (filterArrow) filterArrow.classList.add('rotate-180');
        }
      }
    }

    // ワンタップ条件共有（Web Share API / クリップボードコピー）
    async function shareCurrentConditions() {
      syncUrlParams();
      const shareUrl = window.location.href;
      const count = document.getElementById('matchCount') ? document.getElementById('matchCount').textContent : (allStores.length || '');
      const shareData = {
        title: '快活CLUB 鍵付完全個室ナビ',
        text: `【快活CLUB 完全個室ナビ】条件に該当する店舗: ${count}件が見つかりました！`,
        url: shareUrl
      };

      // スマホのネイティブ共有機能が使える場合
      if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          // 共有キャンセル時は何もしない
          if (err.name === 'AbortError') return;
        }
      }

      // クリップボードにコピー
      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('共有リンクをクリップボードにコピーしました！✨');
      } catch (err) {
        // フォールバック
        const input = document.createElement('input');
        input.value = shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('共有リンクをクリップボードにコピーしました！✨');
      }
    }

    let toastTimer = null;
    function showToast(msg) {
      const toast = document.getElementById('toastNotification');
      const msgEl = document.getElementById('toastMessage');
      if (!toast) return;
      if (msgEl && msg) msgEl.textContent = msg;

      toast.classList.remove('translate-y-12', 'opacity-0', 'pointer-events-none');
      toast.classList.add('translate-y-0', 'opacity-100');

      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-12', 'opacity-0', 'pointer-events-none');
      }, 3000);
    }

    // データ読み込み
    async function loadData() {
      try {
        const resp = await fetch('stores.json?t=' + Date.now());
        allStores = await resp.json();
        restoreFromUrlParams();

        const sortSelect = document.getElementById('sortSelect');
        const currentSort = sortSelect ? sortSelect.value : 'distance_asc';

        if (currentSort === 'distance_asc' && !userLocation) {
          const container = document.getElementById('storeList');
          if (container) {
            container.innerHTML = `
              <div class="bg-white rounded-2xl p-8 border border-slate-200 text-center shadow-xs my-6 space-y-3">
                <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-1">
                  <i class="fa-solid fa-location-crosshairs text-xl animate-spin"></i>
                </div>
                <h3 class="text-sm font-bold text-slate-800">現在地から近い順に店舗を探しています...</h3>
                <p class="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">
                  位置情報の利用を許可すると、最も近い快活CLUBが最上部に並びます。<br>
                  <span class="text-[11px] text-slate-400">※ 未許可や取得できない場合は、自動で都道府県順に切り替わります</span>
                </p>
              </div>
            `;
          }
          await requestNearMeSearch(true);
        } else {
          renderStores();
        }

        updateHeaderDiffBadge();
        updateHeaderFavBadge();
      } catch (err) {
        console.error('Failed to load stores.json:', err);
        document.getElementById('storeList').innerHTML = `
          <div class="p-8 text-center bg-red-50 text-red-700 rounded-xl border border-red-200 text-xs sm:text-sm">
            データの読み込みに失敗しました。ローカルHTTPサーバー経由で開いているか確認してください。
          </div>
        `;
      }
    }

    // レンダリング (レスポンシブ：PCはワイドテーブル、スマホはハイブリッド最適化)
    function renderStores() {
      syncUrlParams();
      const search = document.getElementById('searchInput').value.trim().toLowerCase();
      const sort = document.getElementById('sortSelect').value;
      
      const cbs = Array.from(document.querySelectorAll('.filter-cb:checked')).map(cb => cb.value);
      const favOnly = cbs.includes('favorite_only');
      const decOnly = cbs.includes('decrease_only');
      const nightOnly = cbs.includes('night_pack_only');
      const amenityCbs = cbs.filter(c => c !== 'favorite_only' && c !== 'decrease_only' && c !== 'night_pack_only');

      // フィルターバッジ表示
      const activeBadge = document.getElementById('filterActiveBadge');
      if (activeBadge) {
        activeBadge.classList.toggle('hidden', cbs.length === 0);
      }

      const favSet = new Set(getFavoriteStores());
      const hasDecrease = (s) => (s['diffs'] || []).some(d => (d.diff || '').startsWith('-'));
      const hasNight = (s) => {
        const keys = ['平日_ナイト8h', '週末_ナイト8h', '平日_ナイト12h', '週末_ナイト12h'];
        return keys.some(k => s[k] && s[k] !== '-' && s[k] !== '');
      };

      let filtered = allStores.filter(s => {
        if (s.is_closed) return false;
        const sCode = String(s['店舗コード']);
        if (favOnly && !favSet.has(sCode)) return false;

        if (search) {
          const matchName = (s['店舗名'] || '').toLowerCase().includes(search);
          const matchCity = (s['市区町村'] || '').toLowerCase().includes(search);
          const matchAddr = (s['住所'] || '').toLowerCase().includes(search);
          if (!matchName && !matchCity && !matchAddr) return false;
        }

        // 都道府県複数選択フィルター
        if (selectedPrefs.size > 0 && !selectedPrefs.has(s['都道府県'])) return false;

        if (decOnly && !hasDecrease(s)) return false;
        if (nightOnly && !hasNight(s)) return false;

        for (const a of amenityCbs) {
          if (!s[a]) return false;
        }

        return true;
      });

      // ソート処理（指定条件でソート後、お気に入り店舗★を最上部にピン留め）
      if (sort === 'distance_asc') {
        filtered.sort((a, b) => {
          const distA = getStoreDistance(a);
          const distB = getStoreDistance(b);
          return (distA !== null ? distA : 999999) - (distB !== null ? distB : 999999);
        });
      } else if (sort === 'weekday3h_asc') {
        filtered.sort((a, b) => (parseInt(a['平日_3hパック']) || 99999) - (parseInt(b['平日_3hパック']) || 99999));
      } else if (sort === 'weekend3h_asc') {
        filtered.sort((a, b) => (parseInt(a['週末_3hパック']) || 99999) - (parseInt(b['週末_3hパック']) || 99999));
      } else if (sort === 'weekday6h_asc') {
        filtered.sort((a, b) => (parseInt(a['平日_6hパック']) || 99999) - (parseInt(b['平日_6hパック']) || 99999));
      } else if (sort === 'decrease_desc') {
        filtered.sort((a, b) => (hasDecrease(b) ? 1 : 0) - (hasDecrease(a) ? 1 : 0));
      }

      // お気に入りを最優先で最上部に固定（安定ソート）
      filtered.sort((a, b) => {
        const aFav = favSet.has(String(a['店舗コード'])) ? 1 : 0;
        const bFav = favSet.has(String(b['店舗コード'])) ? 1 : 0;
        return bFav - aFav;
      });

      document.getElementById('matchCount').textContent = filtered.length;
      const totalCountEl = document.getElementById('totalStoreCount');
      if (totalCountEl && allStores.length > 0) {
        const activeCount = allStores.filter(s => !s.is_closed).length;
        totalCountEl.textContent = `全${activeCount}`;
      }

      const container = document.getElementById('storeList');
      if (filtered.length === 0) {
        if (favOnly) {
          container.innerHTML = `
            <div class="p-8 sm:p-12 text-center text-slate-500 bg-white rounded-xl border border-dashed border-amber-300 space-y-2">
              <i class="fa-regular fa-star text-3xl sm:text-4xl text-amber-400"></i>
              <div class="font-bold text-slate-800 text-sm sm:text-base">お気に入り店舗がまだ登録されていません</div>
              <p class="text-xs text-slate-500 max-w-sm mx-auto">
                店舗カードの右上にある「★ 保存」ボタンを押すと、お気に入りに登録して最上部に固定できます！
              </p>
            </div>
          `;
        } else {
          container.innerHTML = `
            <div class="p-8 sm:p-12 text-center text-slate-400 bg-white rounded-xl border border-dashed border-slate-300">
              <i class="fa-solid fa-magnifying-glass text-2xl sm:text-3xl mb-2"></i>
              <p class="text-xs sm:text-sm">条件に一致する店舗が見つかりませんでした。</p>
            </div>
          `;
        }
        return;
      }

      container.innerHTML = filtered.map(s => {
        const code = s['店舗コード'];
        const name = s['店舗名'];
        const pref = s['都道府県'];
        const city = s['市区町村'];
        const addr = s['住所'];
        const tel = s['電話番号'];
        const hasDiff = s['has_diff'];
        const diffs = s['diffs'] || [];
        const weekendNote = s['週末料金注記'];

        const diffItemMap = {};
        diffs.forEach(d => { diffItemMap[d.item] = d.diff; });

        // 設備バッジ一覧（公式準拠のフルラインナップ）
        const badges = [];
        if (s['個室WEB予約']) badges.push('<a href="https://reservation.kaikatsu.jp/" target="_blank" rel="noopener noreferrer" class="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold px-2 py-0.5 rounded text-[10px] sm:text-[11px] shadow-sm transition inline-flex items-center gap-1 active:scale-95" title="公式WEB予約ページを開く">📱 WEB予約可 <i class="fa-solid fa-arrow-up-right-from-square text-[9px] text-amber-100"></i></a>');
        if (s['無料トースト']) badges.push('<span class="bg-amber-100 text-amber-950 border border-amber-300 font-bold px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] shadow-xs" title="東海3県（愛知・岐阜・三重）限定！無料トースト食べ放題">🍞 無料トースト</span>');
        if (s['VIPルーム'] || s['VIPフラット']) badges.push('<span class="bg-amber-50 text-amber-800 border border-amber-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold">👑 VIPルーム</span>');
        if (s['ワイドルーム']) badges.push('<span class="badge-room px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold">🛋️ ワイド</span>');
        if (s['無料シャワー']) badges.push('<span class="bg-sky-50 text-sky-800 border border-sky-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🚿 無料シャワー</span>');
        if (s['有料シャワー']) badges.push('<span class="bg-slate-100 text-slate-700 border border-slate-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🚿 有料シャワー</span>');
        if (s['駐車場']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🚗 駐車場</span>');
        if (s['100円モーニング']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🍳 100円モーニング</span>');
        if (s['ソフトクリーム']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🍦 ソフトクリーム</span>');
        if (s['コインランドリー']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🧺 ランドリー</span>');
        if (s['飲み放題カフェ']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">☕ カフェ</span>');
        if (s['カラオケ']) badges.push('<span class="bg-blue-50 text-blue-800 border border-blue-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🎤 カラオケ</span>');
        if (s['ダーツ']) badges.push('<span class="bg-purple-50 text-purple-800 border border-purple-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🎯 ダーツ</span>');
        if (s['ビリヤード']) badges.push('<span class="bg-indigo-50 text-indigo-800 border border-indigo-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🎱 ビリヤード</span>');
        if (s['ファミリールーム']) badges.push('<span class="badge-room px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">👨‍👩‍👧 ファミリー</span>');
        if (s['マッサージ']) badges.push('<span class="badge-room px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">💆 マッサージ</span>');
        if (s['アルコール販売']) badges.push('<span class="badge-service px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🍺 アルコール</span>');
        if (s['加熱式たばこエリア']) badges.push('<span class="bg-slate-100 text-slate-600 border border-slate-200 px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px]">🚬 喫煙エリア</span>');

        // 差分の内訳（値上げ・値下げ）判定
        const incDiffs = diffs.filter(d => !(d.diff || '').startsWith('-'));
        const decDiffs = diffs.filter(d => (d.diff || '').startsWith('-'));
        const hasInc = incDiffs.length > 0;
        const hasDec = decDiffs.length > 0;

        // 改定サマリーバナー
        let diffBanner = '';
        if (hasDiff) {
          const changeDateStr = s['last_price_change_date'] ? `${s['last_price_change_date']}検知 / ` : '';
          
          if (hasDec && !hasInc) {
            // 純粋な値下げのみ！
            diffBanner = `
              <div onclick="openStoreHistoryModal('${code}')" class="cursor-pointer bg-emerald-50 hover:bg-emerald-100/70 border border-emerald-300 rounded-lg px-2.5 py-1.5 text-xs text-emerald-800 flex items-center justify-between transition shadow-2xs group">
                <div class="flex items-center gap-1.5 font-bold text-[11px] sm:text-xs">
                  <i class="fa-solid fa-arrow-trend-down text-emerald-600"></i>
                  <span>直近で値下げあり！ (${changeDateStr}${decDiffs.length}項目値下げ 🎉)</span>
                </div>
                <div class="flex items-center gap-2">
                  <div class="text-[10px] sm:text-[11px] text-emerald-700 truncate max-w-[160px] sm:max-w-none hidden sm:block">
                    ${decDiffs.map(d => `${d.item} ${Number(d.before).toLocaleString()}円→${Number(d.after).toLocaleString()}円 (${d.diff})`).slice(0, 2).join(' / ')}${decDiffs.length > 2 ? ' ...他' : ''}
                  </div>
                  <span class="text-[10px] sm:text-[11px] text-emerald-800 font-bold group-hover:underline flex items-center gap-0.5 whitespace-nowrap">
                    内訳 <i class="fa-solid fa-chevron-right text-[9px]"></i>
                  </span>
                </div>
              </div>
            `;
          } else if (hasInc && !hasDec) {
            // 値上げのみ
            diffBanner = `
              <div onclick="openStoreHistoryModal('${code}')" class="cursor-pointer bg-red-50 hover:bg-red-100/70 border border-red-200 rounded-lg px-2.5 py-1.5 text-xs text-red-800 flex items-center justify-between transition shadow-2xs group">
                <div class="flex items-center gap-1.5 font-bold text-[11px] sm:text-xs">
                  <i class="fa-solid fa-arrow-trend-up text-red-600"></i>
                  <span>直近で価格改定あり (${changeDateStr}${incDiffs.length}項目値上げ)</span>
                </div>
                <div class="flex items-center gap-2">
                  <div class="text-[10px] sm:text-[11px] text-red-600 truncate max-w-[160px] sm:max-w-none hidden sm:block">
                    ${incDiffs.map(d => `${d.item} ${Number(d.before).toLocaleString()}円→${Number(d.after).toLocaleString()}円`).slice(0, 2).join(' / ')}${incDiffs.length > 2 ? ' ...他' : ''}
                  </div>
                  <span class="text-[10px] sm:text-[11px] text-red-800 font-bold group-hover:underline flex items-center gap-0.5 whitespace-nowrap">
                    内訳 <i class="fa-solid fa-chevron-right text-[9px]"></i>
                  </span>
                </div>
              </div>
            `;
          } else if (hasInc && hasDec) {
            // 混在
            diffBanner = `
              <div onclick="openStoreHistoryModal('${code}')" class="cursor-pointer bg-amber-50 hover:bg-amber-100/70 border border-amber-200 rounded-lg px-2.5 py-1.5 text-xs text-amber-900 flex items-center justify-between transition shadow-2xs group">
                <div class="flex items-center gap-1.5 font-bold text-[11px] sm:text-xs">
                  <i class="fa-solid fa-arrows-up-down text-amber-600"></i>
                  <span>直近で価格改定あり (${changeDateStr}値上げ${incDiffs.length} / 値下げ${decDiffs.length})</span>
                </div>
                <div class="flex items-center gap-2">
                  <div class="text-[10px] sm:text-[11px] text-amber-700 truncate max-w-[160px] sm:max-w-none hidden sm:block">
                    ${diffs.map(d => `${d.item} ${Number(d.before).toLocaleString()}円→${Number(d.after).toLocaleString()}円 (${d.diff})`).slice(0, 2).join(' / ')}${diffs.length > 2 ? ' ...他' : ''}
                  </div>
                  <span class="text-[10px] sm:text-[11px] text-amber-900 font-bold group-hover:underline flex items-center gap-0.5 whitespace-nowrap">
                    内訳 <i class="fa-solid fa-chevron-right text-[9px]"></i>
                  </span>
                </div>
              </div>
            `;
          }
        }

        const formatFee = (val) => {
          if (!val || val === '-' || val === 'None' || val === 'NaN') return '-';
          const num = parseInt(val);
          return isNaN(num) ? '-' : `${num.toLocaleString()}円`;
        };

        const renderFeeCell = (key, isBold = false) => {
          const val = s[key];
          if (!val || val === '-' || val === 'None' || val === 'NaN') return '<span class="text-slate-300">-</span>';
          const num = parseInt(val);
          if (isNaN(num)) return '<span class="text-slate-300">-</span>';
          const feeStr = `${num.toLocaleString()}円`;
          if (diffItemMap[key]) {
            const diffVal = diffItemMap[key];
            const isMinus = diffVal.startsWith('-');
            const colorClass = isMinus ? 'text-emerald-600' : 'text-red-600';
            const subColorClass = isMinus ? 'text-emerald-500' : 'text-red-500';
            return `
              <div class="font-bold ${colorClass}">
                ${feeStr}
                <span class="text-[8px] sm:text-[9px] font-normal block leading-tight ${subColorClass}">${diffVal}</span>
              </div>
            `;
          }
          return `<span class="${isBold ? 'font-bold text-slate-900' : 'text-slate-700'}">${feeStr}</span>`;
        };

        const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pref + ' ' + name + ' ' + addr)}`;

        // タイトル横の改定ミニバッジ
        let diffMiniBadge = '';
        if (hasDiff) {
          if (hasDec && !hasInc) {
            diffMiniBadge = '<span class="text-[9px] sm:text-[10px] bg-emerald-600 text-white px-1.5 py-0.2 rounded-full font-bold">🎉 値下げあり</span>';
          } else if (hasInc && !hasDec) {
            diffMiniBadge = '<span class="text-[9px] sm:text-[10px] bg-red-600 text-white px-1.5 py-0.2 rounded-full font-bold">値上げあり</span>';
          } else {
            diffMiniBadge = '<span class="text-[9px] sm:text-[10px] bg-amber-600 text-white px-1.5 py-0.2 rounded-full font-bold">価格改定あり</span>';
          }
        }

        // 住所横の改定日チップ
        let dateChip = '';
        if (s['last_price_change_date']) {
          if (hasDec && !hasInc) {
            dateChip = `<span class="inline-flex items-center gap-1 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-300 px-1.5 py-0.2 rounded font-medium"><i class="fa-regular fa-calendar-check text-[10px] text-emerald-600"></i> 最終値下げ: ${s['last_price_change_date']}</span>`;
          } else if (hasInc && !hasDec) {
            dateChip = `<span class="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded font-medium"><i class="fa-regular fa-calendar-check text-[10px]"></i> 最終値上げ: ${s['last_price_change_date']}</span>`;
          } else {
            dateChip = `<span class="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded font-medium"><i class="fa-regular fa-calendar-check text-[10px]"></i> 最終改定: ${s['last_price_change_date']}</span>`;
          }
        }

        const isFav = favSet.has(String(code));
        const favBtnClass = isFav 
          ? 'text-amber-500 bg-amber-50 hover:bg-amber-100 border border-amber-300 font-bold' 
          : 'text-slate-400 hover:text-amber-500 hover:bg-slate-50 border border-transparent';
        const cardBorderClass = isFav 
          ? 'border-amber-300 ring-2 ring-amber-300/40 shadow-sm' 
          : 'border-slate-200';

        const storeDist = getStoreDistance(s);
        const distBadge = (userLocation && storeDist !== null) 
          ? `<a href="${mapUrl}" target="_blank" rel="noopener noreferrer" class="text-[10px] sm:text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition px-1.5 py-0.5 rounded flex items-center gap-1 shadow-2xs" title="現在地からの直線距離（クリックでルート案内）"><i class="fa-solid fa-location-arrow text-[10px] text-blue-600"></i> ${formatDistance(storeDist)}</a>`
          : '';

        return `
          <div id="store-${code}" class="store-card bg-white rounded-xl shadow-sm border ${cardBorderClass} p-3.5 sm:p-5 hover:shadow-md transition duration-300 relative">
            
            <!-- 上段: 店舗名 & バッジ & アクション -->
            <div class="flex flex-col sm:flex-row justify-between items-start gap-2.5 pb-2.5 border-b border-slate-100">
              <div class="w-full sm:w-auto">
                <div class="flex items-center gap-1.5 sm:gap-2 mb-1 flex-wrap">
                  <span class="text-[10px] sm:text-xs font-bold text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">${pref} ${city}</span>
                  ${distBadge}
                  <h3 class="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                    <a href="https://www.kaikatsu.jp/shop/detail/${code}.html" target="_blank" rel="noopener noreferrer" 
                       class="hover:text-orange-600 transition inline-flex items-center gap-1.5">
                       ${name}
                      <i class="fa-solid fa-arrow-up-right-from-square text-[11px] text-slate-400"></i>
                    </a>
                  </h3>
                  ${isFav ? '<span class="text-[10px] bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.2 rounded font-bold flex items-center gap-0.5"><i class="fa-solid fa-star text-amber-500 text-[9px]"></i> お気に入り</span>' : ''}
                  ${diffMiniBadge ? `<span onclick="openStoreHistoryModal('${code}')" class="cursor-pointer hover:opacity-80 transition">${diffMiniBadge}</span>` : ''}
                </div>
                
                <div class="flex items-center gap-2 sm:gap-3 text-xs text-slate-500 flex-wrap">
                  <a href="${mapUrl}" target="_blank" rel="noopener noreferrer" 
                     class="hover:text-orange-600 hover:underline flex items-center gap-1 text-slate-600 text-[11px] sm:text-xs" title="Googleマップで開く">
                    <i class="fa-solid fa-location-dot text-orange-500"></i>
                    <span class="truncate max-w-[240px] sm:max-w-none">${addr}</span>
                  </a>
                  ${tel ? `
                    <a href="tel:${tel.replace(/[^0-9]/g, '')}" class="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-orange-600 hover:underline" title="電話をかける">
                      <i class="fa-solid fa-phone text-slate-400"></i> ${tel}
                    </a>
                  ` : ''}
                  ${dateChip}
                </div>
              </div>

              <!-- 右上/スマホ下部のアクションボタン -->
              <div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 w-full sm:w-auto justify-end pt-2 sm:pt-0">
                <!-- 主要アクション（スマホ上段 / PC左側） -->
                <div class="flex items-center gap-1.5 sm:gap-2 justify-between sm:justify-start">
                  <button type="button" onclick="toggleFavorite('${code}', event)" 
                          class="text-xs ${favBtnClass} transition px-2.5 py-1.5 rounded-lg flex items-center justify-center gap-1 active:scale-95 whitespace-nowrap flex-shrink-0" 
                          title="${isFav ? 'お気に入りから解除' : 'お気に入りに追加'}">
                    <i class="fa-${isFav ? 'solid' : 'regular'} fa-star text-sm ${isFav ? 'text-amber-500' : ''}"></i>
                    <span class="text-[11px] whitespace-nowrap">${isFav ? '登録中' : '保存'}</span>
                  </button>
                  <button type="button" onclick="toggleStoreVacancy('${code}', event)" id="vacancy-btn-${code}" 
                          class="text-[11px] bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold px-2.5 py-1.5 rounded-lg transition flex items-center justify-center gap-1 active:scale-95 shadow-2xs whitespace-nowrap flex-shrink-0" 
                          title="部屋・席のリアルタイム空き状況を確認">
                    <i class="fa-solid fa-door-open text-emerald-600"></i> <span class="whitespace-nowrap">空席状況</span>
                  </button>
                  <a href="https://www.kaikatsu.jp/shop/detail/${code}.html" target="_blank" rel="noopener noreferrer" 
                     class="sm:hidden text-center bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition shadow-sm whitespace-nowrap flex-shrink-0 flex items-center justify-center gap-1">
                    <span class="whitespace-nowrap">公式ページ</span>
                    <i class="fa-solid fa-angle-right text-[10px]"></i>
                  </a>
                </div>

                <!-- 補助アクション（スマホ下段 / PC右側） -->
                <div class="flex items-center gap-1 sm:gap-1.5 justify-end">
                  <a href="${mapUrl}" target="_blank" rel="noopener noreferrer"
                     class="sm:hidden px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-medium transition flex items-center justify-center gap-1 whitespace-nowrap flex-shrink-0"
                     title="Googleマップで開く">
                    <i class="fa-solid fa-location-dot text-orange-500 text-[11px]"></i> <span>地図</span>
                  </a>
                  ${tel ? `
                    <a href="tel:${tel.replace(/[^0-9]/g, '')}" 
                       class="sm:hidden px-2.5 py-1 bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-md text-xs font-medium transition flex items-center justify-center gap-1 whitespace-nowrap flex-shrink-0"
                       title="電話をかける">
                      <i class="fa-solid fa-phone text-orange-600 text-[11px]"></i> <span>電話</span>
                    </a>
                  ` : ''}
                  <button onclick="openStoreHistoryModal('${code}')" 
                          class="text-[11px] ${hasDiff ? 'text-orange-700 bg-orange-50 hover:bg-orange-100 border border-orange-200 font-semibold' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'} transition px-2 py-1 sm:py-1.5 rounded flex items-center gap-1 whitespace-nowrap flex-shrink-0"
                          title="料金改定履歴を見る">
                    <i class="fa-solid fa-clock-rotate-left ${hasDiff ? 'text-orange-600' : 'text-slate-400'}"></i> <span class="hidden sm:inline">履歴</span>
                  </button>
                  <button type="button" onclick="shareStoreOnX('${code}', event)" 
                          class="text-[11px] text-slate-500 hover:text-black hover:bg-slate-100 transition px-2 py-1 sm:py-1.5 rounded flex items-center gap-1 whitespace-nowrap flex-shrink-0"
                          title="この店舗の料金・設備をXでシェア">
                    <i class="fa-brands fa-x-twitter text-slate-800"></i> <span class="hidden sm:inline">シェア</span>
                  </button>
                  <button type="button" onclick="openReportForm('${code}', '${name}')" 
                          class="text-[11px] text-slate-400 hover:text-red-500 transition px-2 py-1 sm:py-1.5 rounded hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap flex-shrink-0"
                          title="料金・データの誤りをGoogleフォームで報告">
                    <i class="fa-regular fa-flag"></i> <span class="hidden sm:inline">報告</span>
                  </button>
                  <a href="https://www.kaikatsu.jp/shop/detail/${code}.html" target="_blank" rel="noopener noreferrer" 
                     class="hidden sm:inline-flex items-center text-center bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition shadow-sm whitespace-nowrap flex-shrink-0 gap-1">
                    <span class="whitespace-nowrap">公式ページ</span>
                    <i class="fa-solid fa-angle-right text-[10px]"></i>
                  </a>
                </div>
              </div>
            </div>

            <!-- 中段: 設備バッジ一覧 -->
            <div class="py-2 flex flex-wrap gap-1">
              ${badges.join('')}
            </div>

            ${diffBanner ? `<div class="mb-2.5">${diffBanner}</div>` : ''}

            <!-- リアルタイム空席情報エリア（動的展開） -->
            <div id="store-vacancy-${code}" class="hidden mb-2.5"></div>

            <!-- 📱 スマホ用: 主要パックのコンパクトグリッド (md:hidden) -->
            <div class="block md:hidden bg-slate-50 rounded-lg p-2.5 border border-slate-100 mb-2">
              <div class="grid grid-cols-4 gap-1.5 text-center">
                <div class="bg-white rounded p-1.5 shadow-xs border border-slate-100">
                  <div class="text-[9px] text-slate-400 font-semibold mb-0.5">基本30分</div>
                  <div class="text-xs font-bold text-slate-800">${formatFee(s['平日_基本30分'])}</div>
                  <div class="text-[9px] text-amber-700">${formatFee(s['週末_基本30分'])}</div>
                </div>
                <div class="bg-orange-50/60 rounded p-1.5 shadow-xs border border-orange-200/60">
                  <div class="text-[9px] text-orange-600 font-bold mb-0.5">3hパック</div>
                  <div class="text-xs font-bold text-slate-900">${formatFee(s['平日_3hパック'])}</div>
                  <div class="text-[9px] text-amber-800 font-medium">${formatFee(s['週末_3hパック'])}</div>
                </div>
                <div class="bg-orange-50/60 rounded p-1.5 shadow-xs border border-orange-200/60">
                  <div class="text-[9px] text-orange-600 font-bold mb-0.5">6hパック</div>
                  <div class="text-xs font-bold text-slate-900">${formatFee(s['平日_6hパック'])}</div>
                  <div class="text-[9px] text-amber-800 font-medium">${formatFee(s['週末_6hパック'])}</div>
                </div>
                <div class="bg-indigo-50/60 rounded p-1.5 shadow-xs border border-indigo-200/60">
                  <div class="text-[9px] text-indigo-700 font-bold mb-0.5">ナイト8h</div>
                  <div class="text-xs font-bold text-indigo-950">${formatFee(s['平日_ナイト8h'])}</div>
                  <div class="text-[9px] text-slate-400">${formatFee(s['週末_ナイト8h'])}</div>
                </div>
              </div>
              <div class="flex justify-between items-center text-[9px] text-slate-400 mt-1.5 px-0.5">
                <div>黒字: 平日 / <span class="text-amber-700">茶字: 週末</span></div>
                <button id="btn-details-${code}" onclick="toggleStoreDetails('${code}')" class="text-orange-600 font-bold flex items-center gap-1">
                  <span class="btn-text">全パック料金を見る</span>
                  <i id="arrow-details-${code}" class="fa-solid fa-chevron-down text-[8px] transition-transform"></i>
                </button>
              </div>
            </div>

            <!-- 💻 PC用 ＆ スマホ展開用: 全料金パック一覧テーブル (全11項目) -->
            <div id="details-${code}" class="hidden md:block overflow-x-auto rounded-lg border border-slate-200 bg-slate-50/50 shadow-inner mt-2 md:mt-0">
              <table class="w-full text-center text-xs price-table">
                <thead>
                  <tr class="bg-slate-100 text-slate-600 border-b border-slate-200 text-[10px] sm:text-[11px]">
                    <th class="py-2 px-2.5 sm:px-3 text-left font-bold sticky left-0 bg-slate-100 shadow-sm">区分</th>
                    <th class="py-2 px-2">基本30分</th>
                    <th class="py-2 px-2">延長10分</th>
                    <th class="py-2 px-2.5 font-bold text-orange-600 bg-orange-50/70 border-x border-orange-100">3h</th>
                    <th class="py-2 px-2.5 font-bold text-orange-600 bg-orange-50/70 border-r border-orange-100">6h</th>
                    <th class="py-2 px-2">9h</th>
                    <th class="py-2 px-2 font-bold">12h</th>
                    <th class="py-2 px-2">15h</th>
                    <th class="py-2 px-2">18h</th>
                    <th class="py-2 px-2">21h</th>
                    <th class="py-2 px-2 font-bold">24h</th>
                    <th class="py-2 px-2.5 bg-indigo-50/70 text-indigo-700 font-bold border-l border-indigo-100">ナイト8h</th>
                    <th class="py-2 px-2.5 bg-indigo-50/70 text-indigo-700 font-bold border-l border-indigo-100">ナイト12h</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 bg-white text-[10px] sm:text-[11px]">
                  <tr class="hover:bg-slate-50/80 transition">
                    <td class="py-2 px-2.5 sm:px-3 text-left font-bold text-slate-700 sticky left-0 bg-white">平日</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_基本30分')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_延長10分')}</td>
                    <td class="py-2 px-2.5 bg-orange-50/30 border-x border-orange-100 font-bold">${renderFeeCell('平日_3hパック', true)}</td>
                    <td class="py-2 px-2.5 bg-orange-50/30 border-r border-orange-100 font-bold">${renderFeeCell('平日_6hパック', true)}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_9hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_12hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_15hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_18hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_21hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('平日_24hパック')}</td>
                    <td class="py-2 px-2.5 bg-indigo-50/30 border-l border-indigo-100 font-medium">${renderFeeCell('平日_ナイト8h')}</td>
                    <td class="py-2 px-2.5 bg-indigo-50/30 border-l border-indigo-100 font-medium">${renderFeeCell('平日_ナイト12h')}</td>
                  </tr>
                  <tr class="hover:bg-amber-50/30 transition">
                    <td class="py-2 px-2.5 sm:px-3 text-left font-bold text-amber-800 sticky left-0 bg-white">週末</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_基本30分')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_延長10分')}</td>
                    <td class="py-2 px-2.5 bg-orange-50/30 border-x border-orange-100 font-bold">${renderFeeCell('週末_3hパック', true)}</td>
                    <td class="py-2 px-2.5 bg-orange-50/30 border-r border-orange-100 font-bold">${renderFeeCell('週末_6hパック', true)}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_9hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_12hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_15hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_18hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_21hパック')}</td>
                    <td class="py-2 px-2">${renderFeeCell('週末_24hパック')}</td>
                    <td class="py-2 px-2.5 bg-indigo-50/30 border-l border-indigo-100 font-medium">${renderFeeCell('週末_ナイト8h')}</td>
                    <td class="py-2 px-2.5 bg-indigo-50/30 border-l border-indigo-100 font-medium">${renderFeeCell('週末_ナイト12h')}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            ${weekendNote ? `<div class="mt-1.5 text-[9px] sm:text-[10px] text-slate-400 leading-tight">※ ${weekendNote}</div>` : ''}

          </div>
        `;
      }).join('');
    }

    // フィルター開閉トグル（スマホ向け）
    const toggleFilterBtn = document.getElementById('toggleFilterBtn');
    const amenityFiltersContainer = document.getElementById('amenityFiltersContainer');
    const filterArrow = document.getElementById('filterArrow');

    // スマホでは初期状態で開閉可能に
    toggleFilterBtn.addEventListener('click', () => {
      amenityFiltersContainer.classList.toggle('hidden');
      filterArrow.classList.toggle('rotate-180');
    });

    // イベントリスナー
    document.getElementById('searchInput').addEventListener('input', renderStores);
    document.getElementById('sortSelect').addEventListener('change', () => {
      const sortVal = document.getElementById('sortSelect').value;
      if (sortVal === 'distance_asc' && !userLocation) {
        requestNearMeSearch();
      } else {
        renderStores();
      }
    });
    document.querySelectorAll('.filter-cb').forEach(cb => cb.addEventListener('change', renderStores));

    document.getElementById('resetFiltersBtn').addEventListener('click', () => {
      document.getElementById('searchInput').value = '';
      selectedPrefs.clear();
      updatePrefTriggerButton();
      document.getElementById('sortSelect').value = userLocation ? 'distance_asc' : 'default';
      document.querySelectorAll('.filter-cb').forEach(cb => cb.checked = false);
      updateHeaderFavBadge();
      renderStores();
    });

    // 初期化
    loadData();
