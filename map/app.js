(function () {
  'use strict';

  const SUPABASE_URL = 'https://mexlfgaxipmfvoavmxra.supabase.co';
  const SNAPSHOT_BUCKET = 'public-snapshots';
  const DEFAULT_CONFIG = {
    manifestUrl: SUPABASE_URL + '/storage/v1/object/public/' + SNAPSHOT_BUCKET + '/manifest.json',
    carparkDetailsUrl: '../carpark-details.json?v=17',
    evLiveUrl: '../ev-live.json?v=17',
    meteredSpaceMapUrl: '../metered-space-map.json?v=17',
    tdVacancyUrl: 'https://resource.data.one.gov.hk/td/carpark/vacancy_all.json',
    tdMeteredOccupancyUrl: 'https://resource.data.one.gov.hk/td/psiparkingspaces/occupancystatus/occupancystatus.csv',
    fallbackTileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    fallbackAttribution: '&copy; OpenStreetMap contributors',
    pmtilesFlavor: 'light',
    pmtilesLang: 'en',
    center: [22.3193, 114.1694],
    zoom: 11,
    minZoom: 10,
    maxZoom: 19,
    visibleResultLimit: 60,
    cacheTtlMs: 5 * 60 * 1000
  };
  const DEFAULT_INITIAL_DISTRICT = 'Yau Tsim Mong';

  const state = {
    config: null,
    map: null,
    baseLayer: null,
    layerControl: null,
    layers: {
      carpark: null,
      metered: null,
      ev: null
    },
    panes: {},
    data: {
      carpark: [],
      metered: [],
      ev: []
    },
    live: {
      carpark: new Map(),
      metered: new Map(),
      ev: new Map()
    },
    markers: {
      carpark: new Map(),
      metered: new Map(),
      ev: new Map()
    },
    detailRows: new Map(),
    evIdLookup: new Map(),
    searchTerm: '',
    selectedDistrict: '',
    pendingSectionId: '',
    visibleRows: [],
    toggles: {
      carpark: true,
      metered: true,
      ev: true
    },
    manifest: null,
    hasAppliedInitialViewport: false,
    fallbackSearchInput: null,
    fallbackStatus: null,
    fallbackVisibleCount: null,
    hooks: {}
  };

  const TYPE_META = {
    carpark: {
      label: 'Carpark',
      labelBilingual: 'Carpark / Parking',
      color: '#0f766e',
      fillColor: '#0d9488',
      selectors: {
        toggle: ['#toggle-carpark', '#carpark-toggle', '[data-layer-toggle="carpark"]', '[data-hook="toggle-carpark"]'],
        status: ['#layer-status-carpark', '#carpark-layer-status', '[data-layer-status="carpark"]', '[data-hook="layer-status-carpark"]'],
        count: ['#summary-carpark-count', '#carpark-count', '[data-count="carpark"]', '[data-hook="count-carpark"]']
      }
    },
    metered: {
      label: 'Metered',
      labelBilingual: 'Metered / Street Parking',
      color: '#a44a3f',
      fillColor: '#e76f51',
      selectors: {
        toggle: ['#toggle-metered', '#metered-toggle', '[data-layer-toggle="metered"]', '[data-hook="toggle-metered"]'],
        status: ['#layer-status-metered', '#metered-layer-status', '[data-layer-status="metered"]', '[data-hook="layer-status-metered"]'],
        count: ['#summary-metered-count', '#metered-count', '[data-count="metered"]', '[data-hook="count-metered"]']
      }
    },
    ev: {
      label: 'EV',
      labelBilingual: 'EV / Chargers',
      color: '#1d4ed8',
      fillColor: '#2563eb',
      selectors: {
        toggle: ['#toggle-ev', '#ev-toggle', '[data-layer-toggle="ev"]', '[data-hook="toggle-ev"]'],
        status: ['#layer-status-ev', '#ev-layer-status', '[data-layer-status="ev"]', '[data-hook="layer-status-ev"]'],
        count: ['#summary-ev-count', '#ev-count', '[data-count="ev"]', '[data-hook="count-ev"]']
      }
    }
  };

  const MAP_SELECTORS = {
    root: ['#map-canvas', '#map', '#leaflet-map', '[data-map-root]', '[data-hook="map-root"]'],
    searchInput: ['#map-search', '#search-input', '[data-map-search]', '[data-hook="map-search"]'],
    districtSelect: ['#map-district', '#district-select', '[data-map-district]', '[data-hook="map-district"]'],
    listViewLink: ['#list-view-link', '[data-list-view-link]', '[data-hook="list-view-link"]'],
    searchStatus: ['#search-status', '#map-search-status', '#results-copy', '[data-search-status]', '[data-hook="search-status"]'],
    results: ['#map-results', '#map-results-list', '[data-map-results]', '[data-hook="map-results"]'],
    status: ['#map-status', '#basemap-status', '[data-map-status]', '[data-hook="map-status"]'],
    visibleCount: ['#summary-visible-count', '#map-visible-count', '#visible-count', '#results-count', '[data-count="visible"]', '[data-hook="count-visible"]'],
    totalCount: ['#summary-total-count', '#map-total-count', '[data-count="total"]', '[data-hook="count-total"]'],
    fitButton: ['#fit-to-data', '#map-fit-button', '[data-map-fit]', '[data-hook="fit-map"]']
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    state.hooks.root = findFirst(MAP_SELECTORS.root);
    if (!state.hooks.root) return;

    injectFallbackStyles();
    state.config = readRuntimeConfig(state.hooks.root);
    cacheHooks();
    ensureFallbackShell();
    applyQueryState();
    syncListViewLink();
    bindUi();

    if (!window.L) {
      setStatus('Leaflet is not available on this page.', 'error');
      return;
    }

    try {
      setStatus('Loading public parking layers...', 'loading');
      await loadAllData();
      buildMap();
      buildMarkerIndex();
      render();
      setStatus('Map ready. Public snapshot + live overlays loaded.', 'ready');
    } catch (error) {
      console.error(error);
      setStatus('Failed to load map data. Please try again later.', 'error');
      renderErrorResults(error);
    }
  }

  function injectFallbackStyles() {
    if (document.getElementById('public-map-app-fallback-style')) return;
    const style = document.createElement('style');
    style.id = 'public-map-app-fallback-style';
    style.textContent = [
      '.public-map-panel{position:absolute;top:12px;left:12px;z-index:1000;background:rgba(255,255,255,0.96);backdrop-filter:blur(6px);padding:10px 12px;border-radius:12px;box-shadow:0 10px 24px rgba(0,0,0,0.12);display:grid;gap:8px;min-width:220px;max-width:280px;font:14px/1.35 "Segoe UI",sans-serif;}',
      '.public-map-panel input{width:100%;padding:8px 10px;border:1px solid #d0d7de;border-radius:8px;font:inherit;}',
      '.public-map-panel small{color:#57606a;}',
      '.public-map-layer-control{display:grid;gap:6px;font:13px/1.3 "Segoe UI",sans-serif;}',
      '.public-map-layer-row{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.94);padding:6px 8px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.12);}',
      '.public-map-layer-row input{margin:0;}',
      '.public-map-popup{min-width:220px;display:grid;gap:8px;}',
      '.public-map-popup h3{margin:0;font-size:15px;line-height:1.25;}',
      '.public-map-popup .en{font-size:12px;color:#57606a;}',
      '.public-map-popup dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 8px;margin:0;}',
      '.public-map-popup dt{font-weight:600;}',
      '.public-map-popup dd{margin:0;}',
      '.public-map-results{display:grid;gap:8px;max-height:360px;overflow:auto;}',
      '.public-map-result{border:1px solid #d8dee4;border-radius:10px;padding:10px 12px;background:#fff;cursor:pointer;text-align:left;font:13px/1.35 "Segoe UI",sans-serif;}',
      '.public-map-result:hover{border-color:#58a6ff;box-shadow:0 6px 18px rgba(33,38,45,0.08);}',
      '.public-map-result strong{display:block;font-size:14px;}',
      '.public-map-result .meta{color:#57606a;font-size:12px;margin-top:4px;}'
    ].join('');
    document.head.appendChild(style);
  }

  function readRuntimeConfig(root) {
    const globalConfig = Object.assign(
      {},
      window.HK_BASEMAP_CONFIG || {},
      window.PUBLIC_MAP_CONFIG || {},
      window.__PUBLIC_MAP_CONFIG__ || {}
    );
    const dataset = root.dataset || {};
    const config = Object.assign({}, DEFAULT_CONFIG, globalConfig);

    if (dataset.pmtilesUrl && !config.pmtilesUrl) config.pmtilesUrl = dataset.pmtilesUrl;
    if (dataset.tileUrl && !config.tileUrl) config.tileUrl = dataset.tileUrl;
    if (dataset.tileAttribution && !config.tileAttribution) config.tileAttribution = dataset.tileAttribution;
    if (dataset.manifestUrl) config.manifestUrl = dataset.manifestUrl;
    if (dataset.center) config.center = parseCenter(dataset.center) || config.center;
    if (dataset.zoom) config.zoom = Number(dataset.zoom) || config.zoom;
    if (dataset.visibleResultLimit) config.visibleResultLimit = Number(dataset.visibleResultLimit) || config.visibleResultLimit;
    if (config.pmtilesUrl) config.pmtilesUrl = buildVersionedAssetUrl(config.pmtilesUrl, config.pmtilesVersion || config.generatedAt);
    return config;
  }

  function buildVersionedAssetUrl(url, version) {
    const source = stringOrEmpty(url);
    if (!source) return '';

    try {
      const assetUrl = new URL(source, window.location.href);
      if (version && !assetUrl.searchParams.has('v')) {
        assetUrl.searchParams.set('v', sanitizeVersionToken(version));
      }
      return assetUrl.toString();
    } catch (_error) {
      return source;
    }
  }

  function sanitizeVersionToken(value) {
    const normalized = stringOrEmpty(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || 'current';
  }

  function cacheHooks() {
    state.hooks.searchInput = findFirst(MAP_SELECTORS.searchInput);
    state.hooks.districtSelect = findFirst(MAP_SELECTORS.districtSelect);
    state.hooks.listViewLink = findFirst(MAP_SELECTORS.listViewLink);
    state.hooks.searchStatus = findFirst(MAP_SELECTORS.searchStatus);
    state.hooks.results = findFirst(MAP_SELECTORS.results);
    state.hooks.status = findFirst(MAP_SELECTORS.status);
    state.hooks.visibleCount = findFirst(MAP_SELECTORS.visibleCount);
    state.hooks.totalCount = findFirst(MAP_SELECTORS.totalCount);
    state.hooks.fitButton = findFirst(MAP_SELECTORS.fitButton);
    state.hooks.toggles = {
      carpark: findFirst(TYPE_META.carpark.selectors.toggle),
      metered: findFirst(TYPE_META.metered.selectors.toggle),
      ev: findFirst(TYPE_META.ev.selectors.toggle)
    };
    state.hooks.layerStatus = {
      carpark: findFirst(TYPE_META.carpark.selectors.status),
      metered: findFirst(TYPE_META.metered.selectors.status),
      ev: findFirst(TYPE_META.ev.selectors.status)
    };
    state.hooks.layerCount = {
      carpark: findFirst(TYPE_META.carpark.selectors.count),
      metered: findFirst(TYPE_META.metered.selectors.count),
      ev: findFirst(TYPE_META.ev.selectors.count)
    };
  }

  function ensureFallbackShell() {
    if (!state.hooks.root || state.hooks.root.querySelector('.public-map-panel')) return;
    const needsFallbackPanel = !state.hooks.searchInput || !state.hooks.status || !state.hooks.visibleCount;
    if (!needsFallbackPanel) return;

    const panel = document.createElement('div');
    panel.className = 'public-map-panel';
    panel.innerHTML = [
      '<input type="search" placeholder="Search carpark, street, EV..." aria-label="Search parking layers">',
      '<small class="public-map-panel-count">Visible: -</small>',
      '<small class="public-map-panel-status">Preparing map...</small>'
    ].join('');
    state.hooks.root.appendChild(panel);

    if (!state.hooks.searchInput) {
      state.fallbackSearchInput = panel.querySelector('input');
      state.hooks.searchInput = state.fallbackSearchInput;
    }
    if (!state.hooks.visibleCount) {
      state.fallbackVisibleCount = panel.querySelector('.public-map-panel-count');
      state.hooks.visibleCount = state.fallbackVisibleCount;
    }
    if (!state.hooks.status) {
      state.fallbackStatus = panel.querySelector('.public-map-panel-status');
      state.hooks.status = state.fallbackStatus;
    }
  }

  function bindUi() {
    if (state.hooks.searchInput) {
      state.searchTerm = normalizeText(state.hooks.searchInput.value);
      state.hooks.searchInput.addEventListener('input', handleSearchInput);
      state.hooks.searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') focusFirstVisibleResult();
      });
    }

    if (state.hooks.districtSelect) {
      state.hooks.districtSelect.value = state.selectedDistrict;
      state.hooks.districtSelect.addEventListener('change', function (event) {
        state.selectedDistrict = stringOrEmpty(event.target.value);
        syncListViewLink();
        render();
      });
    }

    if (state.hooks.fitButton) {
      state.hooks.fitButton.addEventListener('click', function () {
        fitMapToVisibleData();
      });
    }

    ['carpark', 'metered', 'ev'].forEach(function (type) {
      const toggle = state.hooks.toggles[type];
      if (!toggle) return;
      if ('checked' in toggle) toggle.checked = state.toggles[type];
      toggle.addEventListener('change', function () {
        state.toggles[type] = !!toggle.checked;
        syncListViewLink();
        render();
      });
    });
  }

  function handleSearchInput(event) {
    state.searchTerm = normalizeText(event.target.value);
    syncListViewLink();
    render();
  }

  function applyQueryState() {
    const params = new URLSearchParams(window.location.search || '');
    const requestedType = stringOrEmpty(params.get('type'));
    const requestedDistrict = stringOrEmpty(params.get('district'));
    const requestedSearch = stringOrEmpty(params.get('q') || params.get('search'));
    const requestedSection = stringOrEmpty(params.get('section'));

    if (requestedType && Object.prototype.hasOwnProperty.call(state.toggles, requestedType)) {
      Object.keys(state.toggles).forEach(function (type) {
        state.toggles[type] = type === requestedType;
      });
    }

    state.selectedDistrict = requestedDistrict || DEFAULT_INITIAL_DISTRICT;
    state.searchTerm = normalizeText(requestedSearch);
    state.pendingSectionId = requestedSection;

    if (state.hooks.searchInput && requestedSearch) state.hooks.searchInput.value = requestedSearch;
    if (state.hooks.districtSelect) state.hooks.districtSelect.value = state.selectedDistrict;
  }

  function syncListViewLink() {
    if (!state.hooks.listViewLink) return;
    const params = new URLSearchParams();
    const enabledTypes = Object.keys(state.toggles).filter(function (type) {
      return state.toggles[type];
    });
    if (enabledTypes.length === 1) params.set('type', enabledTypes[0]);
    if (state.selectedDistrict) params.set('district', state.selectedDistrict);
    if (state.hooks.searchInput && state.hooks.searchInput.value.trim()) params.set('q', state.hooks.searchInput.value.trim());
    const query = params.toString();
    state.hooks.listViewLink.href = '../index.html' + (query ? ('?' + query) : '');
  }

  async function loadAllData() {
    const [detailRows, carparks, metered, carparkLive, meteredLive, evLiveRows] = await Promise.all([
      loadDetailRows(),
      loadSnapshotRows('carpark'),
      loadSnapshotRows('metered'),
      loadCarparkLiveVacancy(),
      loadMeteredLiveVacancy(),
      loadEvLiveRows()
    ]);

    indexDetailRows(detailRows);
    state.live.carpark = carparkLive;
    state.live.metered = meteredLive;
    state.live.ev = indexBy(evLiveRows, function (row) {
      return row.synthetic_id;
    });

    state.data.carpark = sanitizeSnapshotRows('carpark', carparks);
    state.data.metered = sanitizeSnapshotRows('metered', metered);
    state.data.ev = synthesizeEvRows(evLiveRows, state.data.carpark);
    populateDistrictOptions();
  }

  function populateDistrictOptions() {
    const select = state.hooks.districtSelect;
    if (!select) return;

    while (select.options.length > 1) {
      select.remove(1);
    }

    const districtMap = new Map();
    ['carpark', 'metered', 'ev'].forEach(function (type) {
      state.data[type].forEach(function (row) {
        const key = normalizeKey(row.district_en);
        if (!key || districtMap.has(key)) return;
        districtMap.set(key, {
          district_en: row.district_en,
          district_tc: row.district_tc
        });
      });
    });

    Array.from(districtMap.values())
      .sort(function (a, b) {
        return stringOrEmpty(a.district_en).localeCompare(stringOrEmpty(b.district_en));
      })
      .forEach(function (row) {
        const option = document.createElement('option');
        option.value = row.district_en;
        option.textContent = joinBilingual(row.district_tc, row.district_en) || row.district_en;
        select.appendChild(option);
      });

    if (state.selectedDistrict) select.value = state.selectedDistrict;
  }

  async function loadSnapshotRows(type) {
    const inlinePayload = readInlinePayload(type);
    if (inlinePayload) return inlinePayload;

    const manifest = await loadManifest();
    const snapshotInfo = manifest && manifest.snapshots ? manifest.snapshots[type] : null;
    if (!snapshotInfo) throw new Error('Missing snapshot manifest entry for ' + type);

    const cacheToken = encodeURIComponent(snapshotInfo.generated_at || manifest.generated_at || manifest.date || '');
    const snapshotUrl = (snapshotInfo.public_url || buildSnapshotPublicUrl(snapshotInfo.filename)) + (cacheToken ? '?v=' + cacheToken : '');
    const payload = await fetchJsonCached(snapshotUrl, { ttlMs: 30 * 60 * 1000, cacheKey: 'snapshot:' + type + ':' + snapshotInfo.filename });
    return Array.isArray(payload) ? payload : (Array.isArray(payload && payload.sections) ? payload.sections : []);
  }

  async function loadManifest() {
    if (state.manifest) return state.manifest;
    const inlineManifest = readInlinePayload('manifest');
    if (inlineManifest && inlineManifest.snapshots) {
      state.manifest = inlineManifest;
      return state.manifest;
    }
    state.manifest = await fetchJsonCached(state.config.manifestUrl, {
      ttlMs: 60 * 60 * 1000,
      cacheKey: 'snapshot:manifest'
    });
    return state.manifest;
  }

  async function loadDetailRows() {
    const rows = await fetchJsonCached(state.config.carparkDetailsUrl, {
      ttlMs: 60 * 60 * 1000,
      cacheKey: 'public:carpark-details'
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function loadEvLiveRows() {
    const localRows = await fetchJsonCached(state.config.evLiveUrl, {
      ttlMs: state.config.cacheTtlMs,
      cacheKey: 'public:ev-live'
    }).catch(function () {
      return [];
    });
    const rows = Array.isArray(localRows) ? localRows : [];
    return rows.map(function (row) {
      const baseSectionId = firstNonEmpty(row.base_section_id, row.raw_carpark_id, row.raw_id);
      return {
        raw_id: stringOrEmpty(row.raw_id),
        raw_carpark_id: stringOrEmpty(row.raw_carpark_id),
        base_section_id: stringOrEmpty(baseSectionId),
        synthetic_id: 'ev:' + stringOrEmpty(baseSectionId || row.raw_carpark_id || row.raw_id),
        name_en: stringOrEmpty(row.name_en),
        name_tc: stringOrEmpty(row.name_tc),
        address_en: stringOrEmpty(row.address_en),
        address_tc: stringOrEmpty(row.address_tc),
        latitude: numberOrNull(row.latitude),
        longitude: numberOrNull(row.longitude),
        available: numberOrZero(row.available),
        total: numberOrZero(row.total),
        last_update: stringOrEmpty(row.last_update),
        source: stringOrEmpty(row.source) || 'epd',
        mix: normalizeEvMix(row.mix),
        opening_hours_en: stringOrEmpty(row.opening_hours_en),
        opening_hours_tc: stringOrEmpty(row.opening_hours_tc)
      };
    }).filter(function (row) {
      return !!row.synthetic_id;
    });
  }

  async function loadCarparkLiveVacancy() {
    const payload = await fetchJsonCached(state.config.tdVacancyUrl, {
      ttlMs: 90 * 1000,
      cacheKey: 'live:carpark-vacancy'
    }).catch(function () {
      return {};
    });

    const liveMap = new Map();
    (payload.car_park || []).forEach(function (carpark) {
      let privateCarVacancy = null;
      let lastUpdate = '';
      (carpark.vehicle_type || []).forEach(function (vehicleType) {
        if (vehicleType.type !== 'P') return;
        (vehicleType.service_category || []).forEach(function (serviceCategory) {
          if (serviceCategory.category === 'HOURLY' && typeof serviceCategory.vacancy === 'number' && serviceCategory.vacancy >= 0 && privateCarVacancy === null) {
            privateCarVacancy = serviceCategory.vacancy;
            lastUpdate = serviceCategory.lastupdate || '';
          }
        });
      });
      liveMap.set(normalizeKey(carpark.park_id), {
        vacancy: privateCarVacancy,
        last_update: lastUpdate
      });
    });
    return liveMap;
  }

  async function loadMeteredLiveVacancy() {
    const [mapping, csvText] = await Promise.all([
      fetchJsonCached(state.config.meteredSpaceMapUrl, {
        ttlMs: 60 * 60 * 1000,
        cacheKey: 'public:metered-space-map'
      }).catch(function () {
        return {};
      }),
      fetchTextCached(state.config.tdMeteredOccupancyUrl, {
        ttlMs: 90 * 1000,
        cacheKey: 'live:metered-occupancy'
      }).catch(function () {
        return '';
      })
    ]);

    const liveMap = new Map();
    if (!csvText) return liveMap;

    const lines = csvText.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (!lines.length) return liveMap;

    const header = parseCsvLine(lines[0]);
    const spaceIndex = header.indexOf('ParkingSpaceId');
    const meterIndex = header.indexOf('ParkingMeterStatus');
    const occupancyIndex = header.indexOf('OccupancyStatus');
    if (spaceIndex === -1 || meterIndex === -1 || occupancyIndex === -1) return liveMap;

    for (let index = 1; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      const cols = parseCsvLine(lines[index]);
      const sectionId = mapping[stringOrEmpty(cols[spaceIndex]).trim()];
      if (!sectionId) continue;
      const meterStatus = stringOrEmpty(cols[meterIndex]).trim();
      const occupancyStatus = stringOrEmpty(cols[occupancyIndex]).trim();
      const key = normalizeKey(sectionId);
      const entry = liveMap.get(key) || { total: 0, vacant: 0, occupied: 0, not_in_use: 0 };
      entry.total += 1;
      if (meterStatus === 'NU') entry.not_in_use += 1;
      else if (meterStatus === 'N' && occupancyStatus === 'V') entry.vacant += 1;
      else if (meterStatus === 'N' && occupancyStatus === 'O') entry.occupied += 1;
      liveMap.set(key, entry);
    }
    return liveMap;
  }

  function indexDetailRows(rows) {
    rows.forEach(function (row) {
      if (!row || !row.section_id) return;
      state.detailRows.set(normalizeKey(row.section_id), row);
      registerEvLookup(row.section_id, row.section_id);
      registerEvLookup(row.emobility_park_id, row.section_id);
      registerEvLookup(row.epd_charger_id, row.section_id);
    });
  }

  function registerEvLookup(rawKey, sectionId) {
    const key = normalizeKey(rawKey);
    if (!key || !sectionId) return;
    state.evIdLookup.set(key, sectionId);
  }

  function sanitizeSnapshotRows(type, rows) {
    return (rows || []).map(function (row) {
      return Object.assign({}, row, {
        type: type,
        id: stringOrEmpty(row.id),
        name_en: stringOrEmpty(row.name_en),
        name_tc: stringOrEmpty(row.name_tc),
        district_en: stringOrEmpty(row.district_en),
        district_tc: stringOrEmpty(row.district_tc),
        latitude: numberOrNull(row.latitude),
        longitude: numberOrNull(row.longitude),
        total_spaces: numberOrZero(row.total_spaces),
        has_history: !!row.has_history
      });
    }).filter(function (row) {
      return row.id && Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
    });
  }

  function synthesizeEvRows(evLiveRows, carparkRows) {
    const carparkById = indexBy(carparkRows, function (row) {
      return row.id;
    });
    const evRows = [];
    const seen = new Set();

    evLiveRows.forEach(function (liveRow) {
      const baseSectionId = resolveEvBaseId(liveRow);
      const detail = getDetailRow(baseSectionId || liveRow.raw_carpark_id || liveRow.raw_id);
      const carpark = carparkById.get(normalizeKey(baseSectionId)) || carparkById.get(normalizeKey(detail && detail.section_id));
      const latitude = firstFinite(liveRow.latitude, detail && detail.latitude, carpark && carpark.latitude);
      const longitude = firstFinite(liveRow.longitude, detail && detail.longitude, carpark && carpark.longitude);
      const syntheticId = 'ev:' + stringOrEmpty(baseSectionId || detail && detail.section_id || liveRow.raw_carpark_id || liveRow.raw_id);
      if (!syntheticId || seen.has(syntheticId) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      seen.add(syntheticId);

      evRows.push({
        id: syntheticId,
        base_section_id: stringOrEmpty(baseSectionId || detail && detail.section_id),
        type: 'ev',
        name_en: firstNonEmpty(detail && detail.name_en, liveRow.name_en, carpark && carpark.name_en, liveRow.raw_carpark_id, 'EV Chargers'),
        name_tc: firstNonEmpty(detail && detail.name_tc, liveRow.name_tc, carpark && carpark.name_tc, liveRow.raw_carpark_id, 'EV Chargers'),
        district_en: firstNonEmpty(carpark && carpark.district_en, detail && detail.district_en),
        district_tc: firstNonEmpty(carpark && carpark.district_tc, detail && detail.district_tc),
        latitude: latitude,
        longitude: longitude,
        total_spaces: numberOrZero(liveRow.total),
        available: numberOrZero(liveRow.available),
        last_update: liveRow.last_update,
        has_history: false,
        source: liveRow.source || (detail && detail.source) || 'epd',
        address_en: firstNonEmpty(liveRow.address_en, detail && detail.address_en),
        address_tc: firstNonEmpty(liveRow.address_tc, detail && detail.address_tc),
        opening_hours_en: liveRow.opening_hours_en,
        opening_hours_tc: liveRow.opening_hours_tc,
        mix: normalizeEvMix(liveRow.mix),
        website_url: detail && detail.website_url ? detail.website_url : '',
        detail_row: detail || null,
        paired_carpark_id: carpark ? carpark.id : ''
      });
    });

    return evRows;
  }

  function resolveEvBaseId(liveRow) {
    const directId = firstNonEmpty(liveRow.base_section_id, liveRow.raw_carpark_id, liveRow.raw_id);
    const lookupId = state.evIdLookup.get(normalizeKey(directId));
    return firstNonEmpty(lookupId, directId);
  }

  function buildMap() {
    state.map = L.map(state.hooks.root, {
      center: state.config.center,
      zoom: state.config.zoom,
      minZoom: state.config.minZoom,
      maxZoom: state.config.maxZoom,
      zoomControl: true
    });

    createPanes();
    state.baseLayer = createBaseLayer();
    state.baseLayer.addTo(state.map);

    state.layers.carpark = L.layerGroup().addTo(state.map);
    state.layers.metered = L.layerGroup().addTo(state.map);
    state.layers.ev = L.layerGroup().addTo(state.map);

    if (!state.hooks.toggles.carpark || !state.hooks.toggles.metered || !state.hooks.toggles.ev) {
      state.layerControl = createFallbackLayerControl();
      state.layerControl.addTo(state.map);
    }

  }

  function createPanes() {
    state.panes.carpark = state.map.createPane('pane-carpark');
    state.panes.metered = state.map.createPane('pane-metered');
    state.panes.ev = state.map.createPane('pane-ev');
    state.panes.carpark.style.zIndex = '410';
    state.panes.metered.style.zIndex = '420';
    state.panes.ev.style.zIndex = '430';
  }

  function createBaseLayer() {
    const pmtilesUrl = state.config.pmtilesUrl;
    if (pmtilesUrl) {
      try {
        if (window.protomapsL && typeof window.protomapsL.leafletLayer === 'function') {
          setStatus('Using PMTiles basemap.', 'ready');
          return window.protomapsL.leafletLayer({
            url: pmtilesUrl,
            flavor: state.config.pmtilesFlavor || 'light',
            lang: state.config.pmtilesLang || 'en',
            attribution: state.config.pmtilesAttribution || state.config.fallbackAttribution
          });
        }
        if (window.pmtiles && typeof window.pmtiles.leafletRasterLayer === 'function') {
          setStatus('Using PMTiles basemap.', 'ready');
          return window.pmtiles.leafletRasterLayer(pmtilesUrl, {
            attribution: state.config.pmtilesAttribution || state.config.fallbackAttribution
          });
        }
        console.warn('PMTiles URL configured but no compatible runtime was found. Falling back to tile layer.');
      } catch (error) {
        console.warn('PMTiles setup failed. Falling back to tile layer.', error);
      }
    }

    return L.tileLayer(state.config.tileUrl || state.config.fallbackTileUrl, {
      attribution: state.config.tileAttribution || state.config.fallbackAttribution,
      maxZoom: state.config.maxZoom
    });
  }

  function createFallbackLayerControl() {
    const control = L.control({ position: 'topright' });
    control.onAdd = function () {
      const container = L.DomUtil.create('div', 'public-map-layer-control');
      L.DomEvent.disableClickPropagation(container);
      ['carpark', 'metered', 'ev'].forEach(function (type) {
        const row = document.createElement('label');
        row.className = 'public-map-layer-row';
        row.innerHTML = '<input type="checkbox" checked> <span>' + escapeHtml(TYPE_META[type].labelBilingual) + '</span>';
        const checkbox = row.querySelector('input');
        checkbox.checked = state.toggles[type];
        checkbox.addEventListener('change', function () {
          state.toggles[type] = !!checkbox.checked;
          render();
        });
        container.appendChild(row);
      });
      return container;
    };
    return control;
  }

  function buildMarkerIndex() {
    ['carpark', 'metered', 'ev'].forEach(function (type) {
      const markerMap = state.markers[type];
      markerMap.clear();
      state.data[type].forEach(function (row) {
        const marker = buildMarker(row);
        if (!marker) return;
        markerMap.set(normalizeKey(row.id), marker);
      });
    });
  }

  function buildMarker(row) {
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return null;

    const marker = L.marker([row.latitude, row.longitude], {
      pane: 'pane-' + row.type,
      icon: L.divIcon({
        className: 'public-map-badge-wrap',
        html: buildMarkerBadgeHtml(row),
        iconSize: null
      })
    });
    marker.bindPopup(buildPopupHtml(row), {
      maxWidth: 320,
      className: 'public-map-popup-wrapper'
    });
    marker.bindTooltip(buildTooltipText(row), {
      direction: 'top',
      offset: [0, -4],
      opacity: 0.9
    });
    marker.on('click', function () {
      focusResult(row.id);
    });
    return marker;
  }

  function buildMarkerBadgeHtml(row) {
    const value = getMarkerBadgeValue(row);
    const shortLabel = row.type === 'carpark' ? 'P' : (row.type === 'metered' ? 'S' : 'EV');
    return [
      '<div class="public-map-badge public-map-badge--', escapeHtml(row.type), '">',
      '<span class="public-map-badge__value">', escapeHtml(value), '</span>',
      '<span class="public-map-badge__label">', escapeHtml(shortLabel), '</span>',
      '</div>'
    ].join('');
  }

  function getMarkerBadgeValue(row) {
    if (row.type === 'carpark') {
      const live = state.live.carpark.get(normalizeKey(row.id));
      if (!live || typeof live.vacancy !== 'number' || live.vacancy < 0) return '—';
      return String(live.vacancy);
    }
    if (row.type === 'metered') {
      const live = state.live.metered.get(normalizeKey(row.id));
      if (!live || typeof live.vacant !== 'number' || live.vacant < 0) return '—';
      return String(live.vacant);
    }
    if (row.type === 'ev') {
      return String(typeof row.available === 'number' ? row.available : 0);
    }
    return '—';
  }

  function buildTooltipText(row) {
    const nameTc = row.name_tc || row.name_en || row.id;
    const liveSummary = getLiveSummary(row);
    return liveSummary ? nameTc + ' | ' + liveSummary : nameTc;
  }

  function buildPopupHtml(row) {
    const nameTc = escapeHtml(row.name_tc || row.name_en || row.id);
    const nameEn = row.name_en && row.name_en !== row.name_tc ? '<div class="en">' + escapeHtml(row.name_en) + '</div>' : '';
    const detail = row.detail_row || getDetailRow(row.base_section_id || row.id);
    const liveSummary = getLiveSummary(row);
    const district = joinBilingual(row.district_tc, row.district_en);
    const address = joinBilingual(detail && detail.address_tc || row.address_tc, detail && detail.address_en || row.address_en);
    const website = detail && detail.website_url ? '<a href="' + escapeHtml(detail.website_url) + '" target="_blank" rel="noopener">' + escapeHtml(detail.website_url) + '</a>' : '';
    const googleMaps = buildMapsUrl(row.latitude, row.longitude);
    const lines = [];

    lines.push('<div class="public-map-popup">');
    lines.push('<h3>' + nameTc + '</h3>');
    if (nameEn) lines.push(nameEn);
    lines.push('<dl>');
    lines.push('<dt>Type</dt><dd>' + escapeHtml(TYPE_META[row.type].labelBilingual) + '</dd>');
    if (district) lines.push('<dt>District</dt><dd>' + escapeHtml(district) + '</dd>');
    if (liveSummary) lines.push('<dt>Live</dt><dd>' + escapeHtml(liveSummary) + '</dd>');
    if (row.total_spaces) lines.push('<dt>Capacity</dt><dd>' + escapeHtml(formatCapacity(row)) + '</dd>');
    if (row.type === 'metered') {
      lines.push('<dt>Section</dt><dd>' + escapeHtml(row.name_tc || row.name_en || row.id) + '</dd>');
    }
    if (address) lines.push('<dt>Address</dt><dd>' + escapeHtml(address) + '</dd>');
    if (row.type === 'ev') {
      const mix = formatEvMix(row.mix);
      if (mix) lines.push('<dt>Mix</dt><dd>' + escapeHtml(mix) + '</dd>');
      const hours = joinBilingual(row.opening_hours_tc, row.opening_hours_en);
      if (hours) lines.push('<dt>Hours</dt><dd>' + escapeHtml(hours) + '</dd>');
    }
    if (website) lines.push('<dt>Website</dt><dd>' + website + '</dd>');
    if (googleMaps) {
      lines.push('<dt>Map</dt><dd><a href="' + escapeHtml(googleMaps) + '" target="_blank" rel="noopener">Open in Google Maps</a></dd>');
    }
    lines.push('</dl>');
    lines.push('</div>');
    return lines.join('');
  }

  function render() {
    if (!state.map) return;

    state.visibleRows = collectVisibleRows();
    ['carpark', 'metered', 'ev'].forEach(function (type) {
      renderLayer(type);
      syncToggle(type);
      syncLayerStatus(type);
      syncLayerCount(type);
    });

    updateSummaryHooks();
    renderResults();
    if (!state.hasAppliedInitialViewport) {
      fitMapToVisibleData();
      state.hasAppliedInitialViewport = true;
    }
    maybeOpenRequestedSection();
  }

  function renderLayer(type) {
    const layer = state.layers[type];
    if (!layer) return;
    layer.clearLayers();
    if (!state.toggles[type]) return;

    const visibleIds = new Set(state.visibleRows.filter(function (row) {
      return row.type === type;
    }).map(function (row) {
      return normalizeKey(row.id);
    }));

    state.markers[type].forEach(function (marker, key) {
      if (visibleIds.has(key)) layer.addLayer(marker);
    });
  }

  function collectVisibleRows() {
    const rows = [];
    ['carpark', 'metered', 'ev'].forEach(function (type) {
      state.data[type].forEach(function (row) {
        if (!state.toggles[type]) return;
        if (!matchesDistrict(row)) return;
        if (!matchesSearch(row)) return;
        rows.push(row);
      });
    });
    return rows;
  }

  function matchesDistrict(row) {
    if (!state.selectedDistrict) return true;
    return normalizeKey(row.district_en) === normalizeKey(state.selectedDistrict);
  }

  function matchesSearch(row) {
    if (!state.searchTerm) return true;
    const detail = row.detail_row || getDetailRow(row.base_section_id || row.id);
    const haystack = normalizeText([
      row.id,
      row.name_tc,
      row.name_en,
      row.district_tc,
      row.district_en,
      detail && detail.address_tc,
      detail && detail.address_en,
      row.address_tc,
      row.address_en
    ].join(' '));
    return haystack.indexOf(state.searchTerm) !== -1;
  }

  function renderResults() {
    const target = state.hooks.results;
    const total = state.visibleRows.length;
    const visible = state.visibleRows.slice(0, state.config.visibleResultLimit);
    setText(state.hooks.searchStatus, total ? (total + ' 個符合條件地點 / matching map items') : '未找到符合條件地點 / No matching map items');
    if (!target) return;

    target.innerHTML = '';
    target.classList.add('public-map-results');
    visible.forEach(function (row) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'public-map-result';
      button.dataset.rowId = row.id;
      button.innerHTML = [
        '<strong>' + escapeHtml(row.name_tc || row.name_en || row.id) + '</strong>',
        row.name_en && row.name_en !== row.name_tc ? '<div>' + escapeHtml(row.name_en) + '</div>' : '',
        '<div class="meta">' + escapeHtml(TYPE_META[row.type].labelBilingual + ' | ' + joinBilingual(row.district_tc, row.district_en)) + '</div>',
        '<div class="meta">' + escapeHtml(getLiveSummary(row) || formatCapacity(row) || row.id) + '</div>'
      ].join('');
      button.addEventListener('click', function () {
        openRowOnMap(row.id);
      });
      target.appendChild(button);
    });
  }

  function renderErrorResults(error) {
    if (!state.hooks.results) return;
    state.hooks.results.innerHTML = '<div class="public-map-result">' + escapeHtml(error && error.message ? error.message : 'Unknown error') + '</div>';
  }

  function updateSummaryHooks() {
    const totalAll = state.data.carpark.length + state.data.metered.length + state.data.ev.length;
    const visibleCount = state.visibleRows.length;
    setText(state.hooks.visibleCount, String(visibleCount));
    setText(state.hooks.totalCount, String(totalAll));
    if (state.fallbackVisibleCount) {
      setText(state.fallbackVisibleCount, 'Visible: ' + visibleCount + ' / ' + totalAll);
    }
  }

  function syncToggle(type) {
    const toggle = state.hooks.toggles[type];
    if (!toggle) return;
    if ('checked' in toggle) toggle.checked = state.toggles[type];
  }

  function syncLayerStatus(type) {
    const visible = state.visibleRows.filter(function (row) {
      return row.type === type;
    }).length;
    const total = state.data[type].length;
    const label = state.toggles[type] ? visible + ' visible / ' + total + ' total' : 'Hidden';
    setText(state.hooks.layerStatus[type], label);
  }

  function syncLayerCount(type) {
    const visible = state.visibleRows.filter(function (row) {
      return row.type === type;
    }).length;
    setText(state.hooks.layerCount[type], String(visible));
  }

  function focusFirstVisibleResult() {
    if (!state.visibleRows.length) return;
    openRowOnMap(state.visibleRows[0].id);
  }

  function focusResult(rowId) {
    const target = state.hooks.results;
    if (!target) return;
    const buttons = target.querySelectorAll('.public-map-result');
    buttons.forEach(function (button) {
      button.removeAttribute('data-active');
    });
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons[index];
      if (normalizeKey(button.dataset.rowId) === normalizeKey(rowId)) {
        button.setAttribute('data-active', 'true');
        break;
      }
    }
  }

  function openRowOnMap(rowId) {
    const row = findRowById(rowId);
    if (!row || !state.map) return;
    const marker = state.markers[row.type].get(normalizeKey(row.id));
    if (!marker) return;
    state.map.setView([row.latitude, row.longitude], Math.max(state.map.getZoom(), 15), { animate: true });
    marker.openPopup();
  }

  function maybeOpenRequestedSection() {
    if (!state.pendingSectionId) return;
    const row = findRowById(state.pendingSectionId);
    if (!row) return;
    const marker = state.markers[row.type].get(normalizeKey(row.id));
    if (!marker) return;
    state.pendingSectionId = '';
    setTimeout(function () {
      openRowOnMap(row.id);
    }, 0);
  }

  function fitMapToVisibleData() {
    if (!state.map) return;
    const rows = state.visibleRows.length ? state.visibleRows : state.data.carpark.concat(state.data.metered, state.data.ev);
    const latLngs = rows.filter(function (row) {
      return Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
    }).map(function (row) {
      return [row.latitude, row.longitude];
    });
    if (!latLngs.length) return;
    const bounds = L.latLngBounds(latLngs);
    state.map.fitBounds(bounds, { padding: [24, 24] });
  }

  function getLiveRatio(row) {
    if (row.type === 'carpark') {
      const live = state.live.carpark.get(normalizeKey(row.id));
      if (!live || typeof live.vacancy !== 'number' || row.total_spaces <= 0) return null;
      return live.vacancy / row.total_spaces;
    }
    if (row.type === 'metered') {
      const live = state.live.metered.get(normalizeKey(row.id));
      if (!live || live.total <= 0) return null;
      return live.vacant / live.total;
    }
    if (row.type === 'ev') {
      if (row.total_spaces <= 0) return null;
      return row.available / row.total_spaces;
    }
    return null;
  }

  function getLiveSummary(row) {
    if (row.type === 'carpark') {
      const live = state.live.carpark.get(normalizeKey(row.id));
      if (!live || typeof live.vacancy !== 'number' || live.vacancy < 0) return '';
      return live.vacancy + ' vacant';
    }
    if (row.type === 'metered') {
      const live = state.live.metered.get(normalizeKey(row.id));
      if (!live || typeof live.vacant !== 'number') return '';
      return live.vacant + ' vacant / ' + live.total + ' total';
    }
    if (row.type === 'ev') {
      return row.available + ' available / ' + row.total_spaces + ' chargers';
    }
    return '';
  }

  function formatCapacity(row) {
    if (!row || !row.total_spaces) return '';
    if (row.type === 'ev') return row.total_spaces + ' chargers';
    if (row.type === 'metered') return row.total_spaces + ' spaces';
    return row.total_spaces + ' parking spaces';
  }

  function formatEvMix(mix) {
    const labels = [
      ['standard', 'Standard'],
      ['medium', 'Medium'],
      ['fast', 'Fast'],
      ['superfast', 'Superfast'],
      ['other', 'Other']
    ];
    return labels.filter(function (pair) {
      return (mix[pair[0]] || 0) > 0;
    }).map(function (pair) {
      return pair[1] + ': ' + mix[pair[0]];
    }).join(', ');
  }

  function findRowById(rowId) {
    const key = normalizeKey(rowId);
    return ['carpark', 'metered', 'ev'].reduce(function (found, type) {
      if (found) return found;
      for (let index = 0; index < state.data[type].length; index += 1) {
        if (normalizeKey(state.data[type][index].id) === key) return state.data[type][index];
      }
      return null;
    }, null);
  }

  function getDetailRow(rowId) {
    return state.detailRows.get(normalizeKey(rowId)) || null;
  }

  function buildSnapshotPublicUrl(filename) {
    return SUPABASE_URL + '/storage/v1/object/public/' + SNAPSHOT_BUCKET + '/' + filename;
  }

  function readInlinePayload(type) {
    const globalPayload = window.__PUBLIC_MAP_SNAPSHOT__ || window.PUBLIC_MAP_SNAPSHOT || window.__MAP_SNAPSHOT__;
    if (globalPayload) {
      if (type === 'manifest' && globalPayload.snapshots) return globalPayload;
      if (Array.isArray(globalPayload[type])) return globalPayload[type];
      if (globalPayload[type] && Array.isArray(globalPayload[type].rows)) return globalPayload[type].rows;
    }

    const scriptCandidates = type === 'manifest'
      ? ['public-map-manifest', 'map-snapshot-manifest']
      : ['public-map-' + type, 'map-snapshot-' + type, 'map-' + type + '-snapshot'];

    for (let index = 0; index < scriptCandidates.length; index += 1) {
      const script = document.getElementById(scriptCandidates[index]);
      if (!script || !script.textContent) continue;
      try {
        return JSON.parse(script.textContent);
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  async function fetchJsonCached(url, options) {
    const settings = options || {};
    const ttlMs = typeof settings.ttlMs === 'number' ? settings.ttlMs : state.config.cacheTtlMs;
    const cacheKey = settings.cacheKey || url;
    const cached = readSessionCache(cacheKey, ttlMs);
    if (cached != null) return cached;

    const response = await fetch(url, { cache: 'default' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    const text = await response.text();
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const json = JSON.parse(clean);
    writeSessionCache(cacheKey, json);
    return json;
  }

  async function fetchTextCached(url, options) {
    const settings = options || {};
    const ttlMs = typeof settings.ttlMs === 'number' ? settings.ttlMs : state.config.cacheTtlMs;
    const cacheKey = settings.cacheKey || url;
    const cached = readSessionCache(cacheKey, ttlMs);
    if (typeof cached === 'string') return cached;

    const response = await fetch(url, { cache: 'default' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    const text = await response.text();
    writeSessionCache(cacheKey, text);
    return text;
  }

  function readSessionCache(cacheKey, ttlMs) {
    if (!window.sessionStorage) return null;
    try {
      const raw = window.sessionStorage.getItem(cacheKey);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (!record || typeof record.timestamp !== 'number') return null;
      if (Date.now() - record.timestamp > ttlMs) {
        window.sessionStorage.removeItem(cacheKey);
        return null;
      }
      return record.value;
    } catch (_error) {
      return null;
    }
  }

  function writeSessionCache(cacheKey, value) {
    if (!window.sessionStorage) return;
    try {
      window.sessionStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        value: value
      }));
    } catch (_error) {
      // Ignore storage quota / privacy-mode failures.
    }
  }

  function parseCsvLine(line) {
    const cells = [];
    let current = '';
    let insideQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (insideQuotes && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  }

  function findFirst(selectors) {
    for (let index = 0; index < selectors.length; index += 1) {
      const element = document.querySelector(selectors[index]);
      if (element) return element;
    }
    return null;
  }

  function setText(element, value) {
    if (!element) return;
    element.textContent = value;
  }

  function setStatus(message, tone) {
    const value = message || '';
    setText(state.hooks.status, value);
    if (state.hooks.status && tone) state.hooks.status.dataset.state = tone;
  }

  function normalizeText(value) {
    return stringOrEmpty(value).trim().toLowerCase();
  }

  function normalizeKey(value) {
    return normalizeText(value);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function stringOrEmpty(value) {
    return value == null ? '' : String(value);
  }

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function firstNonEmpty() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function firstFinite() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = Number(arguments[index]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function joinBilingual(tc, en) {
    const parts = [];
    if (tc) parts.push(String(tc).trim());
    if (en && String(en).trim() !== String(tc || '').trim()) parts.push(String(en).trim());
    return parts.join(' / ');
  }

  function buildMapsUrl(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    return 'https://maps.google.com/maps?q=' + encodeURIComponent(latitude + ',' + longitude);
  }

  function normalizeEvMix(value) {
    const mix = value && typeof value === 'object' ? value : {};
    return {
      standard: numberOrZero(mix.standard),
      medium: numberOrZero(mix.medium),
      fast: numberOrZero(mix.fast),
      superfast: numberOrZero(mix.superfast),
      other: numberOrZero(mix.other)
    };
  }

  function indexBy(rows, getKey) {
    const map = new Map();
    (rows || []).forEach(function (row) {
      const key = normalizeKey(getKey(row));
      if (!key) return;
      map.set(key, row);
    });
    return map;
  }

  function parseCenter(rawValue) {
    const parts = String(rawValue || '').split(',').map(function (part) {
      return Number(part.trim());
    });
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return parts;
  }
})();
