import { fmt, rupiah, esc } from './pos-utils.mjs';

export function reportDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateWithinReportPeriod(iso, period, chosen, now = new Date()) {
  const date = new Date(iso), day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'all') return true;
  if (period === 'today') {
    const start = new Date(`${chosen}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return date >= start && date < end;
  }
  if (period === 'week') {
    const start = new Date(day);
    start.setDate(start.getDate() - 6);
    return date >= start;
  }
  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

export function reportChartSvg(series, { money = false, color = '#2563EB', label = 'Nilai' } = {}) {
  if (!series.length) return '<div class="report-chart-empty">Belum ada data pada periode ini.</div>';
  const width = 640, height = 270, left = 72, right = 18, top = 18, bottom = 58, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(0, ...series.map(point => Number(point.value) || 0)), ceiling = maximum ? maximum * 1.12 : 1;
  const points = series.map((point, index) => ({ x: left + (series.length === 1 ? plotWidth / 2 : index * plotWidth / (series.length - 1)), y: top + plotHeight - (Number(point.value) || 0) / ceiling * plotHeight, source: point }));
  const path = points.reduce((value, point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1], middle = (previous.x + point.x) / 2;
    return `${value} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, '');
  const step = Math.max(1, Math.ceil(series.length / 6));
  const axisValue = value => money ? (value >= 1_000_000 ? `Rp ${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} jt` : value >= 1_000 ? `Rp ${Math.round(value / 1_000)} rb` : `Rp ${Math.round(value)}`) : fmt.format(Math.round(value));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling * (4 - index) / 4, y = top + plotHeight * index / 4;
    return `<g><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#E7EBF2"/><text x="${left - 8}" y="${y + 4}" text-anchor="end">${esc(axisValue(value))}</text></g>`;
  }).join('');
  const dots = points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="3.5" fill="${color}"><title>${esc(point.source.label)}: ${esc(money ? rupiah(point.source.value) : `${fmt.format(point.source.value)} ${label}`)}</title></circle>`).join('');
  const labels = series.map((point, index) => index % step === 0 || index === series.length - 1 ? `<text x="${points[index].x}" y="${height - 18}" text-anchor="middle"><title>${esc(point.label)}</title>${esc(point.shortLabel || point.label)}</text>` : '').join('');
  return `<svg class="report-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><g class="report-chart-gridlines">${grid}</g><path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg>`;
}

export function reportMonthKey(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function currentReportMonth() {
  return reportMonthKey(new Date());
}

export function buildSalesTrend(sales, monthValue) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthValue || ''));
  if (!match) return [];
  const year = Number(match[1]), month = Number(match[2]);
  if (month < 1 || month > 12) return [];
  const points = Array.from({ length: new Date(year, month, 0).getDate() }, (_, index) => {
    const date = new Date(year, month - 1, index + 1);
    return { key: reportDateKey(date), label: date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }), shortLabel: String(index + 1), value: 0 };
  });
  const byDate = new Map(points.map(point => [point.key, point]));
  sales.forEach(sale => { const point = byDate.get(reportDateKey(new Date(sale.at))); if (point) point.value += Number(sale.total) || 0; });
  return points;
}
