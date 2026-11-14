import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { loadMODIS, loadCalifornia, loadCounties, loadManifest, getCachedDay, prefetchDays, stopPrefetch, CALIFORNIA_BOUNDS } from './global.js';

const svg = d3.select('#map');
const scene = svg.append('g');
const projection = d3.geoEquirectangular();
let mapSize = { width: 800, height: 650 };
let mapCalifornia, mapCounties;
const path = d3.geoPath(projection);
const color = d3.scaleThreshold().domain([0.2, 0.5, 1, 2]).range(d3.quantize(d3.interpolateViridis, 5));
const DETECTION_COLOR = '#f97316';
const radius = 4.5;
const OPACITY_MAX_FRP = 100;
const powerOpacity = d => d.frp == null || d.frp < 0 ? 0.5 : Math.min(1, d.frp / OPACITY_MAX_FRP);
const detectionTypes = [
  { id: 0, label: 'Vegetation fire' },
  { id: 1, label: 'Active volcano' },
  { id: 2, label: 'Other static land source' },
  { id: 3, label: 'Offshore' },
  { id: -1, label: 'Unknown type' },
];
const enabledTypes = new Set(detectionTypes.map(type => type.id));
const detectionType = d => detectionTypes.find(type => type.id === d.type) ?? detectionTypes[4];
const typeFilters = d3.select('#detection-types').selectAll('button').data(detectionTypes).join('button')
  .attr('type', 'button').attr('aria-pressed', 'true').attr('data-type', d => d.id)
  .text(d => d.label)
  .on('click', function(event, type) {
    if (enabledTypes.has(type.id)) enabledTypes.delete(type.id); else enabledTypes.add(type.id);
    d3.select(this).attr('aria-pressed', String(enabledTypes.has(type.id)));
    drawHistogram();
    render();
  });
const confidence = document.querySelector('#confidence');
const interaction = document.querySelector('#interaction');
let selecting = false;
let region = null; // [[west, south], [east, north]], retained across dates and zoom.
let syncingBrush = false;
let selectedIndex = 252;
const calendar = document.querySelector('#calendar-date');
const infoPopovers = [...document.querySelectorAll('button[popovertarget]')].map(button => ({ button, popover: document.getElementById(button.getAttribute('popovertarget')) }));
function positionInfo() {
  for (const { button, popover } of infoPopovers) {
    if (!popover.matches(':popover-open')) continue;
    const bounds = button.getBoundingClientRect();
    popover.style.left = Math.max(12, Math.min(bounds.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 12)) + 'px';
    popover.style.top = Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - popover.offsetHeight - 12)) + 'px';
  }
}
for (const { popover } of infoPopovers) popover.addEventListener('toggle', event => { if (event.newState === 'open') positionInfo(); });
window.addEventListener('resize', positionInfo);
window.addEventListener('scroll', positionInfo, true);
calendar.addEventListener('change', () => {
  if (!calendar.value) {
    calendar.value = selectedDate();
    return;
  }
  if (!calendar.validity.valid) return;
  selectDay(d3.utcDay.count(firstDay, new Date(calendar.value + 'T00:00:00Z')));
});
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
let data;
let selection = 0;
let debounce;
const snapshot = await loadManifest();
const firstDay = new Date(snapshot.start + 'T00:00:00Z');
const yesterday = d3.utcDay.offset(d3.utcDay.floor(new Date()), -1);
const lastDay = new Date(Math.min(+yesterday, Date.parse(snapshot.end + 'T00:00:00Z')));
const DAY = 86400000;
const daySpan = d3.utcDay.count(firstDay, lastDay);
calendar.min = snapshot.start;
calendar.max = d3.utcFormat('%Y-%m-%d')(lastDay);
selectedIndex = Math.max(0, Math.min(daySpan, d3.utcDay.count(firstDay, new Date(calendar.value + 'T00:00:00Z'))));
const selectedDate = () => d3.utcFormat('%Y-%m-%d')(d3.utcDay.offset(firstDay, selectedIndex));
const viewport = document.querySelector('#timeline-viewport');
const histogram = d3.select('#detection-histogram');
let countDays = null;
let countsRequested = false;
let timelineWidth = 0;
let pixelsPerDay = 3;
let viewStart = 0;
const timelineMargin = { left: 48, right: 12 };
const plotWidth = () => Math.max(1, timelineWidth - timelineMargin.left - timelineMargin.right);
const visibleSpan = () => plotWidth() / pixelsPerDay;
const timeScale = d3.scaleUtc();
function clampView() {
  pixelsPerDay = Math.max(plotWidth() / (daySpan + 1), Math.min(80, pixelsPerDay));
  viewStart = Math.max(-0.5, Math.min(daySpan + 0.5 - visibleSpan(), viewStart));
  timeScale.domain([new Date(+firstDay + viewStart * DAY), new Date(+firstDay + (viewStart + visibleSpan()) * DAY)])
    .range([timelineMargin.left, timelineWidth - timelineMargin.right]);
}
function revealDate() {
  if (selectedIndex < viewStart || selectedIndex > viewStart + visibleSpan()) {
    viewStart = selectedIndex - visibleSpan() / 2;
    clampView();
  }
}
let countSignature = '';
let countVersion = 0;
let filteredCounts = null;
function updateCounts() {
  if (!countDays) return;
  const signature = [...enabledTypes].sort().join(',') + '/' + confidence.value;
  if (signature === countSignature && filteredCounts) return;
  countSignature = signature; countVersion++;
  const minimum = Number(confidence.value);
  filteredCounts = Float64Array.from(countDays, day => day.groups === null ? NaN :
    d3.sum(day.groups, ([type, score, count]) => enabledTypes.has(type) && (minimum === 0 || score >= minimum) ? count : 0));
}
function dailyCount(day) {
  if (!day || day.groups === null) return null;
  updateCounts();
  return filteredCounts[day.index];
}
const timelineDefs = histogram.append('defs');
const timelineClip = timelineDefs.append('clipPath').attr('id', 'timeline-plot-clip').append('rect');
const countGrid = histogram.append('g').attr('class', 'count-grid');
const bars = histogram.append('g').attr('class', 'timeline-bars').attr('clip-path', 'url(#timeline-plot-clip)');
const countAxis = histogram.append('g').attr('class', 'count-axis');
const calendarAxis = histogram.append('g').attr('class', 'calendar-axis');
const yearsAxis = histogram.append('g').attr('class', 'years-axis');
const playhead = histogram.append('g').attr('class', 'playhead').attr('pointer-events', 'none');
playhead.append('line').attr('y1', 5).attr('y2', 170).attr('stroke', DETECTION_COLOR).attr('stroke-width', 1.5);
playhead.append('path').attr('d', d3.symbol().type(d3.symbolTriangle).size(40)()).attr('transform', 'translate(0,6) rotate(180)').attr('fill', DETECTION_COLOR);
let timelineFrame = null;
let lastTimelineView = '';
function drawHistogram() {
  if (!timelineWidth) return;
  clampView();
  if (timelineFrame !== null) return;
  timelineFrame = requestAnimationFrame(() => { timelineFrame = null; renderHistogram(); });
}
function renderHistogram() {
  updateCounts();
  const signature = [timelineWidth, viewStart, pixelsPerDay, countVersion].join('/');
  if (signature !== lastTimelineView) {
    lastTimelineView = signature;
    histogram.attr('viewBox', `0 0 ${timelineWidth} 180`);
    timelineClip.attr('x', timelineMargin.left).attr('y', 0).attr('width', plotWidth()).attr('height', 118);
    const first = Math.max(0, Math.ceil(viewStart - 0.5));
    const last = Math.min(daySpan, Math.floor(viewStart + visibleSpan() + 0.5));
    const visibleDays = countDays?.slice(first, last + 1) ?? [];
    const maxCount = d3.max(visibleDays, day => filteredCounts[day.index]) || 1;
    histogram.attr('data-visible-max', maxCount);
    const y = d3.scaleLinear().domain([0, maxCount]).nice().range([115, 14]);
    const ticks = y.ticks(3);
    countGrid.selectAll('line').data(ticks).join('line')
      .attr('x1', timelineMargin.left).attr('x2', timelineWidth - timelineMargin.right).attr('y1', y).attr('y2', y).attr('stroke', '#e1e7ed');
    countAxis.selectAll('text.count-tick').data(ticks).join('text').attr('class', 'count-tick')
      .attr('x', timelineMargin.left - 7).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d3.format(',d'));
    // Below one pixel/day, preserve the highest daily count per pixel column.
    // Do not sum several days and label that aggregate as a daily count.
    const step = Math.max(1, Math.ceil(1 / pixelsPerDay));
    const columns = [];
    for (let start = first; countDays && start <= last; start += step) {
      const end = Math.min(last, start + step - 1);
      let peak = null, missing = false;
      for (let index = start; index <= end; index++) {
        const value = filteredCounts[index];
        if (Number.isNaN(value)) missing = true; else peak = Math.max(peak ?? 0, value);
      }
      columns.push({ start, end, peak, missing });
    }
    const columnX = column => timelineMargin.left + (column.start - 0.425 - viewStart) * pixelsPerDay;
    const columnWidth = column => Math.max(0.6, (column.end - column.start + 0.85) * pixelsPerDay);
    bars.selectAll('rect.day-bar').data(columns.filter(column => column.peak !== null), column => column.start).join('rect').attr('class', 'day-bar')
      .attr('data-start', column => column.start).attr('data-end', column => column.end).attr('data-count', column => column.peak)
      .attr('x', columnX).attr('y', column => y(column.peak)).attr('width', columnWidth).attr('height', column => y(0) - y(column.peak))
      .selectAll('title').data(column => [column]).join('title')
      .text(column => column.start === column.end ? `${countDays[column.start].date}: ${column.peak.toLocaleString()} detections` :
        `${countDays[column.start].date}–${countDays[column.end].date}: peak ${column.peak.toLocaleString()} detections/day`);
    bars.selectAll('rect.missing-day').data(columns.filter(column => column.missing), column => column.start).join('rect').attr('class', 'missing-day')
      .attr('x', columnX).attr('y', 112).attr('width', columnWidth).attr('height', 5).attr('fill', '#cbd0d5');
    const span = visibleSpan();
    const yearsOnly = span > 365 * 3;
    const interval = yearsOnly ? d3.utcYear.every(Math.max(1, Math.ceil(span / 365 / (plotWidth() / 64)))) :
      span > 730 ? d3.utcMonth.every(3) : span > 120 ? d3.utcMonth : span > 35 ? d3.utcMonday : d3.utcDay.every(Math.max(1, Math.ceil(55 / pixelsPerDay)));
    const tickFormat = d3.utcFormat(yearsOnly ? '%Y' : span > 120 ? '%b' : '%b %d');
    let previousTickX = -Infinity;
    const tickDates = timeScale.ticks(interval).filter(day => {
      const x = timeScale(day);
      if (x - previousTickX < 52) return false;
      previousTickX = x;
      return true;
    });
    calendarAxis.attr('transform', 'translate(0,123)').call(d3.axisBottom(timeScale).tickValues(tickDates).tickFormat(tickFormat).tickSize(5))
      .call(g => g.select('.domain').attr('stroke', '#cbd5e1'));
    const [start, end] = timeScale.domain();
    const labels = [];
    if (!yearsOnly) {
      const years = d3.utcYear.range(d3.utcYear.floor(new Date(Math.max(+start, +firstDay))), d3.utcDay.offset(end, 1));
      for (const year of years) {
        const left = Math.max(timelineMargin.left, timeScale(year));
        const right = Math.min(timelineWidth - timelineMargin.right, timeScale(d3.utcYear.offset(year, 1)));
        if (right - left < 20) continue; // Omit tiny slivers of adjacent years.
        const x = (left + right) / 2;
        if (!labels.length || x - labels[labels.length - 1].x >= 44) labels.push({ year, x });
      }
    }
    yearsAxis.selectAll('text').data(labels, label => +label.year).join('text').attr('x', label => label.x)
      .attr('y', 169).attr('text-anchor', 'middle').text(label => d3.utcFormat('%Y')(label.year));
    if (countDays) document.querySelector('#histogram-status').textContent = 'Daily California detections · statewide, filters applied' + (step > 1 ? ' · peak daily count per column' : '');
  }
  bars.selectAll('rect.day-bar').attr('fill', column => selectedIndex >= column.start && selectedIndex <= column.end ? DETECTION_COLOR : '#6e879e');
  const selectedX = timeScale(+firstDay + selectedIndex * DAY);
  playhead.attr('transform', `translate(${selectedX},0)`).attr('display', selectedX < timelineMargin.left || selectedX > timelineWidth - timelineMargin.right ? 'none' : null);
  viewport.setAttribute('aria-valuenow', selectedIndex);
  viewport.setAttribute('aria-valuetext', selectedDate());
}
function zoomTimeline(factor, anchorX) {
  const x = Math.max(timelineMargin.left, Math.min(timelineWidth - timelineMargin.right, anchorX));
  const anchorDay = viewStart + (x - timelineMargin.left) / pixelsPerDay;
  pixelsPerDay = Math.max(plotWidth() / (daySpan + 1), Math.min(80, pixelsPerDay * factor));
  viewStart = anchorDay - (x - timelineMargin.left) / pixelsPerDay;
  drawHistogram();
}
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  event.stopPropagation();
  const zooming = event.ctrlKey || event.metaKey;
  const raw = zooming ? (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
    : event.deltaX || (event.shiftKey ? event.deltaY : 0);
  if (!raw) return;
  const delta = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotWidth() : 1);
  if (zooming) zoomTimeline(Math.exp(-Math.max(-250, Math.min(250, delta)) * 0.004), d3.pointer(event, histogram.node())[0]);
  else { viewStart += delta / pixelsPerDay; drawHistogram(); }
}, { passive: false });
let scrubPointer = null;
const timelineTouches = new Map();
let touchSession = null;
let touchGesture = null;
let touchCommit = null;
function scrubAtX(x) {
  const bounded = Math.max(timelineMargin.left, Math.min(timelineWidth - timelineMargin.right, x));
  selectDay(d3.utcDay.count(firstDay, d3.utcDay.round(timeScale.invert(bounded))), { reveal: false });
}
function captureTimelinePointer(event) {
  try { histogram.node().setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
}
function beginTouchGesture() {
  clearTimeout(touchCommit); touchCommit = null;
  touchSession.hadMultiple = true;
  const [a, b] = [...timelineTouches.values()];
  const centerX = (a.x + b.x) / 2;
  touchGesture = {
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    scale: pixelsPerDay,
    anchorDay: viewStart + (centerX - timelineMargin.left) / pixelsPerDay,
  };
}
function moveTouchGesture() {
  const [a, b] = [...timelineTouches.values()];
  const centerX = (a.x + b.x) / 2;
  const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  pixelsPerDay = Math.max(plotWidth() / (daySpan + 1), Math.min(80, touchGesture.scale * distance / touchGesture.distance));
  viewStart = touchGesture.anchorDay - (centerX - timelineMargin.left) / pixelsPerDay;
  drawHistogram();
}
function finishTimelinePointer(event) {
  if (timelineTouches.has(event.pointerId)) {
    clearTimeout(touchCommit); touchCommit = null;
    // A two-finger gesture never turns into a scrub as fingers lift one by one.
    if (event.type === 'pointerup' && timelineTouches.size === 1 && !touchSession.hadMultiple && touchSession.eligible) {
      scrubAtX(d3.pointer(event, histogram.node())[0]);
    }
    timelineTouches.delete(event.pointerId);
    if (timelineTouches.size >= 2) beginTouchGesture();
    else touchGesture = null;
    if (!timelineTouches.size) touchSession = null;
  }
  if (event.pointerId === scrubPointer) scrubPointer = null;
}
histogram.on('pointerdown', event => {
  if (event.button !== 0) return;
  const [x, y] = d3.pointer(event, histogram.node());
  if (event.pointerType === 'touch') {
    event.preventDefault();
    if (!timelineTouches.size) touchSession = { start: { x, y }, active: false, hadMultiple: false, eligible: x >= timelineMargin.left && x <= timelineWidth - timelineMargin.right };
    timelineTouches.set(event.pointerId, { x, y });
    captureTimelinePointer(event);
    viewport.focus({ preventScroll: true });
    if (timelineTouches.size >= 2) beginTouchGesture();
    return;
  }
  if (x < timelineMargin.left) return;
  event.preventDefault();
  scrubPointer = event.pointerId;
  viewport.focus({ preventScroll: true });
  captureTimelinePointer(event);
  scrubAtX(x);
}).on('pointermove', event => {
  const [x, y] = d3.pointer(event, histogram.node());
  if (timelineTouches.has(event.pointerId)) {
    event.preventDefault();
    timelineTouches.set(event.pointerId, { x, y });
    if (timelineTouches.size >= 2 && touchGesture) moveTouchGesture();
    else if (!touchSession.hadMultiple && touchSession.eligible) {
      if (touchSession.active) scrubAtX(x);
      else if (!touchCommit && Math.hypot(x - touchSession.start.x, y - touchSession.start.y) >= 4) {
        // Give the second finger a short arrival window before committing a scrub.
        touchCommit = setTimeout(() => {
          touchCommit = null;
          if (timelineTouches.size === 1 && !touchSession?.hadMultiple) {
            touchSession.active = true;
            scrubAtX([...timelineTouches.values()][0].x);
          }
        }, 60);
      }
    }
  } else if (event.pointerId === scrubPointer) scrubAtX(x);
}).on('pointerup pointercancel lostpointercapture', finishTimelinePointer);
window.addEventListener('blur', () => {
  clearTimeout(touchCommit); touchCommit = null;
  timelineTouches.clear(); touchSession = null; touchGesture = null; scrubPointer = null;
});

viewport.setAttribute('aria-valuemin', 0);
viewport.setAttribute('aria-valuemax', daySpan);
function stepDateWithArrow(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
  const step = event.shiftKey ? 7 : 1;
  event.preventDefault();
  selectDay(selectedIndex + (event.key === 'ArrowRight' ? step : -step));
}
window.addEventListener('keydown', stepDateWithArrow);
viewport.addEventListener('keydown', event => {
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault(); selectDay(event.key === 'Home' ? 0 : daySpan);
  } else if (['+', '=', '-'].includes(event.key)) {
    event.preventDefault(); zoomTimeline(event.key === '-' ? 0.8 : 1.25, timelineMargin.left + plotWidth() / 2);
  } else if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault(); viewStart += visibleSpan() * (event.key === 'PageDown' ? 0.8 : -0.8); drawHistogram();
  }
});
async function loadHistogram() {
  if (countsRequested) return;
  countsRequested = true;
  document.querySelector('#retry-counts').hidden = true;
  try {
    const response = await fetch(new URL('data/detection-counts.json', import.meta.url), { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const summary = await response.json();
    if (summary.satellite !== 'Terra' || !summary.days.length) throw new Error('Unexpected count table');
    const byDate = new Map(summary.days.map(day => [day.date, day]));
    countDays = d3.utcDay.range(firstDay, d3.utcDay.offset(lastDay, 1)).map(day => {
      const key = d3.utcFormat('%Y-%m-%d')(day);
      return { ...(byDate.get(key) ?? { date: key, groups: null }), index: d3.utcDay.count(firstDay, day) };
    });
    document.querySelector('#data-updated').textContent = 'Downloaded detections and counts updated ' + summary.generatedAt.slice(0, 10) + ' (UTC). Recent records may lack inferred source type; gray timeline marks mean unavailable counts.';
    countSignature = ''; filteredCounts = null;
    drawHistogram();
  } catch (error) {
    countsRequested = false;
    document.querySelector('#histogram-status').textContent = `Daily counts unavailable: ${error.message}`;
    document.querySelector('#retry-counts').hidden = false;
  }
}
document.querySelector('#retry-counts').addEventListener('click', loadHistogram);
new ResizeObserver(([entry]) => {
  const center = timelineWidth ? viewStart + visibleSpan() / 2 : selectedIndex;
  timelineWidth = entry.contentRect.width;
  viewStart = center - visibleSpan() / 2;
  drawHistogram();
}).observe(viewport);


scene.append('path').attr('class', 'land').attr('fill', '#e6e6e6');
const clip = svg.append('defs').append('clipPath').attr('id', 'california-clip').append('path');
const aerosols = scene.append('g').attr('clip-path', 'url(#california-clip)');
scene.append('path').attr('class', 'boundary').attr('fill', 'none').attr('stroke', '#444').attr('stroke-width', 1).attr('vector-effect', 'non-scaling-stroke');
const countiesLayer = scene.append('g').attr('class', 'counties').attr('fill', 'none').attr('stroke', '#575757').attr('stroke-opacity', 0.55).attr('pointer-events', 'none');
const fires = scene.append('g');
const brushLayer = svg.append('g').attr('class', 'brush');
const brush = d3.brush().extent(() => [[0, 0], [mapSize.width, mapSize.height]]).on('brush end', event => {
  if (syncingBrush) return;
  const transform = d3.zoomTransform(svg.node());
  if (event.selection) {
    const [a, b] = event.selection.map(point => projection.invert(transform.invert(point)));
    region = [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
  } else region = null;
  updateSelection();
});
brushLayer.call(brush).attr('pointer-events', 'none').attr('display', 'none');
function syncBrush() {
  syncingBrush = true;
  const transform = d3.zoomTransform(svg.node());
  brushLayer.call(brush.move, region ? [transform.apply(projection([region[0][0], region[1][1]])), transform.apply(projection([region[1][0], region[0][1]]))] : null);
  syncingBrush = false;
}
const zoom = d3.zoom().scaleExtent([1, 10])
  .filter(event => event.type === 'wheel' || (!selecting && !event.button && !event.ctrlKey))
  .on('zoom', event => {
  scene.attr('transform', event.transform);
  fires.selectAll('circle').attr('r', radius / event.transform.k);
  syncBrush();
});
svg.call(zoom);
// D3 lets wheel events through at its zoom limits. Keep them inside the map
// even when a wheel gesture cannot change the current zoom any further.
svg.node().addEventListener('wheel', event => {
  event.preventDefault();
  event.stopPropagation();
}, { passive: false });
interaction.addEventListener('click', () => {
  selecting = !selecting;
  interaction.setAttribute('aria-pressed', String(selecting));
  brushLayer.attr('pointer-events', selecting ? 'all' : 'none').attr('display', selecting || region ? null : 'none');
  // D3 sets pointer-events on brush children explicitly; disable those in Pan.
  brushLayer.selectAll('*').style('pointer-events', selecting ? null : 'none');
  svg.classed('selecting', selecting);
});
document.querySelector('#clear-selection').addEventListener('click', () => {
  brushLayer.call(brush.move, null);
  if (!selecting) brushLayer.attr('display', 'none');
});
document.querySelector('#reset').addEventListener('click', () => svg.call(zoom.transform, d3.zoomIdentity));

function applyBrushMode() {
  brushLayer.attr('pointer-events', selecting ? 'all' : 'none').attr('display', selecting || region ? null : 'none');
  brushLayer.selectAll('*').style('pointer-events', selecting ? null : 'none');
}
function layoutMap() {
  const width = svg.node().clientWidth, height = svg.node().clientHeight;
  if (!width || !height) return;
  const oldTransform = d3.zoomTransform(svg.node());
  const oldCenter = mapCalifornia ? projection.invert(oldTransform.invert([mapSize.width / 2, mapSize.height / 2])) : null;
  mapSize = { width, height };
  // SVG coordinates now match the entire visible canvas, including what used
  // to be letterboxed space outside the fixed 800×650 viewBox.
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  brushLayer.call(brush);
  if (mapCalifornia) {
    projection.fitExtent([[20, 20], [width - 20, height - 20]], mapCalifornia);
    scene.selectAll('.land, .boundary').datum(mapCalifornia).attr('d', path);
    clip.datum(mapCalifornia).attr('d', path);
    countiesLayer.selectAll('path').data(mapCounties.features).join('path').attr('d', path)
      .attr('stroke-width', 0.6).attr('vector-effect', 'non-scaling-stroke');
    rasterGeometry.clear(); lastRaster = undefined;
    // Existing rectangles otherwise retain positions from the old projection.
    aerosols.selectAll('rect').remove();
    if (oldCenter && (oldTransform.k !== 1 || oldTransform.x !== 0 || oldTransform.y !== 0)) {
      const center = projection(oldCenter);
      svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2 - oldTransform.k * center[0], height / 2 - oldTransform.k * center[1]).scale(oldTransform.k));
    } else svg.call(zoom.transform, d3.zoomIdentity);
    if (data) render();
  }
  syncBrush();
  applyBrushMode();
}
new ResizeObserver(layoutMap).observe(svg.node());

function inRegion(d) {
  return !region || (d.longitude >= region[0][0] && d.longitude <= region[1][0] && d.latitude >= region[0][1] && d.latitude <= region[1][1]);
}
function filteredFires() {
  return (data?.days[0].fires ?? []).filter(d => enabledTypes.has(detectionType(d).id) && (Number(confidence.value) === 0 || (d.confidence !== null && d.confidence >= Number(confidence.value))));
}
function updateMapStatus() {
  if (!data) { status.textContent = region ? 'Selected region · Loading selected date…' : 'Loading selected date…'; return; }
  const day = data.days[0];
  const errors = Object.entries(day.errors).map(([layer, message]) => `${layer}: ${message}`);
  const suffix = (errors.length ? ' · ' + errors.join('; ') : '') +
    (day.date !== selectedDate() ? ` · Loading selected date; map still shows ${day.date}` : '');
  if (!region) {
    status.textContent = `${day.fires === null ? 'Detections unavailable' : `${filteredFires().length.toLocaleString()} of ${day.fires.length.toLocaleString()} detections passing type and confidence filters`} · ${day.aod ? `${(day.aod.coverage * 100).toFixed(1)}% AOD coverage` : 'AOD unavailable'}${suffix}`;
    return;
  }
  const cells = day.aod?.cells.filter(inRegion) ?? [];
  const observed = cells.filter(cell => cell.value !== null);
  const totalWeight = d3.sum(cells, cell => cell.weight), observedWeight = d3.sum(observed, cell => cell.weight);
  const coverage = totalWeight ? observedWeight / totalWeight : 0;
  const mean = coverage >= 0.05 ? d3.sum(observed, cell => cell.value * cell.weight) / observedWeight : null;
  status.textContent = `Selected region · ${day.fires === null ? 'Detections unavailable' : `${filteredFires().filter(inRegion).length.toLocaleString()} detections passing type and confidence filters`} · ${day.aod ? `${(coverage * 100).toFixed(1)}% AOD coverage` : 'AOD unavailable'} · Mean AOD: ${mean === null ? 'unavailable' : `≈ ${mean.toFixed(2)}`} (area weighted; needs ≥5% coverage)${suffix}`;
}
function updateSelection() {
  fires.selectAll('circle').attr('opacity', point => powerOpacity(point) * (inRegion(point) ? 1 : 0.15));
  aerosols.selectAll('rect').attr('opacity', cell => inRegion(cell) ? 1 : 0.2);
  document.querySelector('#clear-selection').disabled = !region;
  updateMapStatus();
}
confidence.addEventListener('input', () => {
  document.querySelector('#confidence-value').value = `${confidence.value}%`;
  drawHistogram();
  render();
});

function visibility() {
  aerosols.attr('display', document.querySelector('#aod-layer').checked ? null : 'none');
  fires.attr('display', document.querySelector('#fire-layer').checked ? null : 'none');
}
for (const id of ['aod-layer', 'fire-layer']) document.querySelector(`#${id}`).addEventListener('input', visibility);

// The fixed scale lets dates be compared without silently rescaling the colors.
const aodLegend = d3.select('#legend').append('svg').attr('viewBox', '0 0 160 230').attr('role', 'img')
  .attr('aria-label', 'Aerosol optical depth: five Viridis bins. Gray indicates unavailable observations.');
aodLegend.append('text').attr('class', 'legend-heading').attr('x', 5).attr('y', 16).text('Aerosol optical depth');
aodLegend.append('text').attr('x', 5).attr('y', 34).text('(approximate)');
const binLabels = ['0–<0.2', '0.2–<0.5', '0.5–<1', '1–<2', '≥2'];
const aodBins = color.range().map((fill, i) => ({ fill, label: binLabels[i] })).reverse();
aodLegend.selectAll('rect.aod-bin').data(aodBins).join('rect').attr('class', 'aod-bin').attr('x', 8).attr('y', (_, i) => 48 + i * 29).attr('width', 22).attr('height', 29).attr('fill', d => d.fill);
aodLegend.selectAll('text.bin-label').data(aodBins).join('text').attr('class', 'bin-label').attr('x', 39).attr('y', (_, i) => 67 + i * 29).text(d => d.label);
aodLegend.append('rect').attr('x', 8).attr('y', 207).attr('width', 22).attr('height', 16).attr('fill', '#e6e6e6');
aodLegend.append('text').attr('x', 39).attr('y', 219).text('Unavailable');
const powerLegend = d3.select('#legend').append('svg').attr('viewBox', '0 0 160 240').attr('role', 'img')
  .attr('aria-label', 'Thermal detection opacity ranges: below 25 MW, 25 to 50, 50 to 75, 75 to 100, and at least 100 MW. Opacity varies continuously, reaching full opacity at 100 MW.');
powerLegend.append('text').attr('class', 'legend-heading').attr('x', 5).attr('y', 16).text('Thermal detections');
powerLegend.append('text').attr('x', 5).attr('y', 34).text('Radiative power (MW)');
const opacityExamples = [
  { frp: 12.5, label: '0–<25' }, { frp: 37.5, label: '25–<50' },
  { frp: 62.5, label: '50–<75' }, { frp: 87.5, label: '75–<100' },
  { frp: 100, label: '≥100' }, { frp: null, label: 'Unknown' },
];
powerLegend.selectAll('circle.opacity-example').data(opacityExamples).join('circle').attr('class', 'opacity-example')
  .attr('cx', 19).attr('cy', (_, i) => 55 + i * 27).attr('r', radius).attr('fill', DETECTION_COLOR).attr('opacity', powerOpacity);
powerLegend.selectAll('text.opacity-label').data(opacityExamples).join('text').attr('class', 'opacity-label')
  .attr('x', 39).attr('y', (_, i) => 59 + i * 27).text(d => d.label);
powerLegend.append('text').attr('x', 5).attr('y', 236).text('Opacity varies continuously');

let lastRaster;
const rasterGeometry = new Map();
let baseReady = false;
let warmTimer;
function warmNeighbors(date) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    if (selectedDate() === date && data?.days[0].date === date) prefetchDays(date).catch(() => {});
  }, 100);
}
function render() {
  if (!data) return;
  const day = data.days[0];
  calendar.value = selectedDate();
  if (day.aod !== lastRaster) {
    const [west, south, east, north] = CALIFORNIA_BOUNDS;
    const dx = (east - west) / 240, dy = (north - south) / 223;
    function geometry(cell) {
      if (!rasterGeometry.has(cell.index)) {
        const a = projection([cell.longitude - dx / 2, cell.latitude + dy / 2]);
        const b = projection([cell.longitude + dx / 2, cell.latitude - dy / 2]);
        rasterGeometry.set(cell.index, { x: a[0], y: a[1], width: b[0] - a[0] + 0.05, height: b[1] - a[1] + 0.05 });
      }
      return rasterGeometry.get(cell.index);
    }
    const cells = aerosols.selectAll('rect').data(day.aod?.cells.filter(cell => cell.value !== null) ?? [], cell => cell.index).join(
      enter => {
        const rectangles = enter.append('rect').attr('x', cell => geometry(cell).x).attr('y', cell => geometry(cell).y)
          .attr('width', cell => geometry(cell).width).attr('height', cell => geometry(cell).height);
        rectangles.append('title');
        return rectangles;
      }
    ).attr('fill', cell => color(cell.value));
    cells.select('title').text(cell => `${day.date} · AOD ≈ ${cell.value.toFixed(3)} (${cell.lower}–${cell.upper})\n${cell.latitude.toFixed(2)}°N, ${(-cell.longitude).toFixed(2)}°W`);
    lastRaster = day.aod;
  }
  fires.selectAll('circle').data(filteredFires(), d => d.id).join('circle')
    .attr('cx', d => projection([d.longitude, d.latitude])[0]).attr('cy', d => projection([d.longitude, d.latitude])[1])
    .attr('r', radius / d3.zoomTransform(svg.node()).k).attr('fill', DETECTION_COLOR)
    .attr('stroke', DETECTION_COLOR).attr('stroke-width', 0.35).attr('vector-effect', 'non-scaling-stroke').attr('tabindex', 0)
    .selectAll('title').data(d => [d]).join('title').text(d => `${d.date} ${d.acquisitionTime ?? ''} UTC\nType: ${detectionType(d).label} (inferred)\nConfidence: ${d.confidence ?? 'unavailable'}%\nFRP: ${d.frp ?? 'unavailable'} MW\n${d.latitude}°N, ${d.longitude}°E`);
  retry.hidden = !data.days.some(day => Object.keys(day.errors).length);
  visibility();
  updateSelection();
}
function selectDay(index, { reveal = true } = {}) {
  const next = Math.max(0, Math.min(daySpan, Math.round(index)));
  if (next === selectedIndex) { if (reveal) revealDate(); drawHistogram(); return; }
  selectedIndex = next;
  // Invalidate earlier results immediately, even during the debounce interval.
  selection++;
  stopPrefetch(selectedDate());
  clearTimeout(warmTimer);
  clearTimeout(debounce);
  calendar.value = selectedDate();
  if (reveal) revealDate();
  drawHistogram();
  const ready = getCachedDay(selectedDate());
  if (ready && baseReady) {
    data = { days: [ready] }; render(); svg.attr('aria-busy', 'false'); warmNeighbors(selectedDate());
    return;
  }
  // Keep the displayed map intact while the requested date loads.
  updateMapStatus();
  svg.attr('aria-busy', 'true'); retry.hidden = true;
  debounce = setTimeout(load, 100);
}

async function load() {
  const version = ++selection;
  const requestedDate = selectedDate();
  retry.hidden = true;
  updateMapStatus();
  svg.attr('aria-busy', 'true');
  try {
    // Display the outline before imagery arrives; request only this day's layers.
    if (!baseReady) {
    const [california, counties] = await Promise.all([loadCalifornia(), loadCounties()]);
    if (version !== selection) return;
    mapCalifornia = california; mapCounties = counties;
    baseReady = true;
    layoutMap();
    }
    const next = await loadMODIS({ start: requestedDate, end: requestedDate });
    if (version !== selection) return;
    data = next;
    render();
    warmNeighbors(requestedDate);
    // Counts are a compact aggregate file; never fetch all daily map records.
    // Let the initial map paint before requesting the histogram.
    requestAnimationFrame(() => setTimeout(loadHistogram, 0));
  } catch (error) {
    if (version !== selection) return;
    status.textContent = `Could not load MODIS data: ${error.message}`;
    retry.hidden = false;
  } finally {
    if (version === selection) svg.attr('aria-busy', 'false');
  }
}
retry.addEventListener('click', load);
load();
