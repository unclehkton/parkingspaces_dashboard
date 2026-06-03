import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const mapIndexHtml = fs.readFileSync(path.join(repoRoot, 'parkingspaces_dashboard', 'map', 'index.html'), 'utf8');
const mapAppJs = fs.readFileSync(path.join(repoRoot, 'parkingspaces_dashboard', 'map', 'app.js'), 'utf8');
const cname = fs.readFileSync(path.join(repoRoot, 'parkingspaces_dashboard', 'CNAME'), 'utf8');

test('map page loads a dedicated basemap config before bootstrapping the app', () => {
  assert.match(mapIndexHtml, /<script\s+src="\.\/config\.js"><\/script>/);
  assert.ok(
    mapIndexHtml.indexOf('<script src="./config.js"></script>') < mapIndexHtml.indexOf('<script type="module" src="./app.js'),
    'config.js should load before app.js'
  );
});

test('map app reads HK basemap config, versions the PMTiles URL, and forwards flavor/lang', () => {
  assert.match(mapAppJs, /window\.HK_BASEMAP_CONFIG/);
  assert.match(mapAppJs, /pmtilesVersion|generatedAt|cacheBust/i);
  assert.match(mapAppJs, /flavor:\s*state\.config\.pmtilesFlavor/);
  assert.match(mapAppJs, /lang:\s*state\.config\.pmtilesLang/);
});

test('map app defaults initial load to Yau Tsim Mong when no district filter is requested', () => {
  assert.match(mapAppJs, /DEFAULT_INITIAL_DISTRICT\s*=\s*'Yau Tsim Mong'/);
  assert.match(mapAppJs, /requestedDistrict\s*\|\|\s*DEFAULT_INITIAL_DISTRICT/);
});

test('initial map viewport is fitted after visible rows are rendered, not before buildMap finishes', () => {
  const buildMapStart = mapAppJs.indexOf('function buildMap()');
  const createPanesStart = mapAppJs.indexOf('function createPanes()');
  const buildMapBlock = mapAppJs.slice(buildMapStart, createPanesStart);
  assert.match(mapAppJs, /hasAppliedInitialViewport:\s*false/);
  assert.doesNotMatch(buildMapBlock, /fitMapToVisibleData\(\);/);
  assert.match(mapAppJs, /if\s*\(!state\.hasAppliedInitialViewport\)\s*{\s*fitMapToVisibleData\(\);[\s\S]*state\.hasAppliedInitialViewport\s*=\s*true;/);
});

test('pages repo is configured for the parking.pkwor.com custom domain', () => {
  assert.equal(cname.trim(), 'parking.pkwor.com');
});
