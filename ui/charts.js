/**
 * Chart.js, wrapped.
 *
 * Consumes a ChartSpec and nothing else — this module never sees a run, a model or an
 * event. That keeps every chart's data identical to the data its table shows.
 *
 * Chart.js is vendored (see vendor/VERSION.json) and loaded as a plain script, so no
 * request leaves the origin. The time scale is deliberately NOT used: it would need
 * `chartjs-adapter-date-fns`, pulling in date-fns, and the model buckets by month anyway —
 * a category scale over pre-formatted labels does the job with one fewer dependency.
 */

import { SERIES_ROLES } from './chartspecs.js';
import { money, moneyAxis } from './format.js';

const charts = new Map();

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Chart.js attaches itself to window; absent means the vendored file did not load. */
function chartLib() {
  const lib = globalThis.Chart;
  if (!lib) {
    throw new Error('Chart.js did not load — check that vendor/chart.umd.js is present.');
  }
  return lib;
}

const colourFor = (role) => SERIES_ROLES[role]?.colour ?? SERIES_ROLES.other.colour;

function cssVar(name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function datasetFor(series, spec) {
  const colour = colourFor(series.role);
  const asLine = series.type === 'line' || spec.type === 'line';

  return {
    label: series.label,
    data: series.values,
    type: asLine ? 'line' : 'bar',
    borderColor: colour,
    backgroundColor: asLine ? 'transparent' : colour,
    borderWidth: asLine ? 2 : 0,
    borderDash: series.dash ?? [],
    pointStyle: series.pointStyle ?? 'circle',
    pointRadius: asLine ? 0 : undefined,
    pointHoverRadius: asLine ? 4 : undefined,
    tension: 0.1,
    // A line drawn over stacked bars must not join the stack.
    stack: asLine ? undefined : 'main',
    order: asLine ? 0 : 1,
  };
}

/** Horizontal reference lines, drawn without a plugin dependency. */
function markerPlugin(spec) {
  if (!spec.markers || spec.markers.length === 0) return null;
  return {
    id: `markers-${spec.id}`,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.y) return;
      ctx.save();
      for (const marker of spec.markers) {
        const y = scales.y.getPixelForValue(marker.value);
        if (!Number.isFinite(y) || y < chartArea.top || y > chartArea.bottom) continue;
        ctx.beginPath();
        ctx.setLineDash(marker.key === 'zero' ? [] : [5, 4]);
        ctx.lineWidth = marker.key === 'zero' ? 1.5 : 1;
        ctx.strokeStyle = colourFor(marker.role);
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

/**
 * Draw a spec into a canvas and return the canvas.
 *
 * The canvas carries `role="img"` and an `aria-label` naming the chart; the real data is
 * in the table beside it, which is why the canvas itself does not try to be readable.
 */
export function renderChart(spec, { height = 260 } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chart-canvas';
  wrapper.style.height = `${height}px`;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${spec.title}. ${spec.description ?? ''} The figures are in the table below.`);
  wrapper.append(canvas);

  let Chart;
  try {
    Chart = chartLib();
  } catch (err) {
    // Without the library the table still carries every number, so degrade rather than fail.
    wrapper.textContent = err.message;
    wrapper.className = 'notice notice-warn';
    return wrapper;
  }

  destroyChart(spec.id);

  const text = cssVar('--text-quiet', '#5c645f');
  const grid = cssVar('--border', '#d5d9d3');

  const chart = new Chart(canvas, {
    data: {
      labels: spec.labels,
      datasets: spec.series.map((series) => datasetFor(series, spec)),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: Boolean(spec.stacked),
          ticks: { color: text, maxRotation: 0, autoSkipPadding: 16 },
          grid: { display: false },
        },
        y: {
          stacked: Boolean(spec.stacked),
          ticks: { color: text, callback: (value) => moneyAxis(value) },
          grid: { color: grid },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: text, usePointStyle: true, boxHeight: 8 },
        },
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${money(item.parsed.y)}`,
          },
        },
      },
    },
    plugins: [markerPlugin(spec)].filter(Boolean),
  });

  charts.set(spec.id, chart);
  return wrapper;
}

/** Charts hold canvases and listeners; drop them before re-rendering a view. */
export function destroyChart(id) {
  const existing = charts.get(id);
  if (existing) {
    existing.destroy();
    charts.delete(id);
  }
}

export function destroyAllCharts() {
  for (const id of [...charts.keys()]) destroyChart(id);
}
