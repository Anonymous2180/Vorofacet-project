import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { PLYLoader } from './vendor/three/PLYLoader.js';
import { ModelCache } from './model-cache.js';
import { PersistentModelCache, verifyChunk } from './persistent-model-cache.js';
import { DownloadProgress, formatSpeed, formatRemaining } from './download-progress.js';

// All methods keep their source world coordinates. Only the shared camera moves.
const root = document.querySelector('#interactive-3d');
const $ = selector => root.querySelector(selector);
const caseSelect = $('#model-case');
const loadButton = $('#load-models');
const status = $('#viewer-status');
const currentLabel = $('#viewer-current');
currentLabel.textContent = '';
const controlsToEnable = [...root.querySelectorAll('[data-viewer-control]')];
const paneElements = [...root.querySelectorAll('.mesh-pane')];
const roles = paneElements.map((_, index) => 'pane-' + index);
const methodSelects = paneElements.map(element => element.querySelector('[data-pane-method]'));
let selectedMethodIds = [];
const panes = [];
const loader = new PLYLoader();
const modelCache = new ModelCache((navigator.deviceMemory && navigator.deviceMemory <= 4 ? 64 : 160) * 1048576);
const loadingStats = {downloads:0, decodes:0, workerDecodes:0};
let transferTimer, currentTransfer;
const persistentCache = new PersistentModelCache(info => {
  const note = $('#viewer-cache-note');
  if (!note) return;
  if (info.state === 'unavailable') note.textContent = 'Browser storage is unavailable. Models still load normally, but may need downloading again next visit.';
  else if (info.state === 'quota' || info.state === 'full') note.textContent = 'Browser cache is full. Previously saved models remain available; new models load without being saved.';
  else note.textContent = info.pending ? 'Saving original model data for your next visit…' : 'Original model data is cached in this browser for later visits when space permits. Private browsing or clearing site data may remove it.';
});
const modelKey = method => method.sha256;
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
let catalog, modelBase, activeCase, bounds, defaultCamera;
let busy = false, generation = 0, aborter, synchronizing = false, framePending = false;
let visible = true, renderAllowed = true;
let expandedPreviousFocus;
const viewClip = {near:0, far:100};
const renderStats = {frames:0, picks:0, lastPickMs:0, pickMode:null};
const depthDirection = new THREE.Vector3();
let depthCorners = [], clipModifierDown = false;
const READY_HINT = 'Drag to rotate · Ctrl + drag to pan · Shift + drag to zoom';
const navigation = {rotate:0.35, referenceHeight:400, minOrbitScale:0.12, pan:0.65, zoom:0.55, zoomStep:0.9};

function message(text, state) {
  status.textContent = text;
  if (state) root.dataset.state = state;
}
function formatBytes(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
function selectedCase() { return catalog?.cases.find(item => item.id === caseSelect.value); }
function selectedMethods(item = selectedCase()) {
  return item ? selectedMethodIds.map(id => item.methods[id]) : [];
}
function canReuseMeshes(item) {
  return activeCase?.id === item?.id && panes.length === paneElements.length && panes.every(pane => pane.mesh);
}
function changedPaneIndices(item = selectedCase()) {
  const reusable = canReuseMeshes(item);
  return selectedMethodIds.map((id, index) => index).filter(index => !reusable || panes[index].methodId !== selectedMethodIds[index]);
}
function refreshMethodOptions() {
  methodSelects.forEach((select, index) => {
    for (const option of select.options) {
      option.disabled = false;
      option.textContent = selectedCase().methods[option.value].label;
    }
    select.value = selectedMethodIds[index];
  });
}
function clearPaneProgress() {
  for (const element of paneElements) {
    element.classList.remove('is-loading', 'is-error');
    element.setAttribute('aria-busy', 'false');
    element.querySelector('.mesh-pane-status').textContent = '';
  }
}
function updateSelection() {
  const item = selectedCase();
  if (!item || selectedMethodIds.length !== paneElements.length) return;
  refreshMethodOptions();
  const changed = changedPaneIndices(item);
  const methods = selectedMethods(item);
  const unique = new Map(changed.map(index => [modelKey(methods[index]), methods[index]]));
  const total = [...unique.values()].reduce((sum, method) => sum + (modelCache.has(modelKey(method)) ? 0 : method.bytes), 0);
  const faces = methods.reduce((sum, method) => sum + method.faces, 0);
  paneElements.forEach((element, index) => {
    const pane = panes[index];
    const pending = Boolean(pane?.mesh && (activeCase?.id !== item.id || pane.methodId !== selectedMethodIds[index]));
    element.classList.toggle('is-pending', pending);
    if (pending && !busy) element.querySelector('.mesh-pane-status').textContent = `Showing ${activeCase.label}; press Load for ${item.label}.`;
  });
  loadButton.textContent = busy ? 'Loading…' : changed.length ? `${canReuseMeshes(item) ? 'Load changes' : 'Load 6 views'} · ${total ? formatBytes(total) : 'cached'}` : '6 views loaded';
  loadButton.disabled = busy || !changed.length;
  const downloadInfo = $('#viewer-download-info');
  downloadInfo.textContent = faces > 2500000 ? 'Large meshes may be slow on mobile.' : '';
  downloadInfo.hidden = faces <= 2500000;
  if (!activeCase) $('#viewer-case-note').textContent = item.note;
  if (!renderAllowed) {
    loadButton.disabled = true;
    message('A 3D view is unavailable. Reload this page to restore all six views.', 'error');
    return;
  }
  if (busy) return;
  if (activeCase && activeCase.id !== item.id) message(`Showing ${activeCase.label}. Press Load to switch model.`, 'ready');
  else if (activeCase) message(READY_HINT, 'ready');
  else message('Choose methods in each view, then press Load.', 'idle');
}
function updateMethodOptions() {
  const item = selectedCase();
  if (!item) return;
  cancelLoad();
  const available = (catalog.methodOrder || Object.keys(item.methods)).filter(id => item.methods[id]);
  // Defaults apply only on first use (or if a method is absent in the new case).
  // Preserve the user's per-view choices, including repeats and staged selections.
  const defaults = [...new Set([item.defaultBaseline, 'meshudf', 'geoudf', 'dualmesh', 'ours', 'gt', ...available].filter(id => item.methods[id]))];
  if (!defaults.length) throw new Error('No methods are available for this model.');
  selectedMethodIds = Array.from({length:paneElements.length}, (_, index) =>
    item.methods[selectedMethodIds[index]] ? selectedMethodIds[index] : defaults[index] || defaults[0]);
  // Manuscript §2 / §5.1 terminology; keep the catalog's legacy `grid` key.
  const familyNames = {grid:'Pseudo-sign methods', dual:'Dual methods', offset:'Offset-based methods', ours:'VoroFacet', reference:'Reference'};
  for (const select of methodSelects) {
    select.replaceChildren();
    const groups = new Map();
    for (const id of available) {
      const method = item.methods[id], family = method.family || 'other';
      if (!groups.has(family)) {
        const group = document.createElement('optgroup');
        group.label = familyNames[family] || 'Other methods';
        groups.set(family, group); select.append(group);
      }
      groups.get(family).append(new Option(method.label, id));
    }
    select.disabled = false;
  }
  updateSelection();
}
function selectPaneMethod(index) {
  const select = methodSelects[index];
  const item = selectedCase(), next = select.value;
  if (!item?.methods[next]) {
    select.value = selectedMethodIds[index];
    return;
  }
  if (selectedMethodIds[index] === next) return;
  const automaticallyLoad = busy || canReuseMeshes(item);
  cancelLoad();
  selectedMethodIds[index] = next;
  updateSelection();
  if (automaticallyLoad) loadSelected();
}

function scheduleRender() {
  if (framePending || !visible || !renderAllowed) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    if (!renderAllowed) return;
    for (const pane of panes) if (pane.visible) pane.renderer.render(pane.scene, pane.camera);
    renderStats.frames++;
  });
}
function syncCameras(source) {
  if (synchronizing) return;
  synchronizing = true;
  for (const pane of panes) {
    if (pane === source) continue;
    pane.camera.position.copy(source.camera.position);
    pane.camera.quaternion.copy(source.camera.quaternion);
    pane.camera.up.copy(source.camera.up);
    pane.camera.zoom = source.camera.zoom;
    pane.controls.target.copy(source.controls.target);
    pane.camera.updateProjectionMatrix();
    pane.controls.update();
  }
  synchronizing = false;
  updateNavigationSensitivity();
  applyViewClip(source.camera);
  scheduleRender();
}
function resize() {
  if (root.classList.contains('viewer-expanded')) {
    const container = root.firstElementChild;
    const grid = $('#mesh-grid');
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 3;
    const rows = Math.ceil(paneElements.length / columns);
    const gridHeight = grid.getBoundingClientRect().height;
    const overhead = container.getBoundingClientRect().height - gridHeight;
    const headerHeight = Math.max(...paneElements.map(element => element.getBoundingClientRect().height - element.querySelector('.mesh-viewport').getBoundingClientRect().height));
    const padding = parseFloat(getComputedStyle(root).paddingTop) + parseFloat(getComputedStyle(root).paddingBottom);
    const gaps = (parseFloat(style.rowGap) || 0) * (rows - 1);
    const minimum = window.innerWidth <= 760 ? 205 : 160;
    const height = Math.max(minimum, Math.floor((window.innerHeight - overhead - padding - gaps - 8) / rows - headerHeight)) + 'px';
    if (root.style.getPropertyValue('--inspection-height') !== height) root.style.setProperty('--inspection-height', height);
  } else root.style.removeProperty('--inspection-height');
  for (const pane of panes) {
    const {width, height} = pane.viewport.getBoundingClientRect();
    pane.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    pane.camera.aspect = Math.max(1, width) / Math.max(1, height);
    pane.camera.updateProjectionMatrix();
  }
  updateNavigationSensitivity();
  scheduleRender();
}

function initRenderers() {
  if (panes.length) return;
  try {
    for (let i = 0; i < paneElements.length; i++) {
      const element = paneElements[i];
      const viewport = element.querySelector('.mesh-viewport');
      const renderer = new THREE.WebGLRenderer({antialias: true, alpha: false, powerPreference: 'default'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0xf7fafb);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.localClippingEnabled = true;
      renderer.domElement.setAttribute('aria-label', roles[i] + ' 3D reconstruction. Left-drag to rotate; Ctrl-left-drag to pan; Shift-left-drag or scroll to zoom; Ctrl-scroll to clip; double-click to focus.');
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.tabIndex = 0;
      viewport.append(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, 1, 0.0001, 10000);
      scene.add(camera);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x64717d, 2.1));
      const key = new THREE.DirectionalLight(0xffffff, 2.3);
      key.position.set(3, 5, 4);
      camera.add(key);
      const fill = new THREE.DirectionalLight(0xc5dfec, 0.7);
      fill.position.set(-4, 0, 2);
      camera.add(fill);
      const controls = new OrbitControls(camera, renderer.domElement);
      const pane = {role: roles[i], paneIndex:i, methodId:null, element, viewport, renderer, scene, camera, controls, mesh:null, overlay:null, visible:true, contextLost:false};
      panes.push(pane);
      configureControls(pane);
      renderer.domElement.addEventListener('wheel', clipWheel, {capture:true, passive:false});
      renderer.domElement.addEventListener('dblclick', event => focusVisibleSurface(event, pane));
      renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
      renderer.domElement.addEventListener('keydown', event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(navigation.zoomStep); }
        if (event.key === '-') { event.preventDefault(); zoom(1 / navigation.zoomStep); }
        if (event.key.toLowerCase() === 'r') { event.preventDefault(); resetCamera(); }
        if (event.key.toLowerCase() === 'c') { event.preventDefault(); clearViewClip(); }
      });
      renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        pane.contextLost = true;
        renderAllowed = false;
        panes.forEach(view => view.controls.cancelInteraction());
        // Invalidate every in-flight continuation before reporting the lost context.
        // A late download must never commit meshes or replace the error with Ready.
        cancelLoad();
        controlsToEnable.forEach(control => control.disabled = true);
        $('#viewer-edge-opacity').disabled = true;
        $('#viewer-cut-axis').disabled = true;
        $('#viewer-cut-position').disabled = true;
        updateSelection();
        message('The browser lost its 3D context. Reload this page to restore it, or use the static comparisons below.', 'error');
      });
      renderer.domElement.addEventListener('webglcontextrestored', () => {
        pane.contextLost = false;
        renderAllowed = !panes.some(item => item.contextLost);
        controlsToEnable.forEach(control => control.disabled = !activeCase || !renderAllowed);
        if (!renderAllowed) {
          message('A 3D view is still unavailable. Reload this page to restore all six views.', 'error');
          return;
        }
        updateOverlay();
        updateClipUI();
        applyViewClip();
        updateSelection();
        if (busy) message('Loading selected views…', 'loading');
        scheduleRender();
      });
    }
    new ResizeObserver(resize).observe($('#mesh-grid'));
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) scheduleRender();
    }, {rootMargin: '200px'}).observe($('#mesh-grid'));
    const paneObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const pane = panes.find(item => item.viewport === entry.target);
        if (pane) pane.visible = entry.isIntersecting;
      }
      scheduleRender();
    }, {rootMargin:'100px'});
    panes.forEach(pane => paneObserver.observe(pane.viewport));
    resize();
  } catch (error) {
    for (const pane of panes) { pane.controls.dispose(); pane.renderer.dispose(); pane.renderer.domElement.remove(); }
    panes.length = 0;
    throw new Error('WebGL is unavailable in this browser. Enable hardware acceleration or use the static comparisons below.');
  }
}

// Fast path avoids millions of temporary JS numbers in the general PLY loader.
// It copies only XYZ and triangle indices, without welding, reordering or centering.
function parseMesh(buffer) {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16384)));
  const match = head.match(/end_header\r?\n/);
  if (!match) throw new Error('Invalid PLY header.');
  const offset = match.index + match[0].length;
  const header = head.slice(0, offset);
  const vertexMatch = header.match(/element vertex (\d+)\r?\n([\s\S]*?)(?=element |end_header)/);
  const faceMatch = header.match(/element face (\d+)\r?\n([\s\S]*?)(?=element |end_header)/);
  const vertexProperties = vertexMatch?.[2].trim().split(/\r?\n/).filter(line => !line.startsWith('comment'));
  const simple = /format binary_little_endian 1.0/.test(header) && vertexProperties?.length === 3 &&
    vertexProperties.every((line, i) => new RegExp('^property (float|float32) ' + ['x','y','z'][i] + '$').test(line)) &&
    /^property list (uchar|uint8) (int|uint|int32|uint32) vertex_indices\s*$/.test(faceMatch?.[2].trim() || '');
  if (!simple) {
    const geometry = loader.parse(buffer);
    if (!geometry.getAttribute('position') || !geometry.index) throw new Error('Expected an indexed triangle mesh.');
    return geometry;
  }
  const vertices = Number(vertexMatch[1]);
  const faces = Number(faceMatch[1]);
  const faceOffset = offset + vertices * 12;
  if (faceOffset + faces * 13 !== buffer.byteLength) throw new Error('Unexpected binary PLY data length.');
  const positions = new Float32Array(buffer.slice(offset, faceOffset));
  const indices = new Uint32Array(faces * 3);
  const view = new DataView(buffer);
  for (let face = 0; face < faces; face++) {
    const cursor = faceOffset + face * 13;
    if (view.getUint8(cursor) !== 3) throw new Error('Only triangular faces are supported.');
    for (let corner = 0; corner < 3; corner++) {
      const index = view.getUint32(cursor + 1 + corner * 4, true);
      if (index >= vertices) throw new Error('Invalid triangle index.');
      indices[face * 3 + corner] = index;
    }
  }
  if (positions.some(value => !Number.isFinite(value))) throw new Error('Non-finite vertex coordinates.');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

async function fetchBytes(file, signal, progress) {
  if (!/^blobs\/[a-f0-9]{64}\.ply\.gz$/.test(file)) throw new Error('Invalid model resource path.');
  const url = new URL(file, modelBase).href;
  const cached = await persistentCache.get(url, signal);
  if (signal.aborted) throw abortError();
  if (cached) { progress(cached.byteLength, true); return cached; }
  loadingStats.downloads++;
  const response = await fetch(url, {signal, credentials:'omit', mode:'same-origin', redirect:'error'});
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}).`);
  let result;
  if (!response.body) {
    result = new Uint8Array(await response.arrayBuffer()); progress(result.byteLength);
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength; progress(value.byteLength);
      if (size > 7000000) { await reader.cancel(); throw new Error('Model chunk exceeds the verified export limit.'); }
    }
    result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  }
  if (signal.aborted) throw abortError();
  if (!(await verifyChunk(result, url))) throw new Error('Model data verification failed. Please retry the download.');
  if (signal.aborted) throw abortError();
  persistentCache.save(url, result);
  return result;
}

function abortError() { return new DOMException('Cancelled', 'AbortError'); }
// Share a request cap across methods and split chunks. A large multi-part mesh
// cannot saturate the connection or launch an unbounded set of decoders.
function requestQueue(signal, limit = 3) {
  let active = 0;
  const waiting = [];
  const runNext = () => {
    while (active < limit && waiting.length) {
      const {task, resolve, reject} = waiting.shift();
      if (signal.aborted) { reject(abortError()); continue; }
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; runNext(); });
    }
  };
  signal.addEventListener('abort', runNext, {once:true});
  return task => new Promise((resolve, reject) => { waiting.push({task, resolve, reject}); runNext(); });
}
async function decodeGeometry(chunks, method, signal) {
  loadingStats.decodes++;
  if (window.Worker && window.DecompressionStream) {
    let worker;
    try { worker = new Worker(new URL('./mesh-worker.js', import.meta.url)); } catch (_) { /* CSP / older browser: validated fallback below. */ }
    if (worker) {
      loadingStats.workerDecodes++;
      return new Promise((resolve, reject) => {
        const finish = (error, geometry) => {
          signal.removeEventListener('abort', cancel);
          worker.terminate();
          if (error) reject(error); else resolve(geometry);
        };
        const cancel = () => finish(abortError());
        signal.addEventListener('abort', cancel, {once:true});
        worker.onerror = () => finish(new Error('Model decoder could not start. Reload the page and retry.'));
        worker.onmessage = ({data}) => {
          if (signal.aborted) { finish(abortError()); return; }
          if (data.error) { finish(new Error(data.error)); return; }
          try {
            const geometry = data.buffer ? parseMesh(data.buffer) : new THREE.BufferGeometry();
            if (!data.buffer) {
              geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
              geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            }
            finish(null, geometry);
          } catch (error) { finish(error); }
        };
        if (signal.aborted) { cancel(); return; }
        worker.postMessage({chunks, method}, chunks.map(chunk => chunk.buffer));
      });
    }
  }
  const blob = new Blob(chunks);
  let buffer;
  if (method.encoding === 'gzip' && chunks[0][0] === 0x1f && chunks[0][1] === 0x8b) {
    if (!window.DecompressionStream) throw new Error('This browser cannot decode compressed models. Please use a current Chrome, Edge, Firefox or Safari.');
    buffer = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  } else buffer = await blob.arrayBuffer();
  if (method.uncompressedBytes && buffer.byteLength !== method.uncompressedBytes) throw new Error('Model data length does not match the verified export.');
  if (signal.aborted) throw abortError();
  return parseMesh(buffer);
}
async function loadGeometry(method, signal, progress, request) {
  const files = method.parts || [method.file];
  const chunks = await Promise.all(files.map(file => request(() => fetchBytes(file, signal, progress))));
  if (signal.aborted) throw abortError();
  const geometry = await decodeGeometry(chunks, method, signal);
  if (signal.aborted) { geometry.dispose(); throw abortError(); }
  if (geometry.getAttribute('position').count !== method.vertices || geometry.index.count / 3 !== method.faces) {
    geometry.dispose();
    throw new Error('Mesh counts do not match the verified export.');
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function cancelLoad() {
  clearInterval(transferTimer); transferTimer = null;
  generation++;
  aborter?.abort();
  busy = false;
  loadButton.disabled = false;
  root.classList.remove('is-loading');
  clearPaneProgress();
}
function replacePaneMesh(pane, geometry, methodId, method, item) {
  if (pane.overlay) { pane.scene.remove(pane.overlay); pane.overlay.material.dispose(); }
  const nextKey = modelKey(method);
  modelCache.acquire(nextKey); // Pin the new pane before releasing its previous entry.
  if (pane.mesh) { pane.scene.remove(pane.mesh); modelCache.release(pane.cacheKey); pane.mesh.material.dispose(); }
  pane.cacheKey = nextKey;
  const material = new THREE.MeshPhongMaterial({color:0x91aeb8, specular:0x465963, shininess:28, side:THREE.DoubleSide, flatShading:true, wireframe:false, polygonOffsetFactor:1, polygonOffsetUnits:1});
  pane.mesh = new THREE.Mesh(geometry, material);
  if (pane.pickMesh) pane.pickMesh.geometry = geometry;
  pane.mesh.frustumCulled = false;
  pane.scene.add(pane.mesh);
  // Original triangle edges overlay an always-filled surface, sharing its buffers.
  pane.overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({color:0x294854, wireframe:true, side:THREE.DoubleSide, transparent:true, opacity:0.18, depthTest:true, depthWrite:false, toneMapped:false, forceSinglePass:true}));
  pane.overlay.frustumCulled = false;
  pane.overlay.renderOrder = 1;
  pane.overlay.visible = false;
  pane.scene.add(pane.overlay);
  pane.methodId = methodId;
  pane.element.dataset.method = methodId;
  pane.element.dataset.caseId = item.id;
  pane.element.querySelector('.mesh-method-name').textContent = method.label;
  pane.element.querySelector('.ours-badge').hidden = methodId !== 'ours';
  pane.renderer.domElement.setAttribute('aria-label', `${method.label} · ${item.label}. Left-drag to rotate; Ctrl-left-drag to pan; Shift-left-drag or scroll to zoom; Ctrl-scroll to clip; double-click to focus.`);
  $(`[data-mesh-summary="${pane.role}"]`).textContent = `View ${pane.paneIndex + 1} · ${method.label}: ${method.vertices.toLocaleString('en-US')} vertices · ${method.faces.toLocaleString('en-US')} triangles`;
  pane.element.querySelector('.mesh-empty').hidden = true;
}
async function loadSelected() {
  const item = selectedCase();
  if (!item || !renderAllowed) return;
  if (selectedMethodIds.length !== paneElements.length || selectedMethodIds.some(id => !item.methods[id])) {
    message('Choose a valid method for each view.', 'error');
    return;
  }
  cancelLoad();
  const token = generation;
  aborter = new AbortController();
  const signal = aborter.signal;
  const requestedIds = [...selectedMethodIds];
  const methods = requestedIds.map(id => item.methods[id]);
  const reuseMeshes = canReuseMeshes(item);
  const loadIndices = changedPaneIndices(item);
  if (!loadIndices.length) { updateSelection(); return; }
  const unique = new Map(loadIndices.map(index => [modelKey(methods[index]), methods[index]]));
  const total = [...unique.values()].reduce((sum, method) => sum + (modelCache.has(modelKey(method)) ? 0 : method.bytes), 0);
  const transfer = new DownloadProgress(total);
  currentTransfer = transfer;
  const pending = new Map();
  const controller = aborter;
  const jobs = [];
  const request = requestQueue(signal);
  busy = true;
  root.classList.toggle('is-loading', !reuseMeshes);
  for (const index of loadIndices) {
    const element = paneElements[index];
    element.classList.add('is-loading'); element.setAttribute('aria-busy', 'true');
    element.querySelector('.mesh-pane-status').textContent = `Loading ${methods[index].label}…`;
  }
  updateSelection();
  const updateTransfer = () => {
    if (token !== generation || !busy || !renderAllowed) return;
    const info = transfer.snapshot();
    if (!info.remaining) {
      message(info.cachedBytes && !info.networkBytes ? 'Preparing views from browser cache…' : 'Preparing views…', 'loading');
      return;
    }
    const prefix = `Loading ${loadIndices.length} ${loadIndices.length === 1 ? 'view' : 'views'} · ${formatBytes(info.received)} / ${formatBytes(total)}`;
    const estimate = info.stalled ? 'Waiting for data · 0 KB/s · time unknown' :
      info.estimating ? 'Estimating speed / time…' : `${formatSpeed(info.speed)} · ${info.seconds === null ? 'time unknown' : '~' + formatRemaining(info.seconds) + ' download left'}`;
    message(prefix + ' · ' + estimate + (info.cachedBytes ? ` · ${formatBytes(info.cachedBytes)} cached` : ''), 'loading');
  };
  updateTransfer();
  transferTimer = setInterval(updateTransfer, 500);
  try {
    initRenderers();
    const progress = (increment, cached = false) => {
      transfer.add(increment, cached);
    };
    // Decode each unique mesh once, at most three methods at a time. Cache hits
    // need no download or parsing. Hold transaction pins until every pane commits.
    const queue = [...unique.entries()];
    for (let worker = 0; worker < Math.min(3, queue.length); worker++) {
      jobs.push((async () => {
        while (queue.length) {
          if (signal.aborted || token !== generation) throw abortError();
          const [key, method] = queue.shift();
          let geometry = modelCache.acquire(key);
          if (!geometry) {
            geometry = await loadGeometry(method, signal, progress, request);
            if (signal.aborted || token !== generation) { geometry.dispose(); throw abortError(); }
            geometry = modelCache.insert(key, geometry);
          }
          pending.set(key, geometry);
          for (const index of loadIndices) if (modelKey(methods[index]) === key) {
            paneElements[index].querySelector('.mesh-pane-status').textContent = 'Ready';
          }
        }
      })());
    }
    await Promise.all(jobs);
    if (token !== generation) throw abortError();
    if (!renderAllowed) throw new Error('The browser lost its 3D context. Reload to restore the views.');
    for (const index of loadIndices) replacePaneMesh(panes[index], pending.get(modelKey(methods[index])), requestedIds[index], methods[index], item);
    activeCase = item;
    $('#viewer-case-note').textContent = item.note;
    bounds = new THREE.Box3(new THREE.Vector3(...item.bounds[0]), new THREE.Vector3(...item.bounds[1]));
    depthCorners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) depthCorners.push(new THREE.Vector3(x,y,z));
    controlsToEnable.forEach(control => control.disabled = false);
    if (!reuseMeshes) {
      $('#viewer-cut').checked = false;
      $('#viewer-cut-axis').value = 'z';
      $('#viewer-cut-position').value = '50';
    }
    updateOverlay(); updateClipUI();
    if (!reuseMeshes) fitCamera();
    currentLabel.textContent = `Viewing: ${item.label} · 6 synchronized views`;
    root.dataset.loadedCase = item.id;
    busy = false;
    clearPaneProgress();
    updateSelection();
    message((transfer.cachedBytes && !transfer.networkBytes ? 'Loaded from browser cache · ' : '') + READY_HINT, 'ready');
  } catch (error) {
    controller.abort();
    await Promise.allSettled(jobs);
    if (token !== generation) return;
    if (error.name !== 'AbortError') {
      aborter.abort(); busy = false; clearPaneProgress();
      // Revert a failed same-case change so selector labels always match visible meshes.
      if (reuseMeshes) selectedMethodIds = panes.map(pane => pane.methodId);
      updateSelection();
      for (const index of loadIndices) {
        const element = paneElements[index]; element.classList.add('is-error');
        element.querySelector('.mesh-pane-status').textContent = reuseMeshes ? 'Load failed; previous model kept.' : 'Load failed; retry.';
      }
      message(error.message + (reuseMeshes ? ' Previous views were kept; select the method again to retry.' : ' Press Load to retry.'), 'error');
    }
  } finally {
    for (const key of pending.keys()) modelCache.release(key);
    if (token === generation) {
      clearInterval(transferTimer); transferTimer = null;
      busy = false;
      root.classList.remove('is-loading');
      paneElements.forEach(element => { element.classList.remove('is-loading'); element.setAttribute('aria-busy', 'false'); });
      loadButton.disabled = !renderAllowed || !changedPaneIndices(item).length;
      scheduleRender();
    }
  }
}

function fitCamera() {
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1e-5);
  resize();
  const aspect = Math.min(...panes.map(pane => pane.camera.aspect));
  const vertical = THREE.MathUtils.degToRad(panes[0].camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.08;
  const direction = new THREE.Vector3(...(activeCase.view || [1,0.7,1])).normalize();
  const up = new THREE.Vector3(...(activeCase.up || [0,1,0])).normalize();
  defaultCamera = {position:center.clone().addScaledVector(direction, distance), target:center, up, radius};
  for (const pane of panes) {
    // OrbitControls r160 caches the up-axis basis when constructed. Recreate it
    // after changing cases instead of rotating the scientific mesh coordinates.
    pane.controls.dispose();
    pane.camera.up.copy(up);
    pane.controls = new OrbitControls(pane.camera, pane.renderer.domElement);
    configureControls(pane);
    pane.controls.minDistance = radius * 0.015;
    pane.controls.maxDistance = radius * 100;
    pane.camera.updateProjectionMatrix();
  }
  resetCamera();
}
function resetCamera() {
  if (!defaultCamera) return;
  viewClip.near = 0; viewClip.far = 100;
  // Refit the same default direction after a responsive layout change.
  const halfFov = THREE.MathUtils.degToRad(panes[0].camera.fov / 2);
  const aspect = Math.min(...panes.map(pane => pane.camera.aspect));
  const distance = defaultCamera.radius / Math.sin(Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect))) * 1.08;
  defaultCamera.position.sub(defaultCamera.target).normalize().multiplyScalar(distance).add(defaultCamera.target);
  synchronizing = true;
  for (const pane of panes) {
    pane.camera.position.copy(defaultCamera.position);
    pane.camera.up.copy(defaultCamera.up);
    pane.camera.zoom = 1;
    pane.controls.target.copy(defaultCamera.target);
    pane.camera.lookAt(defaultCamera.target);
    pane.camera.updateProjectionMatrix();
    pane.controls.update();
  }
  synchronizing = false;
  updateNavigationSensitivity();
  applyViewClip();
  updateViewClipUI();
  scheduleRender();
}
function zoom(factor) {
  if (!activeCase) return;
  const pane = panes[0];
  const offset = pane.camera.position.clone().sub(pane.controls.target);
  offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, pane.controls.minDistance, pane.controls.maxDistance));
  pane.camera.position.copy(pane.controls.target).add(offset);
  pane.controls.update();
  syncCameras(pane);
}
function configureControls(pane) {
  const controls = pane.controls;
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = navigation.rotate;
  controls.panSpeed = navigation.pan;
  controls.zoomSpeed = navigation.zoom;
  controls.zoomToCursor = true;
  controls.meshLabMouseMapping = true;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.addEventListener('change', () => syncCameras(pane));
}
function updateNavigationSensitivity() {
  const fitDistance = defaultCamera?.position.distanceTo(defaultCamera.target) || 0;
  for (const pane of panes) {
    const distance = pane.camera.position.distanceTo(pane.controls.target);
    const closeUp = fitDistance ? THREE.MathUtils.clamp(distance / fitDistance, navigation.minOrbitScale, 1) : 1;
    // OrbitControls divides drag pixels by canvas height. Compensate so a short
    // comparison pane is not faster, and reduce the angle during close inspection.
    pane.controls.rotateSpeed = navigation.rotate * Math.max(1, pane.renderer.domElement.clientHeight) / navigation.referenceHeight * closeUp;
  }
}
function updateViewClipUI() {
  for (const key of ['near', 'far']) {
    $('#viewer-' + key + '-clip').value = String(viewClip[key]);
    $('#viewer-' + key + '-value').value = Number(viewClip[key].toFixed(1)) + '%';
  }
}
function applyViewClip(camera = panes[0]?.camera) {
  if (!camera || !bounds || !depthCorners.length) return;
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1e-5);
  camera.getWorldDirection(depthDirection);
  const eye = camera.position.dot(depthDirection);
  let front = Infinity, back = -Infinity;
  for (const point of depthCorners) {
    const depth = point.dot(depthDirection) - eye;
    front = Math.min(front, depth); back = Math.max(back, depth);
  }
  // Tight, padded camera-depth bounds keep the depth buffer precise and make the
  // first wheel step useful even when the model is tiny or far from the camera.
  front = Math.max(radius * 0.0001, front - radius * 0.01);
  back = Math.max(front + radius * 0.02, back + radius * 0.01);
  const near = THREE.MathUtils.lerp(front, back, viewClip.near / 100);
  const far = THREE.MathUtils.lerp(front, back, viewClip.far / 100);
  for (const pane of panes) {
    pane.camera.near = near; pane.camera.far = far;
    pane.camera.updateProjectionMatrix();
  }
}
function setViewClip(key, value) {
  if (!activeCase || !renderAllowed) return;
  viewClip[key] = key === 'near' ? THREE.MathUtils.clamp(value, 0, viewClip.far - 0.5) : THREE.MathUtils.clamp(value, viewClip.near + 0.5, 100);
  applyViewClip(); updateViewClipUI(); scheduleRender();
}
function clearViewClip() {
  viewClip.near = 0; viewClip.far = 100;
  applyViewClip(); updateViewClipUI(); scheduleRender();
}
function clipWheel(event) {
  // Trackpad pinch also emits ctrlKey wheel events in Chromium. Only a real
  // held modifier is a clip gesture; ordinary pinch remains OrbitControls zoom.
  if (!(event.ctrlKey || event.metaKey) || !clipModifierDown || !activeCase || !renderAllowed) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  // One wheel event is one predictable percentage-point step on every device.
  const step = Math.sign(event.deltaY) * (event.altKey ? 0.2 : 1);
  const key = event.shiftKey ? 'far' : 'near';
  setViewClip(key, viewClip[key] + (key === 'near' ? -step : step));
}
function focusVisibleSurface(event, pane) {
  if (!pane.mesh || !renderAllowed) return;
  event.preventDefault();
  const started = performance.now();
  const renderer = pane.renderer;
  const canPickFloat = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  if (!canPickFloat) {
    // Compatibility path: one precise raycast on double-click only, never on
    // pointer movement or wheel input. Discard hits hidden by either clip mode.
    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    const raycaster = new THREE.Raycaster();
    pane.camera.updateMatrixWorld(); pane.mesh.updateMatrixWorld();
    raycaster.setFromCamera(mouse, pane.camera);
    const direction = pane.camera.getWorldDirection(new THREE.Vector3());
    const eyeDepth = pane.camera.position.dot(direction);
    const clips = pane.mesh.material.clippingPlanes || [];
    const hit = raycaster.intersectObject(pane.mesh, false).find(hit => {
      const depth = hit.point.dot(direction) - eyeDepth;
      return depth >= pane.camera.near && depth <= pane.camera.far && clips.every(plane => plane.distanceToPoint(hit.point) >= 0);
    });
    renderStats.pickMode = 'cpu-visible-surface'; renderStats.picks++;
    renderStats.lastPickMs = performance.now() - started;
    centerOnSurface(hit?.point, pane);
    return;
  }
  const oldTarget = renderer.getRenderTarget();
  const oldColor = renderer.getClearColor(new THREE.Color());
  const oldAlpha = renderer.getClearAlpha();
  let point;
  try {
    if (!pane.pickTarget) {
      pane.pickTarget = new THREE.WebGLRenderTarget(1, 1, {type:THREE.FloatType, minFilter:THREE.NearestFilter, magFilter:THREE.NearestFilter});
      // World-position interpolation avoids amplifying packed-depth errors when
      // inspecting a tiny patch, especially with the eye inside the model bounds.
      pane.pickMaterial = new THREE.ShaderMaterial({
        side:THREE.DoubleSide, blending:THREE.NoBlending, clipping:true, toneMapped:false,
        vertexShader:`
          varying vec3 worldPoint;
          #include <clipping_planes_pars_vertex>
          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vec4 mvPosition = viewMatrix * worldPosition;
            worldPoint = worldPosition.xyz;
            gl_Position = projectionMatrix * mvPosition;
            #include <clipping_planes_vertex>
          }`,
        fragmentShader:`
          varying vec3 worldPoint;
          #include <clipping_planes_pars_fragment>
          void main() {
            #include <clipping_planes_fragment>
            gl_FragColor = vec4(worldPoint, 1.0);
          }`
      });
      pane.pickScene = new THREE.Scene();
      pane.pickMesh = new THREE.Mesh(pane.mesh.geometry, pane.pickMaterial);
      pane.pickMesh.frustumCulled = false;
      pane.pickScene.add(pane.pickMesh);
      pane.pickPixel = new Float32Array(4);
    }
    pane.pickMesh.geometry = pane.mesh.geometry; // shared buffers, no CPU scan/copy
    const clips = pane.mesh.material.clippingPlanes || [];
    if ((pane.pickMaterial.clippingPlanes?.length || 0) !== clips.length) pane.pickMaterial.needsUpdate = true;
    pane.pickMaterial.clippingPlanes = clips;
    const rect = renderer.domElement.getBoundingClientRect();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = THREE.MathUtils.clamp(Math.floor((event.clientX - rect.left) / rect.width * size.x), 0, size.x - 1);
    const py = THREE.MathUtils.clamp(Math.floor((event.clientY - rect.top) / rect.height * size.y), 0, size.y - 1);
    const camera = pane.camera.clone();
    camera.setViewOffset(size.x, size.y, px, py, 1, 1);
    // setViewOffset derives aspect from integer buffer dimensions; keep the
    // displayed camera's CSS-aspect projection (fractional panes are common).
    camera.aspect = pane.camera.aspect;
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(pane.pickTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(pane.pickScene, camera);
    renderer.readRenderTargetPixels(pane.pickTarget, 0, 0, 1, 1, pane.pickPixel);
    const c = pane.pickPixel;
    if (c[3] > 0.5 && c.every(Number.isFinite)) point = new THREE.Vector3(c[0], c[1], c[2]);
    renderStats.pickMode = 'world-position';
    renderStats.picks++;
  } catch (error) {
    if (!busy) message('Surface focus is unavailable; use pan and zoom to inspect.', 'ready');
  } finally {
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldColor, oldAlpha);
    renderStats.lastPickMs = performance.now() - started;
  }
  centerOnSurface(point, pane);
}
function centerOnSurface(point, pane) {
  if (!point) return; // background or clipped geometry: do not move the pivot
  const forward = pane.camera.getWorldDirection(new THREE.Vector3());
  const depth = point.clone().sub(pane.camera.position).dot(forward);
  if (!(depth > 0)) return;
  const distance = THREE.MathUtils.clamp(depth, pane.controls.minDistance, pane.controls.maxDistance);
  // Recenter laterally at the clicked surface's depth, not the old orbit radius.
  // This keeps its apparent scale and the viewing direction (except at distance limits).
  pane.camera.position.copy(point).addScaledVector(forward, -distance);
  pane.controls.target.copy(point);
  pane.controls.update(); syncCameras(pane);
  if (!busy) message(READY_HINT, 'ready');
}
function updateClipUI() {
  const enabled = $('#viewer-cut').checked;
  $('#viewer-section-state').hidden = !enabled;
  $('#viewer-cut-axis').disabled = !enabled;
  $('#viewer-cut-position').disabled = !enabled;
  $('#viewer-cut-value').value = $('#viewer-cut-position').value + '%';
  if (!bounds) return;
  const axis = $('#viewer-cut-axis').value;
  const fraction = Number($('#viewer-cut-position').value) / 100;
  plane.normal.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  plane.constant = -THREE.MathUtils.lerp(bounds.min[axis], bounds.max[axis], fraction);
  const clippingPlanes = enabled ? [plane] : [];
  for (const pane of panes) {
    if (!pane.mesh) continue;
    for (const material of [pane.mesh.material, pane.overlay.material]) {
      const countChanged = (material.clippingPlanes?.length || 0) !== clippingPlanes.length;
      material.clippingPlanes = clippingPlanes;
      if (countChanged) material.needsUpdate = true;
    }
  }
  scheduleRender();
}
function updateOverlay() {
  const enabled = $('#viewer-wireframe').checked;
  const opacity = Number($('#viewer-edge-opacity').value) / 100;
  $('#viewer-edge-opacity').disabled = !enabled || !activeCase;
  $('#viewer-edge-value').value = Math.round(opacity * 100) + '%';
  for (const pane of panes) {
    if (!pane.mesh) continue;
    pane.mesh.material.wireframe = false;
    pane.mesh.material.polygonOffset = enabled;
    pane.overlay.visible = enabled;
    pane.overlay.material.opacity = opacity;
  }
  scheduleRender();
}
function setExpanded(expand) {
  if (expand) expandedPreviousFocus = document.activeElement;
  root.classList.toggle('viewer-expanded', expand);
  $('#viewer-expand').setAttribute('aria-pressed', String(expand));
  $('#viewer-expand').textContent = expand ? 'Exit large view' : 'Large view';
  document.body.classList.toggle('viewer-is-expanded', expand);
  if (expand) {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    $('#viewer-expand').focus({preventScroll: true});
  } else {
    root.removeAttribute('role');
    root.removeAttribute('aria-modal');
    expandedPreviousFocus?.focus({preventScroll: true});
  }
  requestAnimationFrame(resize);
}

loadButton.addEventListener('click', loadSelected);
caseSelect.addEventListener('change', updateMethodOptions);
methodSelects.forEach((select, index) => select.addEventListener('change', () => selectPaneMethod(index)));
$('#viewer-reset').addEventListener('click', resetCamera);
$('#viewer-near-clip').addEventListener('input', event => setViewClip('near', Number(event.target.value)));
$('#viewer-far-clip').addEventListener('input', event => setViewClip('far', Number(event.target.value)));
$('#viewer-clear-clip').addEventListener('click', clearViewClip);
window.addEventListener('keydown', event => { clipModifierDown = event.ctrlKey || event.metaKey; });
window.addEventListener('keyup', event => { clipModifierDown = event.ctrlKey || event.metaKey; });
window.addEventListener('blur', () => { clipModifierDown = false; });
window.addEventListener('resize', resize);
$('#viewer-zoom-in').addEventListener('click', () => zoom(navigation.zoomStep));
$('#viewer-zoom-out').addEventListener('click', () => zoom(1 / navigation.zoomStep));
$('#viewer-wireframe').addEventListener('change', updateOverlay);
$('#viewer-edge-opacity').addEventListener('input', updateOverlay);
$('#viewer-cut').addEventListener('change', updateClipUI);
$('#viewer-section-controls').addEventListener('toggle', () => requestAnimationFrame(resize));
$('#viewer-cut-axis').addEventListener('change', updateClipUI);
$('#viewer-cut-position').addEventListener('input', updateClipUI);
$('#viewer-expand').addEventListener('click', () => setExpanded(!root.classList.contains('viewer-expanded')));
document.addEventListener('keydown', event => {
  if (!root.classList.contains('viewer-expanded')) return;
  if (event.key === 'Escape') setExpanded(false);
  if (event.key === 'Tab') {
    const items = [...root.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],canvas[tabindex],summary')].filter(el => el.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('pagehide', event => {
  if (event.persisted) { renderAllowed = false; return; }
  clearInterval(transferTimer); transferTimer = null;
  aborter?.abort();
  for (const pane of panes) {
    pane.controls.dispose();
    pane.pickTarget?.dispose();
    pane.pickMaterial?.dispose();
    if (pane.overlay) pane.overlay.material.dispose();
    if (pane.mesh) pane.mesh.material.dispose();
    pane.renderer.dispose();
  }
  modelCache.clear();
});
window.addEventListener('pageshow', event => { if (event.persisted) { renderAllowed = !panes.some(pane => pane.contextLost); resize(); } });

window.__VOROFACET_VIEWER__ = {getState: () => ({
  status:root.dataset.state, caseId:activeCase?.id || null, selectedCaseId:caseSelect.value, busy,
  selectedMethodIds:[...selectedMethodIds], loadedMethodIds:panes.map(pane => pane.methodId),
  baselineId:panes[0]?.methodId || null,
  cameras:panes.map(p => ({position:p.camera.position.toArray(), target:p.controls.target.toArray(), quaternion:p.camera.quaternion.toArray(), near:p.camera.near, far:p.camera.far})),
  navigation:panes.map(p => ({rotateSpeed:p.controls.rotateSpeed, panSpeed:p.controls.panSpeed, zoomSpeed:p.controls.zoomSpeed, viewportHeight:p.renderer.domElement.clientHeight, orbitDistance:p.camera.position.distanceTo(p.controls.target), fitDistance:defaultCamera?.position.distanceTo(defaultCamera.target) || 0})),
  meshes:panes.filter(p => p.mesh).map(p => ({role:p.role, paneIndex:p.paneIndex, methodId:p.methodId, geometryId:p.mesh.geometry.id, visible:p.visible, vertices:p.mesh.geometry.getAttribute('position').count, faces:p.mesh.geometry.index.count / 3, matrix:p.mesh.matrix.toArray(), surfaceMaterialVersion:p.mesh.material.version, overlayMaterialVersion:p.overlay.material.version, surfaceVisible:p.mesh.visible, surfaceWireframe:p.mesh.material.wireframe, overlayVisible:p.overlay.visible, overlayWireframe:p.overlay.material.wireframe, sharedGeometry:p.overlay.geometry === p.mesh.geometry, clipPlanesShared:p.overlay.material.clippingPlanes === p.mesh.material.clippingPlanes, surfaceClippingCount:p.mesh.material.clippingPlanes?.length || 0, overlayClippingCount:p.overlay.material.clippingPlanes?.length || 0})),
  viewClip:{...viewClip}, renderStats:{...renderStats},
  loading:{...loadingStats, cache:modelCache.stats(), persistent:persistentCache.stats(), transfer:currentTransfer?.snapshot() || null},
  wireframe:$('#viewer-wireframe').checked, clipping:$('#viewer-cut').checked,
  clipAxis:$('#viewer-cut-axis').value, clipPosition:Number($('#viewer-cut-position').value)
})};

try {
  const configResponse = await fetch(new URL('model-source.json', import.meta.url), {credentials:'omit', mode:'same-origin', redirect:'error'});
  if (!configResponse.ok) throw new Error('Model source configuration unavailable.');
  const config = await configResponse.json();
  if (!/^\.\.\/[A-Za-z0-9][A-Za-z0-9_.-]*\/$/.test(config.base) ||
      !/^[a-f0-9]{64}$/.test(config.sha256) || config.catalog !== `catalogs/${config.sha256}.json`) {
    throw new Error('Invalid model source configuration.');
  }
  modelBase = new URL(config.base, import.meta.url);
  if (modelBase.origin !== location.origin) throw new Error('Models must use the same site origin.');
  const response = await fetch(new URL(config.catalog, modelBase), {credentials:'omit', mode:'same-origin', redirect:'error'});
  if (!response.ok) throw new Error('Model catalog unavailable.');
  const catalogBytes = await response.arrayBuffer();
  if (!globalThis.crypto?.subtle) throw new Error('Open this page over HTTPS to verify model resources.');
  const digest = await crypto.subtle.digest('SHA-256', catalogBytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== config.sha256) throw new Error('Model catalog verification failed.');
  catalog = JSON.parse(new TextDecoder().decode(catalogBytes));
  if (!catalog.cases?.length) throw new Error('No models are available.');
  caseSelect.replaceChildren(...catalog.cases.map(item => new Option(item.label, item.id)));
  caseSelect.value = catalog.defaultCase || catalog.cases[0].id;
  caseSelect.disabled = loadButton.disabled = false;
  updateMethodOptions();
  message('Choose methods in each view, then press Load.', 'idle');
} catch (error) {
  message(error.message + ' Static comparisons below are still available.', 'error');
}
