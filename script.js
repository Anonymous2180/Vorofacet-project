"use strict";
(() => {
  const data = window.VOROFACET_DATA;
  if (!data) return;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function selectTab(attribute, key, panelSelector) {
    $$(`[${attribute}]`).forEach((tab) => {
      const active = tab.getAttribute(attribute) === key;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) $(panelSelector).setAttribute("aria-labelledby", tab.id);
    });
  }

  function showFigure(key) {
    const item = data.figures[key];
    if (!item) return;
    selectTab("data-figure", key, "#figure-panel");
    const src = `assets/${item.file}`;
    const img = $("#full-figure-image");
    img.src = `assets/${item.file.replace(".webp", "-preview.webp")}`;
    img.alt = item.title + ". " + item.caption;
    img.width = item.width;
    img.height = item.height;
    $("#full-figure-link").href = src;
    $("#full-figure-link").dataset.caption = item.title;
    $("#full-figure-download").href = src;
    $("#full-figure-caption").textContent = item.caption;
  }

  function showTable(key) {
    const table = data.tables[key];
    if (!table) return;
    selectTab("data-table", key, "#table-panel");
    $("#table-caption").textContent = table.caption;
    // Keep all summaries scoped to the selected manuscript table, without rounding.
    const ours = table.rows.find(row => row[0] === "VoroFacet");
    $(".metric-strip").setAttribute("aria-label", "VoroFacet — " + table.caption);
    ["nm-f1", "va-nm-f1", "components"].forEach((metric, index) => {
      const value = ours[index + 3].split("±")[0];
      const node = $(`[data-highlight="${metric}"]`);
      node.textContent = value;
      if (metric !== "components") {
        const percent = document.createElement("span");
        percent.textContent = "%";
        node.append(percent);
      }
    });
    // The paper marks best means in bold. Components has no optimization direction.
    const metrics = ["cd", "f1", "nm-f1", "va-nm-f1", "components"];
    const best = metrics.slice(0, 4).map((_, index) => {
      const means = table.rows.map(row => row[index + 1]).filter(value => value !== null).map(parseFloat);
      return index === 0 ? Math.min(...means) : Math.max(...means);
    });
    const fragment = document.createDocumentFragment();
    table.rows.forEach(([method, ...values]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = method;
      if (method === "VoroFacet") {
        tr.className = "ours-row";
        const tag = document.createElement("span");
        tag.className = "ours-pill";
        tag.textContent = "Ours";
        th.append(tag);
      }
      tr.append(th);
      values.forEach((value, index) => {
        const td = document.createElement("td");
        td.dataset.metric = metrics[index];
        if (value !== null && index < best.length && parseFloat(value) === best[index]) td.className = "best-value";
        const number = document.createElement("span");
        number.className = "metric-number";
        const mean = document.createElement("span");
        mean.className = "mean";
        const std = document.createElement("span");
        std.className = "std";
        if (value === null) mean.textContent = "—";
        else {
          const [average, deviation] = value.split("±");
          mean.textContent = average;
          if (deviation) std.textContent = " ± " + deviation;
        }
        number.append(mean, std);
        td.append(number);
        tr.append(td);
      });
      fragment.append(tr);
    });
    $("#results-body").replaceChildren(fragment);
  }

  function setupTabs(attribute, callback) {
    const tabs = $$(`[${attribute}]`);
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => callback(tab.getAttribute(attribute)));
      tab.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        callback(tabs[next].getAttribute(attribute));
        tabs[next].focus();
      });
    });
  }
  setupTabs("data-figure", showFigure);
  setupTabs("data-table", showTable);
  $$("[data-viewer-case]").forEach(link => link.addEventListener("click", () => {
    const select = document.querySelector('#model-case');
    if (select && !select.disabled && [...select.options].some(option => option.value === link.dataset.viewerCase)) {
      select.value = link.dataset.viewerCase;
      select.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }));

  $$("[data-hero-figure]").forEach(link => link.addEventListener("click", () => showFigure(link.dataset.heroFigure)));

  const dialog = $("#image-dialog");
  const image = $("#dialog-image"), stage = $(".dialog-image-wrap");
  const zoomLabel = $("#dialog-zoom-value");
  const pointers = new Map();
  let previouslyFocused, previousOverflow, imageRequest = 0;
  let scale = 1, x = 0, y = 0, fitScale = 1, fitted = true;
  const size = () => ({w:stage.clientWidth, h:stage.clientHeight});
  function paint() {
    const {w, h} = size(), iw = image.naturalWidth * scale, ih = image.naturalHeight * scale;
    x = iw <= w ? (w - iw) / 2 : Math.max(w - iw, Math.min(0, x));
    y = ih <= h ? (h - ih) / 2 : Math.max(h - ih, Math.min(0, y));
    image.style.width = image.naturalWidth + 'px';
    image.style.height = image.naturalHeight + 'px';
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomLabel.value = Math.round(scale * 100) + '%';
    stage.classList.toggle('is-zoomed', scale > fitScale * 1.01);
  }
  function fitImage() {
    if (!dialog.open || !image.naturalWidth) return;
    const {w, h} = size();
    fitScale = Math.min(1, (w - 24) / image.naturalWidth, (h - 24) / image.naturalHeight);
    scale = fitScale; fitted = true; x = y = 0;
    paint();
  }
  function zoomAt(next, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) {
    if (!image.naturalWidth) return;
    next = Math.max(fitScale, Math.min(Math.max(4, fitScale * 8), next));
    x = cx - (cx - x) * next / scale;
    y = cy - (cy - y) * next / scale;
    scale = next; fitted = Math.abs(scale - fitScale) < 0.00001;
    paint();
  }
  $('#dialog-zoom-in').addEventListener('click', () => zoomAt(scale * 1.4));
  $('#dialog-zoom-out').addEventListener('click', () => zoomAt(scale / 1.4));
  $('#dialog-fit').addEventListener('click', fitImage);
  $('#dialog-native').addEventListener('click', () => zoomAt(1));
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    zoomAt(scale * Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.003), event.clientX - rect.left, event.clientY - rect.top);
  }, {passive:false});
  const local = event => {
    const rect = stage.getBoundingClientRect();
    return {x:event.clientX - rect.left, y:event.clientY - rect.top};
  };
  const pair = points => {
    const [a,b] = points;
    return {x:(a.x+b.x)/2, y:(a.y+b.y)/2, distance:Math.hypot(a.x-b.x,a.y-b.y)};
  };
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointers.set(event.pointerId, local(event));
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const before = [...pointers.values()], old = pointers.get(event.pointerId), next = local(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 1) { x += next.x-old.x; y += next.y-old.y; paint(); }
    else if (pointers.size === 2) {
      const a = pair(before), b = pair([...pointers.values()]);
      const nextScale = Math.max(fitScale, Math.min(Math.max(4, fitScale*8), scale*b.distance/Math.max(a.distance,1)));
      x = b.x - (a.x-x)*nextScale/scale; y = b.y - (a.y-y)*nextScale/scale;
      scale = nextScale; fitted = Math.abs(scale-fitScale)<0.00001; paint();
    }
  });
  const releasePointer = event => { pointers.delete(event.pointerId); if (!pointers.size) stage.classList.remove('is-dragging'); };
  ['pointerup','pointercancel','lostpointercapture'].forEach(type => stage.addEventListener(type, releasePointer));
  stage.addEventListener('dblclick', event => {
    const point = local(event);
    if (scale > fitScale * 1.5) fitImage(); else zoomAt(scale * 2, point.x, point.y);
  });
  dialog.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoomAt(scale * 1.4);
    else if (event.key === '-') zoomAt(scale / 1.4);
    else if (event.key === '0') fitImage();
    else if (event.key === '1') zoomAt(1);
    else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
      x += event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0;
      y += event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0;
      paint();
    } else return;
    event.preventDefault();
  });
  new ResizeObserver(() => {
    if (!dialog.open || !image.naturalWidth) return;
    if (fitted) fitImage(); else {
      const {w,h} = size();
      fitScale = Math.min(1,(w-24)/image.naturalWidth,(h-24)/image.naturalHeight);
      zoomAt(Math.max(scale,fitScale));
    }
  }).observe(stage);
  document.addEventListener("click", async (event) => {
    const link = event.target.closest("[data-zoom]");
    if (!link || typeof dialog.showModal !== "function" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    previouslyFocused = link;
    const request = ++imageRequest;
    $("#dialog-title").textContent = link.dataset.caption || "Figure preview";
    image.style.visibility = 'hidden';
    image.src = link.href;
    image.alt = link.querySelector("img")?.alt || link.dataset.caption || "Research figure";
    $("#dialog-original").href = link.href;
    $('.dialog-help').textContent = 'Scroll / pinch to zoom · Drag to pan · Esc to close';
    previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    $("#dialog-close").focus();
    try {
      await image.decode();
      if (request !== imageRequest || !dialog.open) return;
      fitImage(); image.style.visibility = 'visible';
    } catch (_) { if (request === imageRequest) $('.dialog-help').textContent = 'Image could not load. Try Original or reopen the figure.'; }
  });
  $("#dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    imageRequest++; pointers.clear(); stage.classList.remove('is-dragging');
    document.body.style.overflow = previousOverflow || "";
    if (previouslyFocused) previouslyFocused.focus({ preventScroll: true });
  });
  showFigure("nm");
  showTable("nm");
})();
