/* Local province map. Boundary geometry is kept in the provider's GeoJSON space. */
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
    let preview = null;
    const pick = (latlng, province = '') => {
      const point = { longitude: Number(latlng.lng.toFixed(6)), latitude: Number(latlng.lat.toFixed(6)), province };
      if (!validPoint(point)) { callbacks.onOutside?.(); return; }
      callbacks.onPick(point);
    };
    const outline = L.geoJSON(data, {
      style: feature => ({ color: '#bc839a', weight: .85, fillColor: '#f8e2eb', fillOpacity: .96,
        bubblingMouseEvents: false, className: 'china-province' }),
      onEachFeature(feature, layer) {
        const name = feature.properties?.name || '';
        layer.on('click', event => pick(event.latlng, feature.properties?.adcode === '100000_JD' ? '' : name));
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
    const fit = () => map.fitBounds(outline.getBounds(), { padding: [18, 18], animate: false });
    fit();
    const labelVisibility = () => labels.eachLayer(label => label.setOpacity(map.getZoom() >= label.options.minLabelZoom ? 1 : 0));
    labelVisibility();
    map.on('zoomend', labelVisibility);
    map.on('click', event => pick(event.latlng));
    map.on('moveend', () => callbacks.onViewport());

    return {
      invalidate() { map.invalidateSize({ pan: false }); },
      reset: fit,
      bounds() { return boundsQuery(map.getBounds()); },
      center() { const point = map.getCenter(); return { longitude: point.lng, latitude: point.lat, province: '' }; },
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
