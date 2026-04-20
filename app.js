/* Carpark Monitor – Dashboard App */
(function () {
  'use strict';

  /* ===== Configuration ===== */
  const SUPABASE_URL = 'https://mexlfgaxipmfvoavmxra.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1leGxmZ2F4aXBtZnZvYXZteHJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzA5MDAsImV4cCI6MjA5MTkwNjkwMH0.m8-RBCfkF-U-Rxc_b3WeqJkoDFeEFdgoZhYa3xAFkwg';
  const TD_BASIC_INFO_URL = 'https://resource.data.one.gov.hk/td/carpark/basic_info_all.json';
  const TD_VACANCY_URL = 'https://resource.data.one.gov.hk/td/carpark/vacancy_all.json';

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
  let chart = null;
  let dayVisibility = { weekday: true, saturday: false, sunday: false };
  let searchTimer = null;

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
    if (source === 'datagovhk') return 'DGH';
    if (source === 'emobility') return 'eMobility';
    if (source === 'metered') return 'Metered';
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

  function setDetailNote(message) {
    detailNote.textContent = message || '';
    detailNote.hidden = !message;
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
      all.forEach(row => {
        if (row && row.section_id) sectionDetailsMap.set(row.section_id, row);
      });
    } catch (err) {
      console.warn('Supabase section_details fetch failed:', err);
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

  async function renderSectionInfo(section) {
    const details = getSectionDetails(section.id);
    const info = tdInfoMap.get(getBaseSectionId(section.id));
    const background = details && details.background_info && typeof details.background_info === 'object'
      ? details.background_info
      : {};
    let html = '';
    let hasInfo = false;
    detailInfoTitle.textContent = section.type === 'metered' ? 'Background Information' : 'Basic Information';

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
      const district = [section.district_tc, section.district_en].filter(Boolean).join(' / ');
      row('District', escapeHtml(district));
      const streetTc = stripHtml(background.section_of_street_tc || (details && details.address_tc) || '');
      const streetEn = stripHtml(background.section_of_street_en || (details && details.address_en) || '');
      if (streetTc || streetEn) {
        let streetHtml = '';
        if (streetTc) streetHtml += escapeHtml(streetTc);
        if (streetTc && streetEn) streetHtml += '<br>';
        if (streetEn) streetHtml += '<span style="opacity:0.7;font-size:0.9em">' + escapeHtml(streetEn) + '</span>';
        row('Section', streetHtml);
      }
      if (section.total_spaces || background.total_spaces) row('Parking Spaces', escapeHtml(String(section.total_spaces || background.total_spaces)));
      if (background.vehicle_types || section.vehicle_types) row('Vehicle Types', escapeHtml(background.vehicle_types || section.vehicle_types));
      if (background.operating_period) row('Operating Hours', escapeHtml(background.operating_period));
      if (background.meter_rate_info || section.meter_rate_info) row('Meter Rates', formatMeterRateInfo(background.meter_rate_info || section.meter_rate_info));
      if (mapUrl) row('地圖 Map', buildMapIconHtml(mapUrl, 'Open street parking location in Google Maps'));
    } else {
      const coordinateMapUrl = buildCoordinateMapsUrl(section.latitude, section.longitude);
      const addressTc = stripHtml((details && details.address_tc) || (info && info.displayAddress_tc) || '');
      const addressEn = stripHtml((details && details.address_en) || (info && info.displayAddress_en) || '');
      const addressMapUrl = addressTc
        ? 'https://maps.google.com/maps?q=' + encodeURIComponent(addressTc)
        : coordinateMapUrl;
      let addressTcHtml = addressTc ? escapeHtml(addressTc) : '';
      if (addressTcHtml && addressMapUrl) {
        addressTcHtml += buildMapIconHtml(addressMapUrl, 'Open in Google Maps');
      }
      row('地址', addressTcHtml);
      row('Address', escapeHtml(addressEn));
      if (!addressTc && coordinateMapUrl) {
        row('地圖 Map', buildMapIconHtml(coordinateMapUrl, 'Open in Google Maps'));
      }
      const sourceLabel = formatSourceLabel((details && details.source) || (info ? 'datagovhk' : ''));
      if (sourceLabel) row('Source', escapeHtml(sourceLabel));
      if (details && details.contact_no) row('聯絡 Contact', escapeHtml(details.contact_no));
      else if (info && info.contactNo) row('聯絡 Contact', escapeHtml(info.contactNo));
      if (details && details.height_limit_m) row('高度限制 Height', escapeHtml(String(details.height_limit_m)));
      else if (info && info.height && info.height > 0) row('高度限制 Height', info.height + 'm');
      if (details && details.opening_status) row('狀態 Status', escapeHtml(details.opening_status));
      else if (info && info.opening_status) row('狀態 Status', escapeHtml(info.opening_status));
      if (section.total_spaces) row(section.type === 'ev' ? 'Chargers' : 'Capacity', escapeHtml(getCapacityLabel(section)));
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
      if (section.type === 'ev' && section.meter_rate_info) {
        row('EV Mix', formatEvBreakdown(section.meter_rate_info));
      }
      if (section.type === 'carpark' && (((details && details.source) === 'datagovhk') || info)) {
        const liveVacancies = await fetchTdLiveVacancy();
        const live = liveVacancies.get(getBaseSectionId(section.id));
        if (live && typeof live.vacancy === 'number' && live.vacancy >= 0) {
          const suffix = live.last_update ? ' (update: ' + formatSyncTime(live.last_update) + ')' : '';
          row('Live Vacancy', escapeHtml(String(live.vacancy) + ' spaces' + suffix));
        }
      }
    }

    detailInfoGrid.innerHTML = html;
    detailInfo.hidden = !hasInfo;
  }

  /* ===== Data Fetching ===== */
  async function fetchAllSections() {
    let all = [];
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb.from('sections').select('*')
        .range(from, from + page - 1).order('name_en');
      if (error) throw error;
      if (data) all = all.concat(data);
      if (!data || data.length < page) break;
      from += page;
    }
    return all;
  }

  async function fetchHasDataSet() {
    const ids = new Set();
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb.from('typical_week').select('section_id')
        .range(from, from + page - 1);
      if (error) throw error;
      (data || []).forEach(r => {
        if (r && r.section_id) ids.add(r.section_id);
      });
      if (!data || data.length < page) break;
      from += page;
    }
    return ids;
  }

  async function fetchSyncTime() {
    const { data, error } = await sb.from('sync_log').select('completed_at')
      .order('completed_at', { ascending: false }).limit(1);
    if (error) return null;
    return data && data.length ? data[0].completed_at : null;
  }

  async function fetchTypicalWeek(sectionId) {
    if (dataCache.has(sectionId)) return dataCache.get(sectionId);
    const { data, error } = await sb.from('typical_week').select('*')
      .eq('section_id', sectionId);
    if (error) throw error;
    if (data) dataCache.set(sectionId, data);
    return data || [];
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
  function applyFilters() {
    const term = searchTerm.toLowerCase();
    filteredSections = allSections.filter(s => {
      if (s.type !== selectedType) return false;
      if (selectedDistrict && s.district_en !== selectedDistrict) return false;
      if (term) {
        const haystack = ((s.name_en || '') + ' ' + (s.name_tc || '')).toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });

    filteredSections.sort((a, b) => {
      const aHas = hasDataSet.has(a.id) ? 0 : 1;
      const bHas = hasDataSet.has(b.id) ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return (a.name_en || '').localeCompare(b.name_en || '');
    });

    renderList();
    updateResultsCount();
  }

  function updateResultsCount() {
    resultsCount.textContent = filteredSections.length + ' section' + (filteredSections.length !== 1 ? 's' : '');
  }

  /* ===== District Dropdown ===== */
  function populateDistricts() {
    const districts = new Set();
    allSections.forEach(s => {
      if (s.type === selectedType && s.district_en) districts.add(s.district_en);
    });
    const sorted = Array.from(districts).sort();
    districtSelect.innerHTML = '<option value="">All Districts 全部地區</option>';
    sorted.forEach(d => {
      const sec = allSections.find(s => s.type === selectedType && s.district_en === d);
      const label = d + (sec && sec.district_tc ? ' ' + sec.district_tc : '');
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = label;
      districtSelect.appendChild(opt);
    });
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

      li.innerHTML =
        '<div class="section-item-body">' +
          '<div class="section-name-tc">' + escapeHtml(s.name_tc) + '</div>' +
          '<div class="section-name-en">' + escapeHtml(s.name_en) + '</div>' +
          '<div class="section-badges">' + distBadge + spacesBadge + noDataBadge + '</div>' +
        '</div>';

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
        setDetailNote(section.type === 'metered'
          ? 'No vacancy history is available yet. Background information is shown below.'
          : 'No vacancy history is available yet. Basic information is shown below.');
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
    tab.addEventListener('click', () => {
      if (tab.dataset.type === selectedType) return;
      $$('.type-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      selectedType = tab.dataset.type;
      selectedSectionId = null;
      selectedDistrict = '';
      districtSelect.value = '';
      populateDistricts();
      applyFilters();
      showDetailView('placeholder');
    });
  });

  /* ===== District Select ===== */
  districtSelect.addEventListener('change', () => {
    selectedDistrict = districtSelect.value;
    applyFilters();
  });

  /* ===== Search ===== */
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = searchInput.value.trim();
      applyFilters();
    }, 300);
  });

  /* ===== Mobile Back ===== */
  function closeMobileDetail() {
    detailPanel.classList.remove('mobile-open');
    overlayBackdrop.classList.remove('visible');
    setTimeout(() => { overlayBackdrop.hidden = true; }, 300);
  }

  backBtn.addEventListener('click', closeMobileDetail);
  overlayBackdrop.addEventListener('click', closeMobileDetail);

  /* ===== Initialization ===== */
  async function init() {
    try {
      const [sections, dataSet, syncTime] = await Promise.all([
        fetchAllSections(),
        fetchHasDataSet(),
        fetchSyncTime(),
        fetchTdBasicInfo(),
        fetchSectionDetails()
      ]);

      allSections = sections;
      hasDataSet = dataSet;

      syncLabel.textContent = 'Synced: ' + formatSyncTime(syncTime);

      populateDistricts();
      applyFilters();
      showDetailView('placeholder');
    } catch (err) {
      console.error('Initialization failed:', err);
      syncLabel.textContent = 'Sync: error';
    }
  }

  init();
})();
