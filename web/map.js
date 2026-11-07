/* Local province/city map. Boundary geometry is kept in the provider's GeoJSON space. */
globalThis.JournalMap = (() => {
  const LIMITS = { west: 72, east: 136, south: 2, north: 55 };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function validPoint(point) {
    return Number.isFinite(point.longitude) && Number.isFinite(point.latitude) &&
      point.longitude >= LIMITS.west && point.longitude <= LIMITS.east &&
      point.latitude >= LIMITS.south && point.latitude <= LIMITS.north;
  }

  function boundsQuery(bounds) {
    return {
      west: clamp(bounds.getWest(), LIMITS.west, LIMITS.east),
      east: clamp(bounds.getEast(), LIMITS.west, LIMITS.east),
      south: clamp(bounds.getSouth(), LIMITS.south, LIMITS.north),
      north: clamp(bounds.getNorth(), LIMITS.south, LIMITS.north)
    };
  }

  async function create(element, callbacks) {
    if (!globalThis.L) throw new Error('地图组件加载失败，请刷新页面重试');
    const response = await fetch('/map-data/china.json');
    if (!response.ok) throw new Error('中国地图数据暂时无法读取，请重试');
    const data = await response.json();
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('地图数据格式错误');
    const map = L.map(element, {
      minZoom: 2, maxZoom: 10, zoomSnap: .25, zoomDelta: .5,
      maxBounds: [[0, 65], [60, 145]], maxBoundsViscosity: .8,
      scrollWheelZoom: false, attributionControl: true
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>');
    map.attributionControl.addAttribution('<a href="https://datav.aliyun.com/portal/school/atlas/area_selector" target="_blank" rel="noopener">地图数据：DataV.GeoAtlas</a>');
    const labels = L.layerGroup().addTo(map);
    const markers = L.layerGroup().addTo(map);
    const cityLabels = L.layerGroup().addTo(map);
    const provinceSelect = document.querySelector('#mapProvince');
    const citySelect = document.querySelector('#mapCity');
    const regionStatus = document.querySelector('#mapRegionStatus');
    const provinces = data.features.filter(f => f.properties?.level === 'province');
    const cache = new Map();
    let activeProvince = null, cities = null, regionRequest = 0;
    const setOptions = (select, placeholder, features) => {
      select.replaceChildren(new Option(placeholder, ''));
      for (const feature of features) select.add(new Option(feature.properties.name, String(feature.properties.adcode)));
    };
    setOptions(provinceSelect, '选择省份／地区', provinces);
    setOptions(citySelect, '先选择省份', []);
    citySelect.disabled = true;
    const regionName = city => [activeProvince?.properties.name, city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
    const chooseCity = (feature, latlng) => {
      const props = feature.properties;
      const center = props.centroid || props.center;
      if (!latlng && !center) return;
      citySelect.value = String(props.adcode);
      if (!latlng) {
        const layer = L.geoJSON(feature);
        map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 10 });
      }
      pick(latlng || { lng: center[0], lat: center[1] }, regionName(props.name), props.name);
    };
    const clearRegion = () => {
      if (cities) { map.removeLayer(cities); cities = null; }
      cityLabels.clearLayers();
    };
    const enterProvince = async feature => {
      const request = ++regionRequest;
      const props = feature.properties;
      clearRegion(); activeProvince = feature;
      provinceSelect.value = String(props.adcode);
      citySelect.disabled = true;
      setOptions(citySelect, '正在加载…', []);
      regionStatus.textContent = `正在展开${props.name}…`;
      labels.eachLayer(label => label.setOpacity(0));
      map.fitBounds(L.geoJSON(feature).getBounds(), { padding: [24, 24], maxZoom: 10 });
      try {
        let children;
        if (!props.childrenNum) {
          children = { type: 'FeatureCollection', features: [feature] };
        } else {
          const code = String(props.adcode);
          if (!cache.has(code)) cache.set(code, (async () => {
            const response = await fetch(`/map-data/provinces/${code}.json`);
            if (!response.ok) throw new Error('地图数据加载失败');
            const result = await response.json();
            if (result.type !== 'FeatureCollection' || !result.features?.length) throw new Error('地图数据格式错误');
            return result;
          })().catch(error => { cache.delete(code); throw error; }));
          children = await cache.get(code);
        }
        if (request !== regionRequest) return;
        const features = children.features.filter(f => f.properties?.name);
        cities = L.geoJSON({ ...children, features }, {
          bubblingMouseEvents: false,
          style: { color: '#b96989', weight: 1.3, fillColor: '#f5cfdf', fillOpacity: .95, className: 'china-city' },
          onEachFeature(child, layer) {
            const text = document.createElement('span'); text.textContent = child.properties.name;
            layer.bindTooltip(text, { sticky: true, className: 'province-tooltip' });
            layer.on('click', event => chooseCity(child, event.latlng));
            const center = child.properties.centroid || child.properties.center;
            if (center) L.marker([center[1], center[0]], {
              interactive: false, keyboard: false,
              icon: L.divIcon({ html: text.cloneNode(true), className: 'province-label city-label', iconSize: [120, 20], iconAnchor: [60, 10] })
            }).addTo(cityLabels);
          }
        }).addTo(map);
        setOptions(citySelect, '选择城市／地区', features);
        citySelect.disabled = false;
        citySelect.onchange = () => {
          const child = features.find(f => String(f.properties.adcode) === citySelect.value);
          if (child) chooseCity(child);
        };
        const isDistrict = features.some(f => f.properties.level === 'district');
        regionStatus.textContent = !props.childrenNum ? `${props.name}：数据源暂未提供下级边界，可在区域内标点。` :
          `${props.name} · 点击${isDistrict ? '市／区县' : '城市／地区'}标定足迹，也可用下拉框选择。`;
      } catch {
        if (request !== regionRequest) return;
        setOptions(citySelect, '加载失败，请重新选择省份', []);
        regionStatus.textContent = `${props.name}的地图暂时无法加载，请再次点击该省份或切换省份重试。`;
      }
    };
    provinceSelect.onchange = () => {
      const feature = provinces.find(f => String(f.properties.adcode) === provinceSelect.value);
      if (feature) enterProvince(feature); else fit();
    };
    let preview = null;
    const pick = (latlng, province = '', city = '') => {
      const point = { longitude: Number(latlng.lng.toFixed(6)), latitude: Number(latlng.lat.toFixed(6)), province, city };
      if (!validPoint(point)) { callbacks.onOutside?.(); return; }
      callbacks.onPick(point);
    };
    const outline = L.geoJSON(data, {
      bubblingMouseEvents: false,
      style: feature => ({ color: '#bc839a', weight: .85, fillColor: '#f8e2eb', fillOpacity: .96,
        bubblingMouseEvents: false, className: 'china-province' }),
      onEachFeature(feature, layer) {
        const name = feature.properties?.name || '';
        layer.on('click', () => {
          if (feature.properties?.level === 'province' && (activeProvince !== feature || !cities)) enterProvince(feature);
        });
        if (name) {
          const text = document.createElement('span'); text.textContent = name;
          layer.bindTooltip(text, { sticky: true, className: 'province-tooltip' });
        }
        const center = feature.properties?.centroid || feature.properties?.center;
        if (center && feature.properties?.level === 'province') {
          const text = document.createElement('span');
          text.textContent = name.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市/g, '');
          const crowded = [110000, 120000, 310000, 810000, 820000].includes(feature.properties.adcode);
          const label = L.marker([center[1], center[0]], {
            interactive: false, keyboard: false, minLabelZoom: crowded ? 4.5 : 0,
            icon: L.divIcon({ html: text, className: 'province-label', iconSize: [76, 18], iconAnchor: [38, 9] })
          }).addTo(labels);
          label.setOpacity(map.getZoom() >= label.options.minLabelZoom ? 1 : 0);
        }
      }
    }).addTo(map);
    const fit = () => {
      ++regionRequest; activeProvince = null; clearRegion();
      provinceSelect.value = ''; citySelect.disabled = true;
      setOptions(citySelect, '先选择省份', []);
      regionStatus.textContent = '全国 · 点击省份放大，再选择城市标定足迹。';
      map.fitBounds(outline.getBounds(), { padding: [18, 18], animate: false });
      labelVisibility();
    };
    const labelVisibility = () => labels.eachLayer(label => label.setOpacity(!activeProvince && map.getZoom() >= label.options.minLabelZoom ? 1 : 0));
    fit();
    map.on('zoomend', labelVisibility);
    map.on('click', event => { if (activeProvince) pick(event.latlng); });
    map.on('moveend', () => callbacks.onViewport());

    return {
      invalidate() { map.invalidateSize({ pan: false }); },
      reset: fit,
      bounds() { return boundsQuery(map.getBounds()); },
      focus(point) { map.setView([point.latitude, point.longitude], Math.max(map.getZoom(), 5)); },
      preview(point) {
        if (preview) { map.removeLayer(preview); preview = null; }
        if (point) preview = L.circleMarker([point.latitude, point.longitude], {
          radius: 9, color: '#823c58', weight: 3, fillColor: '#f6a9c5', fillOpacity: 1, interactive: false
        }).addTo(map);
      },
      setMarkers(items) {
        markers.clearLayers();
        for (const point of items) {
          const pin = L.marker([point.latitude, point.longitude], {
            title: point.name, alt: point.name, keyboard: true, bubblingMouseEvents: false,
            icon: L.divIcon({ className: 'footprint-pin', html: '<span aria-hidden="true">♡</span>', iconSize: [30, 36], iconAnchor: [15, 34] })
          }).addTo(markers);
          const name = document.createElement('span'); name.textContent = point.name;
          pin.bindTooltip(name, { direction: 'top', offset: [0, -25] });
          pin.on('click', () => callbacks.onOpen(point.id));
        }
      }
    };
  }
  return { create, validPoint, boundsQuery };
})();
