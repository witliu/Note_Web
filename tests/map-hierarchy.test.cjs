// Province navigation, selection, and race handling, independent of personal data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const china = JSON.parse(fs.readFileSync('web/map-data/china.json', 'utf8'));
const children = code => JSON.parse(fs.readFileSync(`web/map-data/provinces/${code}.json`, 'utf8'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function bootMap() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', options: [], disabled: false,
      replaceChildren(...items) { this.options = items; this.value = items[0]?.value || ''; },
      add(item) { this.options.push(item); },
      cloneNode() { return { textContent: this.textContent }; }
    });
    return nodes.get(selector);
  };
  const picks = [], layers = [], requests = [], fits = [];
  const state = { fetch: async code => ({ ok: true, json: async () => children(code) }) };
  const map = {
    attributionControl: { setPrefix() {}, addAttribution() {} },
    fitBounds(bounds) { fits.push(bounds); }, getZoom: () => 5,
    on() {}, removeLayer(layer) { layer.removed = true; },
    invalidateSize() {}, getCenter: () => ({ lat: 30, lng: 120 })
  };
  const group = () => ({ addTo() { return this; }, clearLayers() {}, eachLayer() {} });
  const L = {
    map: () => map, layerGroup: group, divIcon: o => o,
    marker: (point, options) => ({ options, addTo() { return this; }, setOpacity() {} }),
    geoJSON(data, options = {}) {
      const features = data.features || [data];
      const layer = { features, options, events: [], addTo() { return this; }, getBounds: () => features[0].properties.adcode };
      for (const feature of features) {
        const events = {};
        options.onEachFeature?.(feature, { on(event, fn) { events[event] = fn; }, bindTooltip() {} });
        layer.events.push(events);
      }
      layers.push(layer); return layer;
    }
  };
  const context = vm.createContext({
    L, console,
    document: { querySelector: node, createElement: tag => node(`element-${nodes.size}-${tag}`) },
    Option: function(text, value) { this.text = text; this.value = value; },
    fetch: async path => {
      requests.push(path);
      if (path.endsWith('china.json')) return { ok: true, json: async () => china };
      return state.fetch(path.match(/(\d{6})\.json$/)[1]);
    }
  });
  vm.runInContext(fs.readFileSync('web/map.js', 'utf8'), context);
  const controller = await context.JournalMap.create('map', { onPick: point => picks.push(point), onViewport() {} });
  const select = async code => { node('#mapProvince').value = code; node('#mapProvince').onchange(); await new Promise(setImmediate); };
  return { node, state, requests, layers, fits, picks, controller, select };
}

test('all available province child boundaries are local and retain their source parent', () => {
  let count = 0;
  for (const province of china.features.filter(f => f.properties.childrenNum > 0)) {
    const data = children(province.properties.adcode);
    assert.equal(data.type, 'FeatureCollection');
    assert.equal(data.features.length, province.properties.childrenNum);
    for (const feature of data.features) {
      assert.equal(feature.properties.parent.adcode, province.properties.adcode);
      assert.ok(feature.geometry.coordinates.length);
      assert.ok(feature.properties.name);
    }
    count += data.features.length;
  }
  assert.equal(count, 475);
});

test('clicking a province zooms without creating a footprint; clicking a city retains exact coordinate', async () => {
  const b = await bootMap();
  const national = b.layers.find(l => l.features.length === china.features.length);
  const index = china.features.findIndex(f => f.properties.adcode === 330000);
  national.events[index].click();
  await new Promise(setImmediate);
  assert.equal(b.picks.length, 0);
  assert.ok(b.fits.includes(330000));
  const cities = b.layers.find(l => l.options.style?.className === 'china-city');
  assert.equal(cities.options.bubblingMouseEvents, false);
  const city = cities.features[0];
  cities.events[0].click({ latlng: { lng: 120.12345678, lat: 30.45678912 } });
  assert.equal(b.picks[0].longitude, 120.123457);
  assert.equal(b.picks[0].latitude, 30.456789);
  assert.equal(b.picks[0].city, city.properties.name);
  assert.equal(b.picks[0].province, `浙江省 · ${city.properties.name}`);
});

test('dropdown selects a city using its reference center and caches the province data', async () => {
  const b = await bootMap(); await b.select('330000');
  const city = children(330000).features[0];
  b.node('#mapCity').value = String(city.properties.adcode);
  b.node('#mapCity').onchange();
  assert.equal(b.picks[0].longitude, Number((city.properties.centroid || city.properties.center)[0].toFixed(6)));
  assert.equal(b.picks[0].city, city.properties.name);
  await b.select('330000');
  assert.equal(b.requests.filter(p => p.includes('330000')).length, 1);
});

test('late province response cannot replace a newer selection or resurrect a reset map', async () => {
  const b = await bootMap(), old = deferred();
  b.state.fetch = code => code === '330000' ? old.promise : Promise.resolve({ ok: true, json: async () => children(code) });
  await b.select('330000'); await b.select('320000');
  old.resolve({ ok: true, json: async () => children(330000) });
  await new Promise(setImmediate);
  assert.equal(b.node('#mapProvince').value, '320000');
  assert.match(b.node('#mapRegionStatus').textContent, /江苏省/);
  assert.equal(b.layers.filter(l => l.options.style?.className === 'china-city').length, 1);
  const pending = deferred(); b.state.fetch = () => pending.promise;
  await b.select('340000'); b.controller.reset();
  pending.resolve({ ok: true, json: async () => children(340000) }); await new Promise(setImmediate);
  assert.equal(b.node('#mapProvince').value, '');
  assert.equal(b.node('#mapCity').disabled, true);
  assert.match(b.node('#mapRegionStatus').textContent, /全国/);
});

test('failed data can be retried and municipalities show district boundaries', async () => {
  const b = await bootMap(); b.state.fetch = async () => ({ ok: false });
  await b.select('110000');
  assert.match(b.node('#mapRegionStatus').textContent, /重试/);
  assert.equal(b.node('#mapCity').disabled, true);
  b.state.fetch = async code => ({ ok: true, json: async () => children(code) });
  await b.select('110000');
  assert.equal(b.node('#mapCity').disabled, false);
  assert.equal(b.node('#mapCity').options.length, 17);
  assert.match(b.node('#mapRegionStatus').textContent, /区县/);
});

test('areas without child boundaries remain selectable without a failing network request', async () => {
  const b = await bootMap(); await b.select('710000');
  assert.equal(b.requests.length, 1);
  assert.match(b.node('#mapRegionStatus').textContent, /暂未提供/);
  b.node('#mapCity').value = '710000'; b.node('#mapCity').onchange();
  assert.equal(b.picks[0].city, '台湾省');
  assert.equal(b.picks[0].province, '台湾省');
});
