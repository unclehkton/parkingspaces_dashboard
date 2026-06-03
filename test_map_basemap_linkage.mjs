import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const mapIndexHtml = fs.readFileSync(path.join(repoRoot, 'parkingspaces_dashboard', 'map', 'index.html'), 'utf8');
const mapAppJs = fs.readFileSync(path.join(repoRoot, 'parkingspaces_dashboard', 'map', 'app.js'), 'utf8');

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
