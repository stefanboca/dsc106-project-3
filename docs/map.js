import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { loadMODIS, loadCalifornia, loadCounties, CALIFORNIA_BOUNDS } from './global.js';

const svg = d3.select('#map');
const scene = svg.append('g');
const projection = d3.geoEquirectangular();
const path = d3.geoPath(projection);
const color = d3.scaleThreshold().domain([0.2, 0.5, 1, 2]).range(d3.schemeYlGnBu[5]);
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
const date = document.querySelector('#date');
const calendar = document.querySelector('#calendar-date');
const infoButton = document.querySelector('#confidence-info');
const infoPopover = document.querySelector('#confidence-help');
function positionInfo() {
  const bounds = infoButton.getBoundingClientRect();
  infoPopover.style.left = Math.max(12, Math.min(bounds.right - infoPopover.offsetWidth, window.innerWidth - infoPopover.offsetWidth - 12)) + 'px';
  infoPopover.style.top = Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - infoPopover.offsetHeight - 12)) + 'px';
}
infoPopover.addEventListener('toggle', event => { if (event.newState === 'open') positionInfo(); });
window.addEventListener('resize', positionInfo);
window.addEventListener('scroll', positionInfo, true);
calendar.addEventListener('change', () => {
  if (!calendar.value) {
    calendar.value = selectedDate();
    return;
  }
  if (!calendar.validity.valid) return;
  date.value = d3.utcDay.count(firstDay, new Date(calendar.value + 'T00:00:00Z'));
  date.dispatchEvent(new Event('input'));
});
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
let data;
let selection = 0;
let debounce;
const firstDay = new Date('2020-01-01T00:00:00Z');
const lastDay = d3.utcDay.floor(new Date());
const daySpan = d3.utcDay.count(firstDay, lastDay);
date.max = daySpan;
calendar.max = d3.utcFormat('%Y-%m-%d')(lastDay);
const viewport = document.querySelector('#timeline-viewport');
const track = document.querySelector('#timeline-track');
function revealDate() {
  const x = 8 + Number(date.value) * 3;
  if (x < viewport.scrollLeft + 25 || x > viewport.scrollLeft + viewport.clientWidth - 25) {
    viewport.scrollLeft = Math.max(0, x - viewport.clientWidth / 2);
  }
}
document.querySelector('#today').addEventListener('click', () => {
  date.value = daySpan;
  date.dispatchEvent(new Event('input'));
});
const selectedDate = () => d3.utcFormat('%Y-%m-%d')(d3.utcDay.offset(firstDay, Number(date.value)));

const histogram = d3.select('#detection-histogram');
let countDays = null;
let countsRequested = false;
let timelineWidth = 0;
// Shared by bars, selected-day cursor, slider and calendar ticks. The 8px
// inset matches half of the slider thumb's 16px width.
const timeScale = d3.scaleUtc().domain([firstDay, lastDay]);
function dailyCount(day) {
  if (!day?.groups) return null;
  return d3.sum(day.groups, ([type, score, count]) => enabledTypes.has(type) && (Number(confidence.value) === 0 || score >= Number(confidence.value)) ? count : 0);
}
function drawHistogram() {
  if (!timelineWidth || !countDays) return;
  histogram.attr('viewBox', `0 0 ${timelineWidth} 125`);
  const maxCount = d3.max(countDays, day => d3.sum(day.groups ?? [], group => group[2])) || 1;
  const y = d3.scaleLinear().domain([0, maxCount]).nice().range([115, 12]);
  const barWidth = Math.max(0.5, (timelineWidth - 16) / daySpan * 0.85);
  histogram.selectAll('g.count-grid').data([null]).join('g').attr('class', 'count-grid')
    .selectAll('line').data(y.ticks(3)).join('line')
    .attr('x1', 8).attr('x2', timelineWidth - 8).attr('y1', y).attr('y2', y).attr('stroke', '#e1e7ed');
  histogram.selectAll('rect.day-bar').data(countDays.filter(day => day.groups !== null), day => day.date).join('rect').attr('class', 'day-bar')
    .attr('data-date', day => day.date).attr('data-count', dailyCount)
    .attr('x', day => timeScale(new Date(`${day.date}T00:00:00Z`)) - barWidth / 2)
    .attr('y', day => y(dailyCount(day))).attr('width', barWidth)
    .attr('height', day => y(0) - y(dailyCount(day)))
    .attr('fill', day => day.date === selectedDate() ? DETECTION_COLOR : '#6e879e')
    .selectAll('title').data(day => [day]).join('title')
    .text(day => `${day.date}: ${dailyCount(day).toLocaleString()} California detections passing type and confidence filters`);
  const years = d3.utcYear.range(firstDay, d3.utcDay.offset(lastDay, 1));
  const ticks = years.flatMap(year => y.ticks(3).map(value => ({ year, value })));
  histogram.selectAll('text.count-tick').data(ticks).join('text').attr('class', 'count-tick')
    .attr('x', d => timeScale(d.year) + 2).attr('y', d => y(d.value) - 3).attr('pointer-events', 'none')
    .text(d => d3.format(',d')(d.value));
  histogram.selectAll('rect.missing-day').data(countDays.filter(day => day.groups === null), day => day.date).join('rect')
    .attr('class', 'missing-day').attr('x', day => timeScale(new Date(day.date + 'T00:00:00Z')) - barWidth / 2)
    .attr('y', 112).attr('width', barWidth).attr('height', 5).attr('fill', '#cbd0d5')
    .selectAll('title').data(day => [day]).join('title').text(day => day.date + ': counts unavailable');
  const selectedX = timeScale(d3.utcDay.offset(firstDay, Number(date.value)));
  histogram.selectAll('line.selected-day').data([selectedX]).join('line').attr('class', 'selected-day')
    .attr('x1', d => d).attr('x2', d => d).attr('y1', 5).attr('y2', 120)
    .attr('stroke', DETECTION_COLOR).attr('stroke-width', 1.5).attr('pointer-events', 'none');
  const selected = countDays[Number(date.value)];
  document.querySelector('#histogram-status').textContent = `Daily California detections · ${selectedDate()}: ${dailyCount(selected)?.toLocaleString() ?? 'counts unavailable'} · type and confidence filters applied; statewide, independent of map selection`;
}
histogram.on('click', event => {
  if (!countDays) return;
  const [x] = d3.pointer(event, histogram.node());
  const day = d3.utcDay.round(timeScale.invert(x));
  date.value = Math.max(0, Math.min(daySpan, d3.utcDay.count(firstDay, day)));
  date.dispatchEvent(new Event('input'));
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
      return byDate.get(key) ?? { date: key, groups: null };
    });
    document.querySelector('#data-updated').textContent = 'Downloaded detections and counts updated ' + summary.generatedAt.slice(0, 10) + ' (UTC). Recent records may lack inferred source type; gray timeline marks mean unavailable counts.';
    drawHistogram();
  } catch (error) {
    countsRequested = false;
    document.querySelector('#histogram-status').textContent = `Daily counts unavailable: ${error.message}`;
    document.querySelector('#retry-counts').hidden = false;
  }
}
document.querySelector('#retry-counts').addEventListener('click', loadHistogram);

// Align calendar ticks with the usable slider track, including its thumb inset.
const timeline = d3.select('#timeline-ticks');
function layoutTimeline() {
  // Fixed spacing of 3 CSS pixels/day: adding years increases scroll width,
  // never compresses the bars, slider, or month labels.
  const width = daySpan * 3 + 16;
  track.style.width = width + 'px';
  timelineWidth = width;
  const scale = timeScale.range([8, width - 8]);
  timeline.attr('viewBox', `0 0 ${width} 48`);
  timeline.selectAll('*').remove();
  timeline.append('g').attr('transform', 'translate(0,1)')
    .call(d3.axisBottom(scale).ticks(d3.utcMonth.every(1)).tickFormat(d3.utcFormat('%b')).tickSize(6))
    .call(g => g.select('.domain').remove());
  timeline.selectAll('text.year-label').data(d3.utcYear.range(firstDay, d3.utcDay.offset(lastDay, 1)))
    .join('text').attr('class', 'year-label').attr('x', day => scale(day)).attr('y', 44).text(d3.utcFormat('%Y'));
  drawHistogram();
  revealDate();
}
new ResizeObserver(layoutTimeline).observe(viewport);


scene.append('path').attr('class', 'land').attr('fill', '#e6e6e6');
const clip = svg.append('defs').append('clipPath').attr('id', 'california-clip').append('path');
const aerosols = scene.append('g').attr('clip-path', 'url(#california-clip)');
scene.append('path').attr('class', 'boundary').attr('fill', 'none').attr('stroke', '#444').attr('stroke-width', 1).attr('vector-effect', 'non-scaling-stroke');
const countiesLayer = scene.append('g').attr('class', 'counties').attr('fill', 'none').attr('stroke', '#575757').attr('stroke-opacity', 0.55).attr('pointer-events', 'none');
const fires = scene.append('g');
const brushLayer = svg.append('g').attr('class', 'brush');
const brush = d3.brush().extent([[0, 0], [800, 650]]).on('brush end', event => {
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

function inRegion(d) {
  return !region || (d.longitude >= region[0][0] && d.longitude <= region[1][0] && d.latitude >= region[0][1] && d.latitude <= region[1][1]);
}
function filteredFires() {
  return (data?.days[0].fires ?? []).filter(d => enabledTypes.has(detectionType(d).id) && (Number(confidence.value) === 0 || (d.confidence !== null && d.confidence >= Number(confidence.value))));
}
function updateSelection() {
  fires.selectAll('circle').attr('opacity', d => powerOpacity(d) * (inRegion(d) ? 1 : 0.15));
  aerosols.selectAll('rect').attr('opacity', d => inRegion(d) ? 1 : 0.2);
  document.querySelector('#clear-selection').disabled = !region;
  const summary = document.querySelector('#selection-status');
  if (!region) {
    summary.textContent = 'Toggle Select region to draw a rectangle; scroll to zoom in either mode.';
    return;
  }
  if (!data) { summary.textContent = 'Region selected; waiting for the selected date’s data.'; return; }
  const day = data.days[0];
  const cells = day.aod?.cells.filter(inRegion) ?? [];
  const observed = cells.filter(d => d.value !== null);
  const totalWeight = d3.sum(cells, d => d.weight), observedWeight = d3.sum(observed, d => d.weight);
  const coverage = totalWeight ? observedWeight / totalWeight : 0;
  const mean = coverage >= 0.05 ? d3.sum(observed, d => d.value * d.weight) / observedWeight : null;
  summary.textContent = `Selected region · ${day.fires === null ? 'Detections unavailable' : `${filteredFires().filter(inRegion).length.toLocaleString()} detections passing type and confidence filters`} · ${day.aod ? `${(coverage * 100).toFixed(1)}% AOD coverage` : 'AOD unavailable'} · Mean AOD: ${mean === null ? 'unavailable' : `≈ ${mean.toFixed(2)}`} (area weighted; needs ≥5% coverage)`;
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
const aodLegend = d3.select('#legend').append('svg').attr('viewBox', '0 0 500 85').attr('role', 'img').attr('aria-label', 'AOD bins: below 0.2, 0.2 to 0.5, 0.5 to 1, 1 to 2, and 2 or higher.');
const binLabels = ['0–<0.2', '0.2–<0.5', '0.5–<1', '1–<2', '≥2'];
aodLegend.selectAll('rect').data(color.range()).join('rect').attr('x', (_, i) => 10 + i * 96).attr('y', 10).attr('width', 96).attr('height', 12).attr('fill', d => d);
aodLegend.selectAll('.bin-label').data(binLabels).join('text').attr('class', 'bin-label').attr('x', (_, i) => 58 + i * 96).attr('y', 40).attr('text-anchor', 'middle').text(d => d);
aodLegend.append('text').attr('x', 10).attr('y', 65).text('Aerosol optical depth (approximate)');
const powerLegend = d3.select('#legend').append('svg').attr('viewBox', '0 0 400 100').attr('role', 'img').attr('aria-label', 'Thermal detections use orange markers. Opacity scales linearly with FRP up to full opacity at 100 MW; unknown power uses 50% opacity.');
powerLegend.append('text').attr('x',10).attr('y',65).text('Thermal detections · radiative power (FRP)');
const opacityExamples = [{ frp: 10 }, { frp: 50 }, { frp: 100 }];
powerLegend.selectAll('circle.opacity-example').data(opacityExamples).join('circle').attr('class', 'opacity-example')
  .attr('cx', (_, i) => 15 + i * 130).attr('cy', 26).attr('r', radius).attr('fill', DETECTION_COLOR).attr('opacity', powerOpacity);
powerLegend.selectAll('text.opacity-label').data(opacityExamples).join('text').attr('class', 'opacity-label')
  .attr('x', (_, i) => 28 + i * 130).attr('y', 31).text(d => `${d.frp} MW`);
powerLegend.append('text').attr('x', 10).attr('y', 90).text('Opacity: FRP / 100 MW, capped at 100%');

function render() {
  if (!data) return;
  const day = data.days[0];
  calendar.value = day.date;
  const [west, south, east, north] = CALIFORNIA_BOUNDS;
  const dx = (east - west) / (day.aod?.width ?? 240);
  const dy = (north - south) / (day.aod?.height ?? 223);
  aerosols.selectAll('rect').data(day.aod?.cells.filter(cell => cell.value !== null) ?? []).join('rect')
    .attr('x', d => projection([d.longitude - dx / 2, d.latitude + dy / 2])[0])
    .attr('y', d => projection([d.longitude - dx / 2, d.latitude + dy / 2])[1])
    .attr('width', d => projection([d.longitude + dx / 2, d.latitude])[0] - projection([d.longitude - dx / 2, d.latitude])[0] + 0.05)
    .attr('height', d => projection([d.longitude, d.latitude - dy / 2])[1] - projection([d.longitude, d.latitude + dy / 2])[1] + 0.05)
    .attr('fill', d => color(d.value))
    .selectAll('title').data(d => [d]).join('title').text(d => `AOD ≈ ${d.value.toFixed(3)} (range ${d.lower}–${d.upper})\n${d.latitude.toFixed(2)}°N, ${d.longitude.toFixed(2)}°E`);
  fires.selectAll('circle').data(filteredFires(), d => d.id).join('circle')
    .attr('cx', d => projection([d.longitude, d.latitude])[0]).attr('cy', d => projection([d.longitude, d.latitude])[1])
    .attr('r', radius / d3.zoomTransform(svg.node()).k).attr('fill', DETECTION_COLOR)
    .attr('stroke', DETECTION_COLOR).attr('stroke-width', 0.35).attr('vector-effect', 'non-scaling-stroke').attr('tabindex', 0)
    .selectAll('title').data(d => [d]).join('title').text(d => `${d.date} ${d.acquisitionTime ?? ''} UTC\nType: ${detectionType(d).label} (inferred)\nConfidence: ${d.confidence ?? 'unavailable'}%\nFRP: ${d.frp ?? 'unavailable'} MW\n${d.latitude}°N, ${d.longitude}°E`);
  const errors = Object.entries(day.errors).map(([layer, message]) => `${layer}: ${message}`);
  status.textContent = `${day.date} · ${day.fires === null ? 'Detections unavailable' : `${filteredFires().length.toLocaleString()} of ${day.fires.length.toLocaleString()} detections passing type and confidence filters`} · ${day.aod ? `${(day.aod.coverage * 100).toFixed(1)}% AOD coverage` : 'AOD unavailable'}${errors.length ? ` · ${errors.join('; ')}` : ''}`;
  retry.hidden = !data.days.some(day => Object.keys(day.errors).length);
  visibility();
  updateSelection();
}
date.addEventListener('input', () => {
  // Invalidate earlier results immediately, even during the debounce interval.
  selection++;
  data = null;
  clearTimeout(debounce);
  calendar.value = selectedDate();
  drawHistogram();
  revealDate();
  date.setAttribute('aria-valuetext', selectedDate());
  aerosols.selectAll('rect').remove();
  fires.selectAll('circle').remove();
  updateSelection();
  status.textContent = `Loading MODIS data for ${selectedDate()}…`;
  retry.hidden = true;
  debounce = setTimeout(load, 180);
});

async function load() {
  const version = ++selection;
  const requestedDate = selectedDate();
  retry.hidden = true;
  status.textContent = `Loading MODIS data for ${requestedDate}…`;
  svg.attr('aria-busy', 'true');
  try {
    // Display the outline before imagery arrives; request only this day's layers.
    const [california, counties] = await Promise.all([loadCalifornia(), loadCounties()]);
    if (version !== selection) return;
    projection.fitExtent([[30, 20], [770, 630]], california);
    scene.selectAll('.land, .boundary').datum(california).attr('d', path);
    clip.datum(california).attr('d', path);
    countiesLayer.selectAll('path').data(counties.features).join('path').attr('d', path).attr('stroke-width', 0.6).attr('vector-effect', 'non-scaling-stroke');
    const next = await loadMODIS({ start: requestedDate, end: requestedDate });
    if (version !== selection) return;
    data = next;
    render();
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
