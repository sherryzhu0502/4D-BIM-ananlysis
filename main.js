'use strict';

// ===== 状态 =====
let viewer      = null;   // APS Viewer 实例
let esriMap     = null;   // ArcGIS Map 实例
let mapView     = null;   // ArcGIS MapView 实例
let markerLayer = null;   // ArcGIS 标记图层
let currentUrn  = null;   // 当前 APS 模型 URN
let activeTab   = '3d';   // '3d' | 'map'
let projectGeo  = null;   // { latitude, longitude }
let selectedData = null;  // APS 选中的构件数据
let allCoordsCache = null;

const $ = id => document.getElementById(id);
const dom = {
    uploadZone:      $('upload-zone'),
    fileInput:       $('file-input'),
    btnChoose:       $('btn-choose'),
    uploadProgress:  $('upload-progress'),
    progressFill:    $('progress-fill'),
    progressText:    $('progress-text'),
    progressPct:     $('progress-pct'),
    modelsList:      $('models-list'),
    coordPanel:      $('coord-panel'),
    btnCopy:         $('btn-copy'),
    btnExport:       $('btn-export'),
    btnLoadAll:      $('btn-load-all'),
    allCoordsPanel:  $('all-coords-panel'),
    modelNameHeader: $('model-name-header'),
    viewerEmpty:     $('viewer-empty'),
};

// ===== 视图切换 =====

function switchTab(tab) {
    activeTab = tab;
    $('tab-3d').classList.toggle('active', tab === '3d');
    $('tab-map').classList.toggle('active', tab === 'map');
    $('viewer').classList.toggle('hidden', tab !== '3d');
    $('map-container').classList.toggle('hidden', tab !== 'map');

    if (tab === 'map') {
        initArcGISMap();   // 懒加载，已初始化则直接显示
    }

    // 切换到地图时更新坐标面板提示
    if (tab === 'map' && !projectGeo) {
        dom.coordPanel.innerHTML = `
            <div class="coord-empty">
                <div style="font-size:20px;margin-bottom:8px">📍</div>
                <div>请先在左侧设置坐标</div>
                <div style="font-size:11px;color:var(--text-dim);margin-top:4px">地图将定位到项目位置</div>
            </div>`;
    }
}

// ===== APS Viewer 初始化 =====

async function initViewer() {
    return new Promise((resolve, reject) => {
        Autodesk.Viewing.Initializer({
            env: 'AutodeskProduction2',
            api: 'streamingV2',
            getAccessToken: async (cb) => {
                const r = await fetch('/api/token');
                const d = await r.json();
                cb(d.access_token, d.expires_in);
            }
        }, () => {
            viewer = new Autodesk.Viewing.GuiViewer3D($('viewer'), {});
            if (viewer.start() > 0) { reject(new Error('Viewer 启动失败')); return; }
            viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, onSelectionChanged);
            viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
            resolve(viewer);
        });
    });
}

async function loadModel(urn) {
    currentUrn = urn;
    allCoordsCache = null;
    return new Promise((resolve, reject) => {
        Autodesk.Viewing.Document.load(`urn:${urn}`, (doc) => {
            const views = doc.getRoot().search({ type: 'geometry' });
            const view  = views.find(v => v.data.role === '3d') || views[0];
            if (!view) { reject(new Error('未找到可视化视图')); return; }
            if (dom.viewerEmpty) dom.viewerEmpty.style.display = 'none';
            viewer.loadDocumentNode(doc, view).then(resolve).catch(reject);
        }, (code, msg) => reject(new Error(`加载失败(${code}): ${msg}`)));
    });
}

function onGeometryLoaded() {
    dom.btnExport.disabled  = false;
    dom.btnLoadAll.disabled = false;
    showCoordEmpty();
}

// ===== APS 构件选中 =====

function onSelectionChanged(event) {
    const ids = event.dbIdArray;
    if (!ids?.length) { showCoordEmpty(); return; }
    const bbox = getNodeBBox(viewer.model, ids[0]);
    viewer.getProperties(ids[0], (props) => {
        selectedData = { dbId: ids[0], props, bbox };
        dom.btnCopy.disabled = false;
        renderCoordPanel(props, bbox);
    }, () => showCoordEmpty());
}

function getNodeBBox(model, dbId) {
    try {
        const tree = model.getInstanceTree();
        const frags = model.getFragmentList();
        if (!tree || !frags) return null;
        let minX=Infinity, minY=Infinity, minZ=Infinity;
        let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
        tree.enumNodeFragments(dbId, (fragId) => {
            const b = new THREE.Box3();
            frags.getWorldBounds(fragId, b);
            if (b.min.x < minX) minX=b.min.x; if (b.min.y < minY) minY=b.min.y; if (b.min.z < minZ) minZ=b.min.z;
            if (b.max.x > maxX) maxX=b.max.x; if (b.max.y > maxY) maxY=b.max.y; if (b.max.z > maxZ) maxZ=b.max.z;
        }, true);
        if (!isFinite(minX)) return null;
        return { min:{x:minX,y:minY,z:minZ}, max:{x:maxX,y:maxY,z:maxZ},
                 center:{x:(minX+maxX)/2, y:(minY+maxY)/2, z:(minZ+maxZ)/2} };
    } catch(e) { return null; }
}

function renderCoordPanel(props, bbox) {
    const fmt = v => typeof v === 'number' ? v.toFixed(4) : v;
    const c = bbox?.center;
    const coordRe = /^(x|y|z)\s*$|offset|position|location|elevation|level|height/i;
    const coordProps = (props.properties||[]).filter(p => coordRe.test(p.displayName) && p.displayValue !== '');
    const otherProps  = (props.properties||[]).filter(p => !coordProps.includes(p) && p.type !== 'category').slice(0,15);

    let html = `<div class="coord-header">
        <div class="coord-name">${escHtml(props.name||'未命名构件')}</div>
        <div class="coord-meta">dbId: ${props.dbId}</div>
    </div><table class="coord-table"><thead><tr><th>属性</th><th>值</th></tr></thead><tbody>`;

    if (c) html += `
        <tr><td colspan="2" class="coord-group">中心坐标（模型空间）</td></tr>
        <tr class="primary"><td>X</td><td>${fmt(c.x)}</td></tr>
        <tr class="primary"><td>Y</td><td>${fmt(c.y)}</td></tr>
        <tr class="primary"><td>Z</td><td>${fmt(c.z)}</td></tr>`;

    if (bbox) html += `
        <tr><td colspan="2" class="coord-group">包围盒</td></tr>
        <tr><td>Min X</td><td>${fmt(bbox.min.x)}</td></tr>
        <tr><td>Min Y</td><td>${fmt(bbox.min.y)}</td></tr>
        <tr><td>Min Z</td><td>${fmt(bbox.min.z)}</td></tr>
        <tr><td>Max X</td><td>${fmt(bbox.max.x)}</td></tr>
        <tr><td>Max Y</td><td>${fmt(bbox.max.y)}</td></tr>
        <tr><td>Max Z</td><td>${fmt(bbox.max.z)}</td></tr>`;

    if (coordProps.length) {
        html += `<tr><td colspan="2" class="coord-group">属性坐标</td></tr>`;
        coordProps.forEach(p => html += `<tr class="primary"><td>${escHtml(p.displayName)}</td><td>${escHtml(String(p.displayValue))}</td></tr>`);
    }
    if (otherProps.length) {
        html += `<tr><td colspan="2" class="coord-group">其他属性</td></tr>`;
        otherProps.forEach(p => html += `<tr><td>${escHtml(p.displayName)}</td><td>${escHtml(String(p.displayValue))}</td></tr>`);
    }
    html += '</tbody></table>';
    dom.coordPanel.innerHTML = html;
}

function showCoordEmpty() {
    dom.coordPanel.innerHTML = `<div class="coord-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
             width="28" height="28" style="opacity:.3;margin-bottom:8px">
            <circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
        </svg>
        <div>3D 视图：点击构件</div><div>地图视图：点击位置</div>
    </div>`;
    dom.btnCopy.disabled = true;
    selectedData = null;
}

// ===== ArcGIS 地图初始化（懒加载）=====

let arcgisInitialized = false;
let _arcgisInitPromise = null;   // 缓存进行中的初始化 Promise

async function initArcGISMap() {
    if (arcgisInitialized) {
        if (projectGeo) placeMarker(projectGeo.latitude, projectGeo.longitude);
        return;
    }
    // 已在初始化中——等同一个 Promise 而不是直接返回
    if (_arcgisInitPromise) return _arcgisInitPromise;

    _arcgisInitPromise = _doInitArcGIS();
    return _arcgisInitPromise;
}

async function _doInitArcGIS() {

    try {
        // 获取 API Key、Feature Service URL、用户 Token
        const r = await fetch('/api/arcgis/key');
        const { key, serviceUrl: savedServiceUrl, userToken, username } = await r.json();

        // 自动填入已保存的 Feature Service URL
        if (savedServiceUrl && !$('cadlayer-url').value) {
            $('cadlayer-url').value = savedServiceUrl;
        }

        await loadArcGISSDK();

        await new Promise((resolve, reject) => {
            require(['esri/config','esri/Map','esri/views/MapView','esri/layers/GraphicsLayer','esri/identity/IdentityManager'],
            (esriConfig, Map, MapView, GraphicsLayer, IdentityManager) => {
                esriConfig.apiKey = key;

                // 注册用户 Token，允许访问私有服务
                if (userToken) {
                    const servers = [
                        'https://www.arcgis.com/sharing/rest',
                        'https://services.arcgis.com'
                    ];
                    servers.forEach(server => {
                        IdentityManager.registerToken({ server, token: userToken, userId: username, ssl: true });
                    });
                }

                markerLayer = new GraphicsLayer();
                const map = new Map({
                    basemap: buildSatelliteBasemap(),
                    layers: [markerLayer]
                });

                mapView = new MapView({
                    container: 'map-container',
                    map,
                    center: [172.5, -41],  // 新西兰默认中心
                    zoom: 5,
                    ui: { components: ['zoom', 'attribution'] }
                });

                mapView.when(() => {
                    if ($('map-empty')) $('map-empty').style.display = 'none';
                    setupMapClick();
                    arcgisInitialized = true;
                    arcgisInitializing = false;
                    if (projectGeo) placeMarker(projectGeo.latitude, projectGeo.longitude);
                    resolve();
                }, reject);
            });
        });
    } catch (err) {
        arcgisInitializing = false;
        console.error('ArcGIS init error:', err);
        $('map-container').innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;color:#888;gap:8px">
            <div style="font-size:32px">⚠️</div>
            <div>地图加载失败</div><div style="font-size:11px">${err.message}</div></div>`;
    }
}

function buildSatelliteBasemap() {
    // 使用 Esri 公共 World Imagery tile service（不需要 API key）
    return 'satellite';
}

function loadArcGISSDK() {
    return new Promise((resolve, reject) => {
        if (document.getElementById('arcgis-sdk')) {
            const wait = setInterval(() => { if (typeof require !== 'undefined') { clearInterval(wait); resolve(); } }, 50);
            return;
        }
        const s = document.createElement('script');
        s.id  = 'arcgis-sdk';
        s.src = 'https://js.arcgis.com/4.29/';
        s.onload = () => { const w = setInterval(() => { if (typeof require !== 'undefined') { clearInterval(w); resolve(); } }, 50); };
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ===== CADLayer 加载 =====

let cadLayerInstance = null;

async function loadCADLayer(serviceUrl, name) {
    if (activeTab !== 'map') switchTab('map');
    await initArcGISMap();

    // 先移除旧图层
    if (cadLayerInstance) {
        esriMap.remove(cadLayerInstance);
        cadLayerInstance = null;
    }

    // 尝试用 CADLayer，失败则降级到 FeatureLayer
    try {
        await tryCADLayer(serviceUrl, name);
    } catch (cadErr) {
        console.warn('[CADLayer] 失败，降级到 FeatureLayer:', cadErr.message);
        await tryFeatureLayer(serviceUrl, name);
    }
}

function tryCADLayer(serviceUrl, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('超时')), 15000);

        require(['esri/layers/CADLayer'], (CADLayer) => {
            cadLayerInstance = new CADLayer({ url: serviceUrl, title: name, opacity: 0.9 });
            esriMap.add(cadLayerInstance);
            cadLayerInstance.when(() => {
                clearTimeout(timer);
                zoomToLayer(cadLayerInstance);
                resolve();
            }, (err) => { clearTimeout(timer); reject(err); });
        });
    });
}

function tryFeatureLayer(serviceUrl, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('FeatureLayer 超时 — 请确认服务已公开共享')), 20000);

        require(['esri/layers/FeatureLayer'], (FeatureLayer) => {
            // 尝试加载第一个子图层 (index 0)
            const layer = new FeatureLayer({
                url: serviceUrl + '/0',
                title: name,
                opacity: 0.9
            });
            esriMap.add(layer);
            layer.when(() => {
                clearTimeout(timer);
                cadLayerInstance = layer;
                zoomToLayer(layer);
                resolve();
            }, (err) => { clearTimeout(timer); reject(err); });
        });
    });
}

function zoomToLayer(layer) {
    if (layer.fullExtent) {
        mapView.goTo(layer.fullExtent.expand(1.3)).catch(() => {});
    }
}

function setupCADLayerInput() {
    $('btn-load-cadlayer').addEventListener('click', async () => {
        const url = $('cadlayer-url').value.trim();
        if (!url) return;

        const name = url.split('/').slice(-2, -1)[0] || 'CAD Layer';
        $('btn-load-cadlayer').textContent = '加载中...';
        $('btn-load-cadlayer').disabled = true;

        try {
            await loadCADLayer(url, name);
            dom.modelNameHeader.textContent = name;
            dom.btnExport.disabled  = false;
            dom.btnLoadAll.disabled = false;
            $('btn-load-cadlayer').textContent = '✅ 已加载';
        } catch (err) {
            alert('CADLayer 加载失败: ' + err.message);
            $('btn-load-cadlayer').textContent = '加载';
        } finally {
            $('btn-load-cadlayer').disabled = false;
        }
    });

    $('cadlayer-url').addEventListener('keydown', e => {
        if (e.key === 'Enter') $('btn-load-cadlayer').click();
    });
}

// ===== 地图标记 =====

function placeMarker(lat, lon) {
    if (!mapView || !markerLayer) return;
    require(['esri/Graphic','esri/geometry/Point'], (Graphic, Point) => {
        markerLayer.removeAll();
        const pt = new Point({ longitude: lon, latitude: lat });
        markerLayer.add(new Graphic({
            geometry: pt,
            symbol: {
                type: 'simple-marker',
                color: [255, 80, 80],
                outline: { color: [255,255,255], width: 2 },
                size: 14
            }
        }));
        mapView.goTo({ center: [lon, lat], zoom: 16 });
    });
}

function setupMapClick() {
    mapView.on('click', async (event) => {
        const pt = event.mapPoint;

        // 优先检查是否点击到 CADLayer 要素
        if (cadLayerInstance) {
            try {
                const hit = await mapView.hitTest(event, { include: [cadLayerInstance] });
                const results = hit.results.filter(r => r.graphic?.attributes);
                if (results.length > 0) {
                    displayCADFeature(results[0].graphic, pt);
                    selectedData = { mapPoint: pt, graphic: results[0].graphic };
                    dom.btnCopy.disabled = false;
                    return;
                }
            } catch(e) {}
        }

        // 点击空白区域 → 显示经纬度
        dom.coordPanel.innerHTML = `
            <div class="coord-header">
                <div class="coord-name">地图点击位置</div>
                <div class="coord-meta">WGS 84 / NZGD2000</div>
            </div>
            <table class="coord-table">
                <thead><tr><th>属性</th><th>值</th></tr></thead>
                <tbody>
                    <tr class="primary"><td>经度 (Lon)</td><td>${pt.longitude.toFixed(7)}</td></tr>
                    <tr class="primary"><td>纬度 (Lat)</td><td>${pt.latitude.toFixed(7)}</td></tr>
                    <tr><td>Mercator X</td><td>${pt.x.toFixed(2)}</td></tr>
                    <tr><td>Mercator Y</td><td>${pt.y.toFixed(2)}</td></tr>
                </tbody>
            </table>`;
        selectedData = { mapPoint: pt };
        dom.btnCopy.disabled = false;
    });
}

function displayCADFeature(graphic, mapPoint) {
    const attrs = graphic.attributes || {};
    const geom  = graphic.geometry;
    let coordRows = '';

    if (geom?.type === 'point') {
        coordRows = `
            <tr class="primary"><td>经度 (X)</td><td>${geom.longitude?.toFixed(7) ?? geom.x?.toFixed(3)}</td></tr>
            <tr class="primary"><td>纬度 (Y)</td><td>${geom.latitude?.toFixed(7) ?? geom.y?.toFixed(3)}</td></tr>`;
    } else if (geom?.type === 'polyline') {
        const pts = geom.paths?.[0] || [];
        if (pts.length) coordRows = `
            <tr><td colspan="2" class="coord-group">起点</td></tr>
            <tr class="primary"><td>X</td><td>${pts[0][0].toFixed(6)}</td></tr>
            <tr class="primary"><td>Y</td><td>${pts[0][1].toFixed(6)}</td></tr>
            <tr><td>节点数</td><td>${pts.length}</td></tr>`;
    }

    const attrRows = Object.entries(attrs)
        .filter(([,v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 15)
        .map(([k,v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`)
        .join('');

    dom.coordPanel.innerHTML = `
        <div class="coord-header">
            <div class="coord-name">${escHtml(attrs.Layer || attrs.NAME || attrs.Name || '要素')}</div>
            <div class="coord-meta">${geom?.type || ''} · 点击坐标: ${mapPoint.longitude.toFixed(5)}, ${mapPoint.latitude.toFixed(5)}</div>
        </div>
        <table class="coord-table">
            <thead><tr><th>属性</th><th>值</th></tr></thead>
            <tbody>
                ${coordRows}
                ${attrRows ? `<tr><td colspan="2" class="coord-group">属性</td></tr>${attrRows}` : ''}
            </tbody>
        </table>`;
}

// ===== 地理坐标设置 =====

function setupGeoInput() {
    $('btn-edit-geo').addEventListener('click', () => {
        const area = $('geo-input-area');
        area.classList.toggle('hidden');
        if (!area.classList.contains('hidden') && projectGeo) {
            $('geo-lat').value = projectGeo.latitude;
            $('geo-lng').value = projectGeo.longitude;
        }
    });

    $('btn-geo-cancel').addEventListener('click', () => $('geo-input-area').classList.add('hidden'));

    $('btn-geo-save').addEventListener('click', () => {
        const lat = parseFloat($('geo-lat').value);
        const lon = parseFloat($('geo-lng').value);
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            $('geo-lat').style.borderColor = 'var(--error)';
            $('geo-lng').style.borderColor = 'var(--error)';
            return;
        }
        projectGeo = { latitude: lat, longitude: lon };
        if (currentUrn) {
            try { localStorage.setItem('geo_' + currentUrn, JSON.stringify(projectGeo)); } catch(e) {}
        }
        $('geo-display').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        $('geo-input-area').classList.add('hidden');
        if (arcgisInitialized) placeMarker(lat, lon);
        else if (activeTab === 'map') initArcGISMap();
    });
}

// ===== APS 文件上传 =====

function setupUpload() {
    dom.btnChoose.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
        e.target.value = '';
    });
    dom.uploadZone.addEventListener('dragover', e => { e.preventDefault(); dom.uploadZone.classList.add('dragover'); });
    dom.uploadZone.addEventListener('dragleave', () => dom.uploadZone.classList.remove('dragover'));
    dom.uploadZone.addEventListener('drop', e => {
        e.preventDefault(); dom.uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
}

async function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['dwg','rvt','nwd'].includes(ext)) { alert(`不支持 .${ext}，仅支持 DWG / RVT / NWD`); return; }

    const itemId = Date.now().toString();
    addModelItem(itemId, file.name, 's-pending', '⏳ 上传中...');
    setProgress(5, `上传: ${file.name}`);

    try {
        const form = new FormData();
        form.append('model', file);
        const r = await fetch('/api/upload', { method: 'POST', body: form });
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || '上传失败'); }
        const { urn, fileName } = await r.json();

        setProgress(20, '翻译中...');
        updateModelItem(itemId, '⚙️ 翻译中...', 's-pending');
        await pollTranslation(urn, pct => setProgress(20 + pct * 0.65, `翻译: ${pct}%`));

        setProgress(90, '加载模型...');
        updateModelItem(itemId, '⏳ 加载中...', 's-pending');

        // 切换到 3D 视图
        if (activeTab !== '3d') switchTab('3d');
        await loadModel(urn);

        // 尝试读取已保存的地理坐标
        try {
            const saved = localStorage.getItem('geo_' + urn);
            if (saved) { projectGeo = JSON.parse(saved); updateGeoDisplay(); }
        } catch(e) {}

        setProgress(100, '加载成功！');
        updateModelItem(itemId, '✅ 已加载', 's-success', urn, fileName);
        dom.modelNameHeader.textContent = fileName;
        setTimeout(() => dom.uploadProgress.classList.add('hidden'), 2500);

    } catch(err) {
        setProgress(0, `错误: ${err.message}`);
        updateModelItem(itemId, '❌ 失败', 's-error');
        setTimeout(() => dom.uploadProgress.classList.add('hidden'), 6000);
    }
}

async function pollTranslation(urn, onProgress) {
    for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const r = await fetch(`/api/status/${urn}`);
        const m = await r.json();
        if (m.status === 'success') { onProgress(100); return; }
        if (m.status === 'failed') throw new Error(m.derivatives?.[0]?.messages?.[0]?.message || '翻译失败');
        const pct = parseInt(m.derivatives?.[0]?.progress) || 0;
        onProgress(Math.min(pct, 99));
    }
    throw new Error('翻译超时');
}

// ===== 全部坐标 =====

async function loadAllCoordinates() {
    if (!currentUrn) return;
    dom.btnLoadAll.disabled = true;
    dom.btnLoadAll.textContent = '读取中...';
    dom.allCoordsPanel.innerHTML = '<div class="all-coords-hint">正在获取属性...</div>';

    try {
        const metaR = await fetch(`/api/metadata/${currentUrn}`);
        const meta  = await metaR.json();
        const guid  = meta.data?.metadata?.[0]?.guid;
        if (!guid) throw new Error('未找到模型元数据');

        const propsR = await fetch(`/api/properties/${currentUrn}/${guid}`);
        const pd     = await propsR.json();
        const objs   = pd.data?.collection || [];

        const rows = objs.filter(o => o.name).map(o => {
            let x='-', y='-', z='-';
            for (const cat of Object.values(o.properties||{})) {
                for (const [k,v] of Object.entries(cat)) {
                    if (/\bx\b/i.test(k) && x==='-') x=v;
                    if (/\by\b/i.test(k) && y==='-') y=v;
                    if (/\b(z|elevation)\b/i.test(k) && z==='-') z=v;
                }
            }
            return { id: o.objectid, name: o.name, x, y, z };
        });

        allCoordsCache = rows;
        if (!rows.length) { dom.allCoordsPanel.innerHTML = '<div class="all-coords-hint">未找到坐标</div>'; return; }

        let html = `<div class="all-coords-count">${rows.length} 个构件</div>
            <div class="all-table-wrap"><table class="all-coords-table">
            <thead><tr><th>ID</th><th>名称</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>`;
        rows.slice(0,200).forEach(r => {
            const f = v => typeof v==='number' ? v.toFixed(3) : String(v).slice(0,12);
            html += `<tr><td>${r.id}</td><td title="${escHtml(r.name)}">${escHtml(r.name)}</td>
                <td>${f(r.x)}</td><td>${f(r.y)}</td><td>${f(r.z)}</td></tr>`;
        });
        if (rows.length > 200) html += `<tr><td colspan="5" class="more-hint">…还有 ${rows.length-200} 个</td></tr>`;
        html += '</tbody></table></div>';
        dom.allCoordsPanel.innerHTML = html;

    } catch(err) {
        dom.allCoordsPanel.innerHTML = `<div class="all-coords-hint" style="color:var(--error)">读取失败: ${escHtml(err.message)}</div>`;
    } finally {
        dom.btnLoadAll.disabled = false;
        dom.btnLoadAll.textContent = '重新读取';
    }
}

// ===== 导出 CSV =====

async function exportCSV() {
    let rows = allCoordsCache;
    if (!rows) { await loadAllCoordinates(); rows = allCoordsCache; }
    if (!rows?.length) { alert('没有可导出的坐标数据'); return; }
    const lines = ['元素ID,名称,X,Y,Z', ...rows.map(r => `${r.id},"${r.name}",${r.x},${r.y},${r.z}`)];
    const blob = new Blob(['﻿'+lines.join('\r\n')], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `coords_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
}

// ===== 复制坐标 =====

function copyCoords() {
    if (!selectedData) return;
    let text;
    if (selectedData.mapPoint) {
        const p = selectedData.mapPoint;
        text = `经度: ${p.longitude.toFixed(7)}\n纬度: ${p.latitude.toFixed(7)}`;
    } else {
        const { props, bbox } = selectedData;
        const c = bbox?.center;
        text = [`构件: ${props.name}`,
            c ? `中心坐标: X=${c.x.toFixed(4)}, Y=${c.y.toFixed(4)}, Z=${c.z.toFixed(4)}` : null
        ].filter(Boolean).join('\n');
    }
    navigator.clipboard.writeText(text).then(() => {
        const orig = dom.btnCopy.innerHTML;
        dom.btnCopy.innerHTML = '✓';
        setTimeout(() => dom.btnCopy.innerHTML = orig, 1500);
    });
}

// ===== 模型列表 =====

function addModelItem(id, name, statusClass, statusText) {
    const empty = dom.modelsList.querySelector('.models-empty');
    if (empty) empty.remove();
    const icons = {dwg:'📐', rvt:'🏗️', nwd:'🔩'};
    const icon = icons[name.split('.').pop().toLowerCase()] || '📄';
    const el = document.createElement('div');
    el.className = 'model-item'; el.dataset.modelId = id;
    el.innerHTML = `<span class="model-item-icon">${icon}</span>
        <div class="model-item-info">
            <div class="model-item-name" title="${escHtml(name)}">${escHtml(name)}</div>
            <div class="model-item-status ${statusClass}">${statusText}</div>
        </div>`;
    dom.modelsList.prepend(el);
}

function updateModelItem(id, statusText, statusClass, urn, fileName) {
    const el = dom.modelsList.querySelector(`[data-model-id="${id}"]`);
    if (!el) return;
    const s = el.querySelector('.model-item-status');
    s.textContent = statusText; s.className = `model-item-status ${statusClass}`;
    if (urn) {
        el.dataset.urn = urn; el.classList.add('active');
        el.addEventListener('click', () => {
            document.querySelectorAll('.model-item').forEach(e => e.classList.remove('active'));
            el.classList.add('active');
            if (activeTab !== '3d') switchTab('3d');
            loadModel(urn);
            if (fileName) dom.modelNameHeader.textContent = fileName;
        });
    }
}

function updateGeoDisplay() {
    if (projectGeo) {
        $('geo-display').textContent = `${projectGeo.latitude.toFixed(5)}, ${projectGeo.longitude.toFixed(5)}`;
    }
}

// ===== 进度条 =====

function setProgress(pct, text) {
    dom.uploadProgress.classList.remove('hidden');
    dom.progressFill.style.width = `${pct}%`;
    dom.progressText.textContent = text;
    dom.progressPct.textContent  = `${Math.round(pct)}%`;
}

// ===== 工具 =====

const sleep = ms => new Promise(r => setTimeout(r, ms));
function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== 启动 =====

document.addEventListener('DOMContentLoaded', async () => {
    dom.btnCopy.addEventListener('click', copyCoords);
    dom.btnExport.addEventListener('click', exportCSV);
    dom.btnLoadAll.addEventListener('click', loadAllCoordinates);

    $('tab-3d').addEventListener('click',  () => switchTab('3d'));
    $('tab-map').addEventListener('click', () => switchTab('map'));

    setupUpload();
    setupGeoInput();
    setupCADLayerInput();

    // 初始化 APS Viewer
    try {
        await initViewer();
    } catch(err) {
        console.error('Viewer error:', err);
        $('viewer').innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;color:#888;gap:8px">
            <div style="font-size:36px">⚠️</div>
            <div>APS Viewer 初始化失败</div>
            <div style="font-size:11px">${err.message}</div></div>`;
    }
});
