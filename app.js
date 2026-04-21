/* Carpark Monitor – Dashboard App */
(function () {
  'use strict';

  /* ===== Configuration ===== */
  const SUPABASE_URL = 'https://mexlfgaxipmfvoavmxra.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1leGxmZ2F4aXBtZnZvYXZteHJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzA5MDAsImV4cCI6MjA5MTkwNjkwMH0.m8-RBCfkF-U-Rxc_b3WeqJkoDFeEFdgoZhYa3xAFkwg';
  const TD_BASIC_INFO_URL = 'https://resource.data.one.gov.hk/td/carpark/basic_info_all.json';
  const TD_VACANCY_URL = 'https://resource.data.one.gov.hk/td/carpark/vacancy_all.json';
  const EPD_EV_URL = 'https://ev-charger.epd.gov.hk/resource/ev_charger_avail/evca_ver_1_0.json';
  const TD_METERED_OCCUPANCY_URL = 'https://resource.data.one.gov.hk/td/psiparkingspaces/occupancystatus/occupancystatus.csv';
  const LOCAL_CARPARK_DETAILS_URL = './carpark-details.json?v=14';
  const LOCAL_METERED_SPACE_MAP_URL = './metered-space-map.json?v=14';
  const LOCAL_EV_LIVE_URL = './ev-live.json?v=14';

  /* ===== Supabase Client ===== */
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ===== State ===== */
  let allSections = [];
  let hasDataSet = new Set();
  let filteredSections = [];
  let selectedType = 'carpark';
  let selectedDistrict = '';
  let searchTerm = '';
  let selectedSectionId = null;
  const dataCache = new Map();
  const tdInfoMap = new Map();
  const sectionDetailsMap = new Map();
  const tdLiveVacancyMap = new Map();
  const evLookupMap = new Map();
  const evLiveSectionMap = new Map();
  const meteredLiveVacancyMap = new Map();
  let chart = null;
  let dayVisibility = { weekday: true, saturday: false, sunday: false };
  let searchTimer = null;
  let evLiveEntries = [];
  let meteredLivePromise = null;
  let tdBasicInfoPromise = null;
  let tdLiveVacancyPromise = null;
  let sectionDetailsPromise = null;
  let localCarparkDetailsPromise = null;
  let evLiveDataPromise = null;
  let totalSectionCount = 0;
  let loadedSectionCount = 0;
  let nextSectionOffset = 0;
  let hasMoreSections = false;
  let isLoadingSections = false;
  let listRequestToken = 0;
  const LIST_PAGE_SIZE = 20;
  const DISTRICT_OPTIONS = [
    ['Central and Western', '中西區'],
    ['Eastern', '東區'],
    ['Islands', '離島'],
    ['Kowloon City', '九龍城'],
    ['Kwai Tsing', '葵青'],
    ['Kwun Tong', '觀塘'],
    ['North', '北區'],
    ['Sai Kung', '西貢'],
    ['Sha Tin', '沙田'],
    ['Sham Shui Po', '深水埗'],
    ['Southern', '南區'],
    ['Tai Po', '大埔'],
    ['Tsuen Wan', '荃灣'],
    ['Tuen Mun', '屯門'],
    ['Wan Chai', '灣仔'],
    ['Wong Tai Sin', '黃大仙'],
    ['Yau Tsim Mong', '油尖旺'],
    ['Yuen Long', '元朗']
  ];

  /* ===== DOM References ===== */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const syncLabel = $('#sync-label');
  const sectionList = $('#section-list');
  const resultsCount = $('#results-count');
  const districtSelect = $('#district-select');
  const searchInput = $('#search-input');
  const detailPlaceholder = $('#detail-placeholder');
  const detailContent = $('#detail-content');
  const detailLoading = $('#detail-loading');
  const detailNodata = $('#detail-nodata');
  const detailNameTc = $('#detail-name-tc');
  const detailNameEn = $('#detail-name-en');
  const detailMeta = $('#detail-meta');
  const detailPanel = $('#detail-panel');
  const detailInfo = $('#detail-info');
  const detailInfoTitle = $('#detail-info-title');
  const detailPhoto = $('#detail-photo');
  const detailInfoGrid = $('#detail-info-grid');
  const detailNote = $('#detail-note');
  const chartWrap = detailContent.querySelector('.chart-wrap');
  const backBtn = $('#back-btn');
  const overlayBackdrop = $('#overlay-backdrop');
  const chartCanvas = $('#vacancy-chart');

  /* ===== Helpers ===== */
  function isMobile() { return window.innerWidth < 768; }

  function formatSyncTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function stripHtml(s) {
    if (!s) return '';
    return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  function formatSourceLabel(source) {
    if (!source) return '';
    if (source === 'datagovhk') return '運輸署出行易 Transport Department';
    if (source === 'emobility') return 'eMobility';
    if (source === 'metered') return '運輸署 Transport Department';
    if (source === 'epd') return '環保署 Environmental Protection Department';
    return source;
  }

  function formatLink(url) {
    if (!url) return '';
    try {
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
        escapeHtml(new URL(url).hostname) + '</a>';
    } catch (_err) {
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
        escapeHtml(url) + '</a>';
    }
  }

  function getSectionDetails(sectionId) {
    return sectionDetailsMap.get(sectionId) || sectionDetailsMap.get(getBaseSectionId(sectionId)) || null;
  }

  function getBaseSectionId(sectionId) {
    return sectionId && sectionId.startsWith('ev:') ? sectionId.slice(3) : sectionId;
  }

  function getCapacityLabel(section) {
    if (!section || !section.total_spaces) return '';
    return section.type === 'ev'
      ? section.total_spaces + ' chargers'
      : section.total_spaces + ' spaces';
  }

  function buildCoordinateMapsUrl(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    return 'https://maps.google.com/maps?q=' + encodeURIComponent(lat + ',' + lng);
  }

  function buildMapIconHtml(url, label) {
    if (!url) return '';
    return '<a class="map-icon-link" href="' + escapeHtml(url) +
      '" target="_blank" rel="noopener" aria-label="' + escapeHtml(label || 'Open in Google Maps') + '">🗺️</a>';
  }

  function formatMeterRateInfo(info) {
    if (!info || typeof info !== 'object') return '';
    const lines = [];
    Object.entries(info).forEach(([vehicleType, rate]) => {
      if (!rate || typeof rate !== 'object') return;
      const payment = rate.payment_unit ? '$' + rate.payment_unit : '';
      const time = rate.time_unit ? '/' + rate.time_unit + ' min' : '';
      const limited = Array.isArray(rate.lpp) && rate.lpp.length ? ' (max ' + rate.lpp.join(', ') + ' min)' : '';
      if (payment || time) {
        lines.push(escapeHtml(vehicleType + ': ' + payment + time + limited));
      }
    });
    return lines.join('<br>');
  }

  function formatEvBreakdown(info) {
    if (!info || typeof info !== 'object') return '';
    const labels = [
      ['standard', 'Standard'],
      ['medium', 'Medium'],
      ['fast', 'Fast'],
      ['superfast', 'Superfast'],
      ['other', 'Other']
    ];
    return labels
      .filter(([key]) => (info[key] || 0) > 0)
      .map(([key, label]) => escapeHtml(label + ': ' + info[key]))
      .join('<br>');
  }

  function normalizeKey(value) {
    return (value == null ? '' : String(value)).trim().toLowerCase();
  }

  function toNumberOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function registerEvLookup(key, sectionId) {
    const normalized = normalizeKey(key);
    if (normalized && sectionId) evLookupMap.set(normalized, sectionId);
  }

  function mergeSectionDetailsRows(rows) {
    (rows || []).forEach((row) => {
      if (!row || !row.section_id) return;
      const existing = sectionDetailsMap.get(row.section_id) || {};
      sectionDetailsMap.set(row.section_id, { ...row, ...existing });
      registerEvLookup(row.section_id, row.section_id);
      registerEvLookup(row.emobility_park_id, row.section_id);
      registerEvLookup(row.epd_charger_id, row.section_id);
    });
  }

  function resolveEvSectionId(value) {
    return evLookupMap.get(normalizeKey(value)) || null;
  }

  function buildEvMixFromLive(item) {
    const mix = { standard: 0, medium: 0, fast: 0, superfast: 0, other: 0 };
    const combos = Array.isArray(item && item.chargerTotalByCombinations) ? item.chargerTotalByCombinations : [];
    combos.forEach((combo) => {
      const count = Number(combo && combo.numOfCharger) || 0;
      if (count <= 0) return;
      const typeId = Number(combo && combo.chargerTypeID);
      const typeName = String((combo && combo.typeEName) || '').toLowerCase();
      if (typeId === 7 || typeName.includes('standard')) mix.standard += count;
      else if (typeId === 6 || typeName.includes('medium')) mix.medium += count;
      else if (typeId === 22 || typeName.includes('ultra') || typeName.includes('super')) mix.superfast += count;
      else if (typeId === 5 || typeName.includes('quick') || typeName.includes('fast')) mix.fast += count;
      else mix.other += count;
    });
    return mix;
  }

  function getEvLiveEntry(sectionId) {
    const baseId = getBaseSectionId(sectionId);
    return evLiveSectionMap.get(baseId) || evLiveSectionMap.get(sectionId) || null;
  }

  function mergeLiveEvSections(sections, dataSet) {
    const merged = sections.slice();
    const existingById = new Map(merged.map((section) => [section.id, section]));
    const existingEvByBaseId = new Map(
      merged
        .filter((section) => section.type === 'ev')
        .map((section) => [getBaseSectionId(section.id), section])
    );
    const carparkById = new Map(
      merged
        .filter((section) => section.type === 'carpark')
        .map((section) => [section.id, section])
    );

    evLiveEntries.forEach((entry) => {
      const matchedEv = existingEvByBaseId.get(entry.base_section_id || '');
      if (matchedEv) {
        dataSet.add(matchedEv.id);
        return;
      }

      const carpark = entry.base_section_id ? carparkById.get(entry.base_section_id) : null;
      const details = entry.base_section_id ? getSectionDetails(entry.base_section_id) : null;
      const syntheticId = 'ev:' + (entry.base_section_id || entry.raw_carpark_id || entry.raw_id);
      if (existingById.has(syntheticId)) {
        dataSet.add(syntheticId);
        return;
      }

      merged.push({
        id: syntheticId,
        type: 'ev',
        name_en: (details && details.name_en) || entry.name_en || (carpark && carpark.name_en) || entry.raw_carpark_id || 'EV Chargers',
        name_tc: (details && details.name_tc) || entry.name_tc || (carpark && carpark.name_tc) || entry.raw_carpark_id || 'EV Chargers',
        district_en: (carpark && carpark.district_en) || (details && details.district_en) || '',
        district_tc: (carpark && carpark.district_tc) || (details && details.district_tc) || '',
        latitude: entry.latitude != null ? entry.latitude : (carpark && carpark.latitude) || (details && details.latitude) || null,
        longitude: entry.longitude != null ? entry.longitude : (carpark && carpark.longitude) || (details && details.longitude) || null,
        total_spaces: entry.total || (carpark && carpark.ev_total) || 0,
        meter_rate_info: entry.mix
      });
      dataSet.add(syntheticId);
    });

    return merged;
  }

  function getListLiveHtml(section) {
    const baseId = getBaseSectionId(section.id);
    if (section.type === 'carpark') {
      const liveVacancy = tdLiveVacancyMap.get(baseId);
      const liveEv = getEvLiveEntry(section.id);
      if ((!liveVacancy || typeof liveVacancy.vacancy !== 'number' || liveVacancy.vacancy < 0) && !liveEv) return '';
      let html = '<div class="section-live">';
      if (liveVacancy && typeof liveVacancy.vacancy === 'number' && liveVacancy.vacancy >= 0) {
        html += '<div class="section-live-value">' + escapeHtml(String(liveVacancy.vacancy)) + '</div>' +
          '<div class="section-live-label">live</div>';
      }
      if (liveEv && typeof liveEv.available === 'number' && liveEv.available >= 0) {
        html += '<div class="section-live-secondary"><span class="section-live-secondary-value">' +
          escapeHtml(String(liveEv.available)) + '</span><span class="section-live-secondary-label">EV</span></div>';
      }
      html += '</div>';
      return html;
    }

    if (section.type === 'ev') {
      const liveEv = getEvLiveEntry(section.id);
      if (!liveEv || typeof liveEv.available !== 'number' || liveEv.available < 0) return '';
      let html = '<div class="section-live"><div class="section-live-value">' +
        escapeHtml(String(liveEv.available)) + '</div><div class="section-live-label">live</div>';
      if (typeof liveEv.total === 'number' && liveEv.total > 0) {
        html += '<div class="section-live-secondary"><span class="section-live-secondary-value">' +
          escapeHtml(String(liveEv.total)) + '</span><span class="section-live-secondary-label">total</span></div>';
      }
      html += '</div>';
      return html;
    }

    if (section.type === 'metered') {
      const live = meteredLiveVacancyMap.get(section.id);
      if (!live || typeof live.vacant !== 'number') return '';
      return '<div class="section-live"><div class="section-live-value">' +
        escapeHtml(String(live.vacant)) + '</div><div class="section-live-label">live</div></div>';
    }

    return '';
  }

  function setDetailNote(message) {
    detailNote.textContent = message || '';
    detailNote.hidden = !message;
  }

  function formatMeteredVehicleTypes(value) {
    const mapping = {
      A: '所有車輛 (私家車) All Vehicles (Private Cars)',
      C: '巴士 Coaches',
      G: '貨車 Goods Vehicles'
    };
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => mapping[item] || item)
      .join(' / ');
  }

  /* ===== TD Basic Info ===== */
  async function fetchTdBasicInfo() {
    try {
      const resp = await fetch(TD_BASIC_INFO_URL);
      const text = await resp.text();
      const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      const data = JSON.parse(clean);
      (data.car_park || []).forEach(cp => tdInfoMap.set(cp.park_id, cp));
    } catch (err) {
      console.warn('TD basic info fetch failed:', err);
    }
  }

  async function fetchSectionDetails() {
    let all = [];
    let from = 0;
    const page = 1000;
    try {
      for (;;) {
        const { data, error } = await sb.from('section_details').select('*')
          .range(from, from + page - 1).order('section_id');
        if (error) throw error;
        if (data) all = all.concat(data);
        if (!data || data.length < page) break;
        from += page;
      }
      mergeSectionDetailsRows(all);
    } catch (err) {
      console.warn('Supabase section_details fetch failed:', err);
    }
  }

  async function fetchLocalCarparkDetails() {
    try {
      const resp = await fetch(LOCAL_CARPARK_DETAILS_URL, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const rows = await resp.json();
      mergeSectionDetailsRows(rows);
    } catch (err) {
      console.warn('Local carpark details fetch failed:', err);
    }
  }

  async function fetchTdLiveVacancy() {
    if (tdLiveVacancyMap.size) return tdLiveVacancyMap;
    try {
      const resp = await fetch(TD_VACANCY_URL);
      const text = await resp.text();
      const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      const data = JSON.parse(clean);
      (data.car_park || []).forEach(cp => {
        let privateCarVacancy = null;
        let lastUpdate = '';
        (cp.vehicle_type || []).forEach(vt => {
          if (vt.type !== 'P') return;
          (vt.service_category || []).forEach(sc => {
            if (sc.category === 'HOURLY' && typeof sc.vacancy === 'number' && sc.vacancy >= 0 && privateCarVacancy === null) {
              privateCarVacancy = sc.vacancy;
              lastUpdate = sc.lastupdate || '';
            }
          });
        });
        tdLiveVacancyMap.set(cp.park_id, {
          vacancy: privateCarVacancy,
          last_update: lastUpdate
        });
      });
    } catch (err) {
      console.warn('TD vacancy fetch failed:', err);
    }
    return tdLiveVacancyMap;
  }

  async function fetchEvLiveData() {
    if (evLiveEntries.length) return evLiveEntries;

    function storeEntries(entries) {
      evLiveEntries = entries;
      evLiveEntries.forEach((entry) => {
        if (entry.base_section_id) evLiveSectionMap.set(entry.base_section_id, entry);
      });
      return evLiveEntries;
    }

    try {
      const resp = await fetch(LOCAL_EV_LIVE_URL, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const rows = await resp.json();
      return storeEntries((rows || []).map((entry) => {
        const availableCount = toNumberOrNull(entry.available);
        const totalCount = toNumberOrNull(entry.total);
        return {
          ...entry,
          available: availableCount == null ? 0 : availableCount,
          total: totalCount == null ? 0 : totalCount,
          latitude: toNumberOrNull(entry.latitude),
          longitude: toNumberOrNull(entry.longitude),
          mix: entry.mix || { standard: 0, medium: 0, fast: 0, superfast: 0, other: 0 }
        };
      }));
    } catch (err) {
      console.warn('Local EV live feed fetch failed:', err);
    }

    try {
      const resp = await fetch(EPD_EV_URL, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      const data = JSON.parse(clean);
      evLiveEntries = (data.data || [])
        .filter((item) => item && item.isEnable !== false)
        .map((item) => {
          const baseSectionId = resolveEvSectionId(item.carParkId) || resolveEvSectionId(item.id);
          const totalCount = toNumberOrNull(item.numOfCharger);
          const fallbackTotalCount = toNumberOrNull(item.sizeOfCharger);
          const total = totalCount == null ? (fallbackTotalCount == null ? 0 : fallbackTotalCount) : totalCount;
          const availableCount = toNumberOrNull(item.availableCharger);
          const available = availableCount == null ? 0 : availableCount;
          const entry = {
            raw_id: String(item.id || ''),
            raw_carpark_id: String(item.carParkId || item.id || ''),
            base_section_id: baseSectionId,
            name_en: item.carParkEName || '',
            name_tc: item.carParkCName || item.carParkScName || '',
            address_en: item.carParkEAddress || '',
            address_tc: item.carParkCAddress || item.carParkScAddress || '',
            latitude: item.location && item.location.lat != null ? Number(item.location.lat) : null,
            longitude: item.location && item.location.lng != null ? Number(item.location.lng) : null,
            available: available,
            total: total,
            last_update: item.lastUpdateDate || '',
            source: 'epd',
            mix: buildEvMixFromLive(item),
            opening_hours_en: item.openingHoursEn || '',
            opening_hours_tc: item.openingHoursCh || item.openingHoursSc || ''
          };
          return entry;
        });
      return storeEntries(evLiveEntries);
    } catch (err) {
      console.warn('EPD EV live fetch failed:', err);
    }
    return evLiveEntries;
  }

  async function ensureMeteredLiveVacancy() {
    if (meteredLiveVacancyMap.size) return meteredLiveVacancyMap;
    if (meteredLivePromise) return meteredLivePromise;

    meteredLivePromise = (async () => {
      try {
        const [mappingResp, occupancyResp] = await Promise.all([
          fetch(LOCAL_METERED_SPACE_MAP_URL, { cache: 'no-store' }),
          fetch(TD_METERED_OCCUPANCY_URL, { cache: 'no-store' })
        ]);
        if (!mappingResp.ok) throw new Error('metered map HTTP ' + mappingResp.status);
        if (!occupancyResp.ok) throw new Error('occupancy CSV HTTP ' + occupancyResp.status);

        const mapping = await mappingResp.json();
        const text = await occupancyResp.text();
        const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
        if (!lines.length) return meteredLiveVacancyMap;

        const header = lines[0].split(',').map((cell) => cell.trim());
        const spaceIndex = header.indexOf('ParkingSpaceId');
        const meterIndex = header.indexOf('MeterStatus');
        const occupancyIndex = header.indexOf('OccupancyStatus');
        if (spaceIndex === -1 || meterIndex === -1 || occupancyIndex === -1) {
          throw new Error('Unexpected occupancy CSV header');
        }

        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line) continue;
          const cols = line.split(',');
          const spaceId = (cols[spaceIndex] || '').trim();
          const sectionId = mapping[spaceId];
          if (!sectionId) continue;
          const meterStatus = (cols[meterIndex] || '').trim();
          const occupancyStatus = (cols[occupancyIndex] || '').trim();
          const entry = meteredLiveVacancyMap.get(sectionId) || { total: 0, vacant: 0, occupied: 0, not_in_use: 0 };
          entry.total += 1;
          if (meterStatus === 'NU') entry.not_in_use += 1;
          else if (meterStatus === 'N' && occupancyStatus === 'V') entry.vacant += 1;
          else if (meterStatus === 'N' && occupancyStatus === 'O') entry.occupied += 1;
          meteredLiveVacancyMap.set(sectionId, entry);
        }
      } catch (err) {
        console.warn('Metered live vacancy fetch failed:', err);
      }

      return meteredLiveVacancyMap;
    })();

    return meteredLivePromise;
  }

  async function renderSectionInfo(section) {
    await Promise.all([
      tdBasicInfoPromise,
      sectionDetailsPromise,
      localCarparkDetailsPromise,
      evLiveDataPromise,
      section.type === 'metered' ? ensureMeteredLiveVacancy() : Promise.resolve(),
      section.type === 'carpark' ? tdLiveVacancyPromise : Promise.resolve()
    ]);

    const details = getSectionDetails(section.id);
    const info = tdInfoMap.get(getBaseSectionId(section.id));
    const liveEv = getEvLiveEntry(section.id);
    const background = details && details.background_info && typeof details.background_info === 'object'
      ? details.background_info
      : {};
    let html = '';
    let hasInfo = false;
    detailInfoTitle.textContent = section.type === 'metered' ? '錶位資料 Information' : '基本資料 Basic Information';

    function row(label, value) {
      if (!value || (typeof value === 'string' && !value.trim())) return;
      hasInfo = true;
      html += '<span class="info-label">' + escapeHtml(label) + '</span>' +
              '<span class="info-value">' + value + '</span>';
    }

    const photoUrl = (details && details.photo_url) || (info && info.carpark_photo) || '';
    if (photoUrl) {
      detailPhoto.src = photoUrl.replace('http://', 'https://');
      detailPhoto.alt = ((info && info.name_en) || section.name_en || '') + ' photo';
      detailPhoto.hidden = false;
      detailPhoto.onerror = function () { this.hidden = true; };
    } else {
      detailPhoto.hidden = true;
    }

    if (section.type === 'metered') {
      const mapUrl = buildCoordinateMapsUrl(section.latitude, section.longitude);
      const live = meteredLiveVacancyMap.get(section.id);
      const district = [section.district_tc, section.district_en].filter(Boolean).join(' / ');
      row('地區 District', escapeHtml(district));
      const streetTc = stripHtml(background.section_of_street_tc || (details && details.address_tc) || '');
      const streetEn = stripHtml(background.section_of_street_en || (details && details.address_en) || '');
      if (streetTc || streetEn) {
        let streetHtml = '';
        if (streetTc) streetHtml += escapeHtml(streetTc);
        if (streetTc && streetEn) streetHtml += '<br>';
        if (streetEn) streetHtml += '<span style="opacity:0.7;font-size:0.9em">' + escapeHtml(streetEn) + '</span>';
        row('路段 Section', streetHtml);
      }
      if (section.total_spaces || background.total_spaces) row('停車位數量 Parking Spaces', escapeHtml(String(section.total_spaces || background.total_spaces)));
      if (background.vehicle_types || section.vehicle_types) row('車輛種類 Vehicle Type', escapeHtml(formatMeteredVehicleTypes(background.vehicle_types || section.vehicle_types)));
      if (background.operating_period) row('開放時間 Hours', escapeHtml(background.operating_period));
      if (background.meter_rate_info || section.meter_rate_info) row('咪錶收費 Meter Rates', formatMeterRateInfo(background.meter_rate_info || section.meter_rate_info));
      if (live && typeof live.vacant === 'number') row('實時空位 Live Vacancy', escapeHtml(String(live.vacant) + ' spaces'));
      if (mapUrl) row('地圖 Map', buildMapIconHtml(mapUrl, 'Open street parking location in Google Maps'));
    } else {
      const coordinateMapUrl = buildCoordinateMapsUrl(section.latitude, section.longitude);
      const addressTc = stripHtml((details && details.address_tc) || (info && info.displayAddress_tc) || (liveEv && liveEv.address_tc) || '');
      const addressEn = stripHtml((details && details.address_en) || (info && info.displayAddress_en) || (liveEv && liveEv.address_en) || '');
      const addressMapUrl = addressTc
        ? 'https://maps.google.com/maps?q=' + encodeURIComponent(addressTc)
        : coordinateMapUrl;
      let addressTcHtml = addressTc ? escapeHtml(addressTc) : '';
      if (addressTcHtml && addressMapUrl) {
        addressTcHtml += buildMapIconHtml(addressMapUrl, 'Open in Google Maps');
      }
      row('地址 Address', addressTcHtml);
      row('Address', escapeHtml(addressEn));
      if (!addressTc && coordinateMapUrl) {
        row('地圖 Map', buildMapIconHtml(coordinateMapUrl, 'Open in Google Maps'));
      }
      const sourceLabel = formatSourceLabel((details && details.source) || (section.source) || (info ? 'datagovhk' : (liveEv ? 'epd' : '')));
      if (sourceLabel) row('資料來源 Source', escapeHtml(sourceLabel));
      if (details && details.contact_no) row('聯絡電話 Contact', escapeHtml(details.contact_no));
      else if (info && info.contactNo) row('聯絡電話 Contact', escapeHtml(info.contactNo));
      if (details && details.height_limit_m) row('高度限制 Height', escapeHtml(String(details.height_limit_m)));
      else if (info && info.height && info.height > 0) row('高度限制 Height', info.height + 'm');
      if (details && details.opening_status) row('狀態 Status', escapeHtml(details.opening_status));
      else if (info && info.opening_status) row('狀態 Status', escapeHtml(info.opening_status));
      if (section.total_spaces) row(section.type === 'ev' ? '充電器數量 Chargers' : '車位數量 Capacity', escapeHtml(getCapacityLabel(section)));
      if (section.type === 'ev' && liveEv && typeof liveEv.available === 'number') {
        const suffix = liveEv.last_update ? ' (update: ' + escapeHtml(liveEv.last_update) + ')' : '';
        row('實時充電位 Live Availability', escapeHtml(String(liveEv.available) + ' chargers') + suffix);
      }
      if (details && details.website_url) {
        row('網站 Website', formatLink(details.website_url));
      } else if (info && info.website_en) {
        row('網站 Website', formatLink(info.website_en));
      }
      const remarkTc = stripHtml((((details && details.remark_tc) || (info && info.remark_tc) || '').replace(/^高度限制[:：]\s*/i, '').trim()));
      const remarkEn = stripHtml((((details && details.remark_en) || (info && info.remark_en) || '').replace(/^Height Limit:\s*/i, '').trim()));
      if (remarkTc || remarkEn) {
        let remarkHtml = '';
        if (remarkTc) remarkHtml += escapeHtml(remarkTc);
        if (remarkTc && remarkEn) remarkHtml += '<br>';
        if (remarkEn) remarkHtml += '<span style="opacity:0.7;font-size:0.9em">' + escapeHtml(remarkEn) + '</span>';
        row('備註 Remark', remarkHtml);
      }
      if (section.type === 'ev' && (section.meter_rate_info || (liveEv && liveEv.mix))) {
        row('充電器種類 EV Mix', formatEvBreakdown(section.meter_rate_info || liveEv.mix));
      }
      if (section.type === 'ev' && liveEv) {
        if (liveEv.opening_hours_tc) row('開放時間 Hours', escapeHtml(liveEv.opening_hours_tc));
        else if (liveEv.opening_hours_en) row('開放時間 Hours', escapeHtml(liveEv.opening_hours_en));
      }
      if (section.type === 'carpark' && (((details && details.source) === 'datagovhk') || info)) {
        const liveVacancies = await fetchTdLiveVacancy();
        const live = liveVacancies.get(getBaseSectionId(section.id));
        if (live && typeof live.vacancy === 'number' && live.vacancy >= 0) {
          const suffix = live.last_update ? ' (update: ' + formatSyncTime(live.last_update) + ')' : '';
          row('實時車位 Live Vacancy', escapeHtml(String(live.vacancy) + ' spaces' + suffix));
        }
      }
      if (section.type === 'carpark' && liveEv && typeof liveEv.available === 'number') {
        row('實時充電位 Live EV Available', escapeHtml(String(liveEv.available) + ' chargers'));
      }
    }

    detailInfoGrid.innerHTML = html;
    detailInfo.hidden = !hasInfo;
  }

  /* ===== Data Fetching ===== */
  async function fetchSyncTime() {
    const { data, error } = await sb.from('sync_log').select('completed_at')
      .order('completed_at', { ascending: false }).limit(1);
    if (error) return null;
    return data && data.length ? data[0].completed_at : null;
  }

  async function fetchTypicalWeek(sectionId) {
    if (dataCache.has(sectionId)) return dataCache.get(sectionId);
    const resp = await sb.from('typical_week').select('*')
      .eq('section_id', sectionId);
    if (resp.error) throw resp.error;
    const data = resp.data || [];
    dataCache.set(sectionId, data || []);
    return data || [];
  }

  function buildSectionsQuery(includeCount) {
    let query = includeCount
      ? sb.from('sections').select('*', { count: 'exact' })
      : sb.from('sections').select('*');
    query = query.eq('type', selectedType).order('name_en');
    if (selectedDistrict) query = query.eq('district_en', selectedDistrict);
    if (searchTerm) {
      const term = searchTerm.replace(/,/g, '\\,');
      query = query.or('name_en.ilike.%' + term + '%,name_tc.ilike.%' + term + '%');
    }
    return query;
  }

  async function fetchHasDataForIds(sectionIds) {
    if (!sectionIds.length) return new Set();
    const ids = new Set();
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb.from('typical_week').select('section_id')
        .in('section_id', sectionIds)
        .range(from, from + page - 1);
      if (error) throw error;
      (data || []).forEach((row) => {
        if (row && row.section_id) ids.add(row.section_id);
      });
      if (!data || data.length < page) break;
      from += page;
    }
    return ids;
  }

  /* ===== Weekday Aggregation ===== */
  function aggWeekday(rows) {
    const map = new Map();
    rows.forEach(r => {
      if (r.day_of_week > 4) return;
      let h = map.get(r.hour);
      if (!h) { h = { sv: 0, st: 0, so: 0, n: 0 }; map.set(r.hour, h); }
      h.sv += r.avg_vacancy || 0;
      h.st += r.avg_total || 0;
      h.so += r.avg_occupancy_rate || 0;
      h.n += 1;
    });
    return Array.from({ length: 24 }, (_, hr) => {
      const h = map.get(hr);
      if (!h || !h.n) return { avg_vacancy: 0, avg_total: 0, avg_occupancy_rate: 0 };
      return { avg_vacancy: h.sv / h.n, avg_total: h.st / h.n, avg_occupancy_rate: h.so / h.n };
    });
  }

  function getDayData(rows, dow) {
    const map = new Map();
    rows.filter(r => r.day_of_week === dow).forEach(r => map.set(r.hour, r));
    return Array.from({ length: 24 }, (_, hr) => {
      const r = map.get(hr);
      return r || { avg_vacancy: 0, avg_total: 0, avg_occupancy_rate: 0 };
    });
  }

  /* ===== Filtering & Sorting ===== */
  function updateResultsCount() {
    if (!totalSectionCount && !loadedSectionCount) {
      resultsCount.textContent = '0 sections';
      return;
    }
    if (loadedSectionCount < totalSectionCount) {
      resultsCount.textContent = 'Showing ' + loadedSectionCount + ' of ' + totalSectionCount + ' sections';
      return;
    }
    resultsCount.textContent = totalSectionCount + ' section' + (totalSectionCount !== 1 ? 's' : '');
  }

  /* ===== District Dropdown ===== */
  function populateDistricts() {
    districtSelect.innerHTML = '<option value=\"\">All Districts 全部地區</option>';
    DISTRICT_OPTIONS.forEach(([districtEn, districtTc]) => {
      const opt = document.createElement('option');
      opt.value = districtEn;
      opt.textContent = districtEn + ' ' + districtTc;
      districtSelect.appendChild(opt);
    });
    districtSelect.value = selectedDistrict;
  }

  async function loadSectionPage(offset, includeCount) {
    if (isLoadingSections) return;
    isLoadingSections = true;
    const token = listRequestToken;
    try {
      const query = buildSectionsQuery(includeCount).range(offset, offset + LIST_PAGE_SIZE - 1);
      const resp = await query;
      if (token !== listRequestToken) return;
      if (resp.error) throw resp.error;

      const rows = resp.data || [];
      const pageHasData = await fetchHasDataForIds(rows.map((row) => row.id));
      if (token !== listRequestToken) return;

      if (includeCount) totalSectionCount = resp.count || 0;
      rows.forEach((row) => {
        if (!allSections.some((section) => section.id === row.id)) allSections.push(row);
      });
      filteredSections = allSections.slice();
      pageHasData.forEach((id) => hasDataSet.add(id));
      loadedSectionCount = filteredSections.length;
      nextSectionOffset = loadedSectionCount;
      hasMoreSections = loadedSectionCount < totalSectionCount;
      renderList();
      updateResultsCount();
    } catch (err) {
      if (token !== listRequestToken) return;
      console.error('Failed to load section list:', err);
      sectionList.innerHTML = '';
      filteredSections = [];
      allSections = [];
      totalSectionCount = 0;
      loadedSectionCount = 0;
      hasMoreSections = false;
      resultsCount.textContent = 'Failed to load sections';
    } finally {
      if (token === listRequestToken) {
        isLoadingSections = false;
        if (hasMoreSections && sectionList.scrollHeight <= sectionList.clientHeight + 24) {
          setTimeout(() => { loadMoreSections(); }, 0);
        }
      }
    }
  }

  async function refreshSectionList() {
    listRequestToken += 1;
    allSections = [];
    filteredSections = [];
    hasDataSet = new Set();
    totalSectionCount = 0;
    loadedSectionCount = 0;
    nextSectionOffset = 0;
    hasMoreSections = false;
    selectedSectionId = null;
    renderList();
    resultsCount.textContent = 'Loading...';
    showDetailView('placeholder');
    await loadSectionPage(0, true);
  }

  async function loadMoreSections() {
    if (!hasMoreSections || isLoadingSections) return;
    await loadSectionPage(nextSectionOffset, false);
  }

  /* ===== List Rendering ===== */
  function renderList() {
    sectionList.innerHTML = '';
    const frag = document.createDocumentFragment();

    filteredSections.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = 'section-item' + (hasDataSet.has(s.id) ? '' : ' no-data') +
        (s.id === selectedSectionId ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', s.id === selectedSectionId ? 'true' : 'false');
      li.style.animationDelay = Math.min(idx * 20, 400) + 'ms';
      li.dataset.id = s.id;

      const distBadge = s.district_en
        ? '<span class="badge badge-district">' + escapeHtml(s.district_en) + '</span>' : '';
      const spacesBadge = s.total_spaces
        ? '<span class="badge badge-spaces">' + escapeHtml(getCapacityLabel(s)) + '</span>' : '';
      const noDataBadge = !hasDataSet.has(s.id)
        ? '<span class="badge badge-nodata">No data</span>' : '';
      const liveVacancyHtml = getListLiveHtml(s);

      li.innerHTML =
        '<div class="section-item-body">' +
          '<div class="section-name-tc">' + escapeHtml(s.name_tc) + '</div>' +
          '<div class="section-name-en">' + escapeHtml(s.name_en) + '</div>' +
          '<div class="section-badges">' + distBadge + spacesBadge + noDataBadge + '</div>' +
        '</div>' +
        liveVacancyHtml;

      li.addEventListener('click', () => selectSection(s.id));
      frag.appendChild(li);
    });

    sectionList.appendChild(frag);
  }

  /* ===== Section Selection ===== */
  async function selectSection(sectionId) {
    if (selectedSectionId === sectionId) return;
    selectedSectionId = sectionId;

    /* Update list active state */
    sectionList.querySelectorAll('.section-item').forEach(el => {
      const isActive = el.dataset.id === sectionId;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    /* Show detail panel on mobile */
    if (isMobile()) {
      detailPanel.classList.add('mobile-open');
      overlayBackdrop.hidden = false;
      requestAnimationFrame(() => overlayBackdrop.classList.add('visible'));
    }

    const section = allSections.find(s => s.id === sectionId);
    if (!section) return;

    /* Set header info */
    detailNameTc.textContent = section.name_tc || '';
    detailNameEn.textContent = section.name_en || '';
    detailMeta.innerHTML = '';
    if (section.district_en) {
      detailMeta.innerHTML += '<span class="badge badge-district">' + escapeHtml(section.district_en) +
        (section.district_tc ? ' ' + escapeHtml(section.district_tc) : '') + '</span>';
    }
    if (section.total_spaces) {
      detailMeta.innerHTML += '<span class="badge badge-spaces">' + escapeHtml(getCapacityLabel(section)) + '</span>';
    }
    if (section.type === 'ev' && section.meter_rate_info) {
      const evInfo = section.meter_rate_info;
      [
        ['Standard', evInfo.standard],
        ['Medium', evInfo.medium],
        ['Fast', evInfo.fast],
        ['Superfast', evInfo.superfast],
        ['Other', evInfo.other]
      ].forEach(([label, count]) => {
        if (count > 0) {
          detailMeta.innerHTML += '<span class="badge badge-district">' +
            escapeHtml(label + ': ' + count) + '</span>';
        }
      });
    }
    const sectionMapUrl = buildCoordinateMapsUrl(section.latitude, section.longitude);
    if (sectionMapUrl) {
      detailMeta.innerHTML += buildMapIconHtml(sectionMapUrl, 'Open in Google Maps');
    }

    /* Show loading */
    showDetailView('loading');

    try {
      const rows = await fetchTypicalWeek(sectionId);
      if (selectedSectionId !== sectionId) return;
      await renderSectionInfo(section);
      if (!rows || rows.length === 0) {
        if (chart) { chart.destroy(); chart = null; }
        chartWrap.hidden = true;
        const liveEv = getEvLiveEntry(section.id);
        if (section.type === 'metered') {
          setDetailNote('No vacancy history is available yet. Background information is shown below.');
        } else if (section.type === 'ev' && liveEv) {
          setDetailNote('Live EV availability is shown below. Historical averages will appear after EV sync is enabled.');
        } else {
          setDetailNote('No vacancy history is available yet. Basic information is shown below.');
        }
        showDetailView('content');
        return;
      }
      chartWrap.hidden = false;
      setDetailNote('');
      renderChart(rows, section);
      showDetailView('content');
    } catch (err) {
      console.error('Failed to load data:', err);
      await renderSectionInfo(section);
      if (chart) { chart.destroy(); chart = null; }
      chartWrap.hidden = true;
      setDetailNote('Data is temporarily unavailable. Available background information is shown below.');
      showDetailView('content');
    }
  }

  function showDetailView(which) {
    detailPlaceholder.hidden = which !== 'placeholder';
    detailContent.hidden = which !== 'content';
    detailLoading.hidden = which !== 'loading';
    detailNodata.hidden = which !== 'nodata';
  }

  /* ===== Chart ===== */
  function renderChart(rows, section) {
    const weekday = aggWeekday(rows);
    const saturday = getDayData(rows, 5);
    const sunday = getDayData(rows, 6);

    const labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');

    const metricLabel = section && section.type === 'ev' ? 'available' : 'vacant';
    const totalLabel = section && section.type === 'ev' ? 'chargers' : 'total';

    const datasets = [
      {
        label: 'Mon–Fri Avg',
        data: weekday.map(d => d.avg_vacancy),
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-weekday').trim(),
        borderRadius: 3,
        hidden: !dayVisibility.weekday,
        _meta_totals: weekday,
      },
      {
        label: 'Saturday',
        data: saturday.map(d => d.avg_vacancy),
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-saturday').trim(),
        borderRadius: 3,
        hidden: !dayVisibility.saturday,
        _meta_totals: saturday,
      },
      {
        label: 'Sunday & PH',
        data: sunday.map(d => d.avg_vacancy),
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-sunday').trim(),
        borderRadius: 3,
        hidden: !dayVisibility.sunday,
        _meta_totals: sunday,
      }
    ];

    if (chart) { chart.destroy(); chart = null; }

    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();

    chart = new Chart(chartCanvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleFont: { family: "'Urbanist', sans-serif", size: 13 },
            bodyFont: { family: "'Urbanist', sans-serif", size: 12 },
            padding: 10,
            cornerRadius: 6,
            callbacks: {
              label: function (ctx) {
                const ds = ctx.dataset;
                const meta = ds._meta_totals ? ds._meta_totals[ctx.dataIndex] : null;
                const vacancy = ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) : '—';
                const total = meta ? meta.avg_total.toFixed(1) : '—';
                const occ = meta ? (meta.avg_occupancy_rate * 100).toFixed(1) + '%' : '—';
                return ds.label + ': ' + vacancy + ' ' + metricLabel + ' / ' + total + ' ' + totalLabel + ' (' + occ + ' rate)';
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: textColor, font: { family: "'Urbanist', sans-serif", size: 11 }, maxRotation: 0 },
            grid: { display: false }
          },
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: section && section.type === 'ev' ? 'Avg Available Chargers' : 'Avg Vacancy',
              color: textColor,
              font: { family: "'Urbanist', sans-serif", size: 12, weight: '600' }
            },
            ticks: { color: textColor, font: { family: "'Urbanist', sans-serif", size: 11 } },
            grid: { color: gridColor }
          }
        }
      }
    });
  }

  /* ===== Day Toggle Handlers ===== */
  $$('.day-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.day;
      dayVisibility[day] = !dayVisibility[day];
      btn.classList.toggle('active', dayVisibility[day]);
      btn.setAttribute('aria-pressed', String(dayVisibility[day]));

      if (chart) {
        const idx = day === 'weekday' ? 0 : day === 'saturday' ? 1 : 2;
        chart.setDatasetVisibility(idx, dayVisibility[day]);
        chart.update('none');
      }
    });
  });

  /* ===== Type Tabs ===== */
  $$('.type-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.dataset.type === selectedType) return;
      $$('.type-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      selectedType = tab.dataset.type;
      selectedDistrict = '';
      districtSelect.value = '';
      if (selectedType === 'metered') {
        ensureMeteredLiveVacancy().then(() => {
          if (selectedType === 'metered') renderList();
        });
      }
      populateDistricts();
      await refreshSectionList();
    });
  });

  /* ===== District Select ===== */
  districtSelect.addEventListener('change', async () => {
    selectedDistrict = districtSelect.value;
    await refreshSectionList();
  });

  /* ===== Search ===== */
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = searchInput.value.trim();
      refreshSectionList();
    }, 300);
  });

  sectionList.addEventListener('scroll', () => {
    if (sectionList.scrollTop + sectionList.clientHeight >= sectionList.scrollHeight - 120) {
      loadMoreSections();
    }
  });

  /* ===== Mobile Back ===== */
  function closeMobileDetail() {
    detailPanel.classList.remove('mobile-open');
    overlayBackdrop.classList.remove('visible');
    setTimeout(() => { overlayBackdrop.hidden = true; }, 300);
  }

  backBtn.addEventListener('click', closeMobileDetail);
  overlayBackdrop.addEventListener('click', closeMobileDetail);

  function kickOffBackgroundLoads() {
    if (!tdBasicInfoPromise) tdBasicInfoPromise = fetchTdBasicInfo();
    if (!sectionDetailsPromise) sectionDetailsPromise = fetchSectionDetails();
    if (!localCarparkDetailsPromise) localCarparkDetailsPromise = fetchLocalCarparkDetails();
    if (!tdLiveVacancyPromise) {
      tdLiveVacancyPromise = fetchTdLiveVacancy().then(() => {
        if (selectedType === 'carpark') renderList();
      });
    }
    if (!evLiveDataPromise) {
      evLiveDataPromise = fetchEvLiveData().then(() => {
        if (selectedType === 'carpark' || selectedType === 'ev') renderList();
      });
    }
  }

  /* ===== Initialization ===== */
  async function init() {
    try {
      populateDistricts();
      kickOffBackgroundLoads();
      fetchSyncTime()
        .then((syncTime) => {
          syncLabel.textContent = 'Synced: ' + formatSyncTime(syncTime);
        })
        .catch(() => {
          syncLabel.textContent = 'Sync: error';
        });
      await refreshSectionList();
      showDetailView('placeholder');
    } catch (err) {
      console.error('Initialization failed:', err);
      syncLabel.textContent = 'Sync: error';
    }
  }

  init();
})();
