import { useMemo, useRef, useState } from "react";
import type { WardQuadrantPoint } from "../types";

const W = 760;
const H = 460;
const M = { top: 32, right: 170, bottom: 58, left: 74 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

const COLORS: Record<WardQuadrantPoint["quadrant"], string> = {
  "hot-dense": "#d62728",
  "hot-sparse": "#ff7f0e",
  "cool-dense": "#1f77b4",
  "cool-sparse": "#aec7e8",
};

const QUADRANT_META: Record<WardQuadrantPoint["quadrant"], { label: string; desc: string }> = {
  "hot-dense": { label: "Hot + Dense", desc: "Priority: cooling infrastructure" },
  "hot-sparse": { label: "Hot + Sparse", desc: "Heat health surveillance" },
  "cool-dense": { label: "Cool + Dense", desc: "Monitor; lower priority" },
  "cool-sparse": { label: "Cool + Sparse", desc: "Baseline" },
};

function fmtPop(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
}

function linTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const niceStep = Math.ceil(step / mag) * mag;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let t = start; t <= max + niceStep * 0.01; t += niceStep) ticks.push(t);
  return ticks;
}

function logTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  const logMin = Math.floor(Math.log10(Math.max(min, 1)));
  const logMax = Math.ceil(Math.log10(max));
  for (let exp = logMin; exp <= logMax; exp++) {
    for (const mult of [1, 2, 5]) {
      const v = mult * Math.pow(10, exp);
      if (v >= min * 0.9 && v <= max * 1.1) ticks.push(v);
    }
  }
  return ticks;
}

type Props = {
  points: WardQuadrantPoint[];
  threshold: number;
};

export function QuadrantChart({ points, threshold }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { xScale, yScale, medianX, medianY, rScale, xDomain, yDomain, xTicks, yTicks } = useMemo(() => {
    const hd = points.map((p) => p.heatDays);
    const pop = points.map((p) => p.population);
    const pd = points.map((p) => p.personDays);

    const xMin = Math.min(...hd);
    const xMax = Math.max(...hd);
    const yMinRaw = Math.max(1, Math.min(...pop));
    const yMax = Math.max(...pop);
    const pdMax = Math.max(...pd, 1);

    const xPad = (xMax - xMin) * 0.1;
    const xDom: [number, number] = [Math.max(0, xMin - xPad), xMax + xPad];
    // Log scale: add half a log decade of padding on each side
    const logYMin = Math.log10(yMinRaw) - 0.15;
    const logYMax = Math.log10(yMax) + 0.15;
    const yDom: [number, number] = [Math.pow(10, logYMin), Math.pow(10, logYMax)];

    const medHD = [...hd].sort((a, b) => a - b)[Math.floor(hd.length / 2)];
    const medPop = [...pop].sort((a, b) => a - b)[Math.floor(pop.length / 2)];

    const xs = (v: number) => M.left + ((v - xDom[0]) / (xDom[1] - xDom[0])) * IW;
    // Y axis: log scale — population spread evenly on log axis
    const ys = (v: number) => {
      const logV = Math.log10(Math.max(v, yDom[0]));
      return M.top + IH - ((logV - logYMin) / (logYMax - logYMin)) * IH;
    };

    return {
      xScale: xs,
      yScale: ys,
      medianX: xs(medHD),
      medianY: ys(medPop),
      rScale: (pd: number) => 4 + Math.sqrt(pd / pdMax) * 13,
      xDomain: xDom,
      yDomain: yDom,
      xTicks: linTicks(xDom[0], xDom[1], 5),
      yTicks: logTicks(yDom[0], yDom[1]),
    };
  }, [points]);

  const labeledIds = useMemo(
    () => new Set([...points].sort((a, b) => b.personDays - a.personDays).slice(0, 8).map((p) => p.wardId)),
    [points],
  );

  const hoveredPoint = hoveredId ? points.find((p) => p.wardId === hoveredId) : null;

  const quadrantCounts = useMemo(() => {
    const counts: Record<WardQuadrantPoint["quadrant"], number> = {
      "hot-dense": 0, "hot-sparse": 0, "cool-dense": 0, "cool-sparse": 0,
    };
    for (const p of points) counts[p.quadrant]++;
    return counts;
  }, [points]);

  return (
    <div className="quadrant-chart-wrap">
      <div className="quadrant-header">
        <p className="eyebrow">Ward-level analysis</p>
        <h2>Population vs. heat days — {threshold}°C threshold</h2>
        <div className="quadrant-counts">
          {(Object.entries(QUADRANT_META) as [WardQuadrantPoint["quadrant"], typeof QUADRANT_META[keyof typeof QUADRANT_META]][]).map(([q, meta]) => (
            <div key={q} className="quadrant-count-pill" style={{ borderColor: COLORS[q] }}>
              <span className="quadrant-count-dot" style={{ background: COLORS[q] }} />
              <span className="quadrant-count-label">{meta.label}</span>
              <strong className="quadrant-count-n">{quadrantCounts[q]}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="quadrant-svg-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="quadrant-chart-svg"
          role="img"
          aria-label="Quadrant scatter chart of ward population vs heat days"
        >
          {/* Quadrant background regions */}
          <rect x={M.left} y={M.top} width={medianX - M.left} height={medianY - M.top}
            fill="rgba(31,119,180,0.05)" />
          <rect x={medianX} y={M.top} width={M.left + IW - medianX} height={medianY - M.top}
            fill="rgba(214,39,40,0.05)" />
          <rect x={M.left} y={medianY} width={medianX - M.left} height={M.top + IH - medianY}
            fill="rgba(174,199,232,0.07)" />
          <rect x={medianX} y={medianY} width={M.left + IW - medianX} height={M.top + IH - medianY}
            fill="rgba(255,127,14,0.05)" />

          {/* Quadrant corner labels */}
          <text x={medianX - 8} y={M.top + 14} textAnchor="end" className="chart-label quadrant-region-label" fill="rgba(31,119,180,0.55)">Cool + Dense</text>
          <text x={medianX + 8} y={M.top + 14} textAnchor="start" className="chart-label quadrant-region-label" fill="rgba(214,39,40,0.55)">Hot + Dense</text>
          <text x={medianX - 8} y={M.top + IH - 8} textAnchor="end" className="chart-label quadrant-region-label" fill="rgba(174,199,232,0.9)">Cool + Sparse</text>
          <text x={medianX + 8} y={M.top + IH - 8} textAnchor="start" className="chart-label quadrant-region-label" fill="rgba(255,127,14,0.7)">Hot + Sparse</text>

          {/* Axes */}
          <line x1={M.left} y1={M.top} x2={M.left} y2={M.top + IH} className="chart-axis" />
          <line x1={M.left} y1={M.top + IH} x2={M.left + IW} y2={M.top + IH} className="chart-axis" />

          {/* X grid + ticks */}
          {xTicks.map((t) => {
            const x = xScale(t);
            return (
              <g key={t}>
                <line x1={x} y1={M.top} x2={x} y2={M.top + IH} className="chart-grid" />
                <text x={x} y={M.top + IH + 16} textAnchor="middle" className="chart-label chart-label-small">
                  {t.toFixed(0)}
                </text>
              </g>
            );
          })}

          {/* Y grid + ticks */}
          {yTicks.map((t) => {
            const y = yScale(t);
            return (
              <g key={t}>
                <line x1={M.left} y1={y} x2={M.left + IW} y2={y} className="chart-grid" />
                <text x={M.left - 8} y={y + 4} textAnchor="end" className="chart-label chart-label-small">
                  {fmtPop(t)}
                </text>
              </g>
            );
          })}

          {/* Median dividers */}
          <line x1={medianX} y1={M.top} x2={medianX} y2={M.top + IH} className="chart-threshold" />
          <line x1={M.left} y1={medianY} x2={M.left + IW} y2={medianY} className="chart-threshold" />

          {/* Axis labels */}
          <text x={M.left + IW / 2} y={H - 4} textAnchor="middle" className="chart-label" fill="rgba(16,35,61,0.75)">
            Heat days above {threshold}°C
          </text>
          <text
            x={14}
            y={M.top + IH / 2}
            textAnchor="middle"
            className="chart-label"
            fill="rgba(16,35,61,0.75)"
            transform={`rotate(-90, 14, ${M.top + IH / 2})`}
          >
            Population (log scale)
          </text>

          {/* Points — render in two passes: unselected then hovered on top */}
          {points
            .filter((p) => p.wardId !== hoveredId)
            .map((p) => {
              const cx = xScale(p.heatDays);
              const cy = yScale(p.population);
              const r = rScale(p.personDays);
              return (
                <circle
                  key={p.wardId}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={COLORS[p.quadrant]}
                  fillOpacity={0.72}
                  stroke="white"
                  strokeWidth={1}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoveredId(p.wardId)}
                  onMouseLeave={() => setHoveredId(null)}
                />
              );
            })}

          {/* Point labels for top-N wards */}
          {points
            .filter((p) => labeledIds.has(p.wardId) && p.wardId !== hoveredId)
            .map((p) => {
              const cx = xScale(p.heatDays);
              const cy = yScale(p.population);
              const r = rScale(p.personDays);
              const name = p.wardName.replace(" Ward", "");
              return (
                <text
                  key={p.wardId}
                  x={cx}
                  y={cy - r - 4}
                  textAnchor="middle"
                  className="chart-label chart-label-small"
                  fill={COLORS[p.quadrant]}
                  style={{ pointerEvents: "none" }}
                >
                  {name}
                </text>
              );
            })}

          {/* Hovered point on top */}
          {hoveredPoint && (() => {
            const cx = xScale(hoveredPoint.heatDays);
            const cy = yScale(hoveredPoint.population);
            const r = rScale(hoveredPoint.personDays);
            const name = hoveredPoint.wardName.replace(" Ward", "");
            const lines = [
              hoveredPoint.wardName,
              hoveredPoint.subcounty,
              `${hoveredPoint.heatDays.toFixed(1)} heat days`,
              `Pop: ${fmtPop(hoveredPoint.population)}`,
              `Person-days: ${fmtPop(hoveredPoint.personDays)}`,
            ];
            const tw = 160;
            const th = lines.length * 16 + 12;
            const tx = Math.min(cx + r + 8, M.left + IW - tw - 4);
            const ty = Math.max(cy - th / 2, M.top);

            return (
              <g>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r + 2}
                  fill={COLORS[hoveredPoint.quadrant]}
                  fillOpacity={0.9}
                  stroke="white"
                  strokeWidth={2}
                  style={{ cursor: "pointer" }}
                  onMouseLeave={() => setHoveredId(null)}
                />
                <text
                  x={cx}
                  y={cy - r - 5}
                  textAnchor="middle"
                  className="chart-label chart-label-small"
                  fill={COLORS[hoveredPoint.quadrant]}
                  fontWeight="700"
                  style={{ pointerEvents: "none" }}
                >
                  {name}
                </text>
                {/* Tooltip box */}
                <rect x={tx} y={ty} width={tw} height={th} rx={6}
                  fill="white" stroke={COLORS[hoveredPoint.quadrant]} strokeWidth={1.5}
                  style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.12))" }} />
                {lines.map((line, i) => (
                  <text
                    key={i}
                    x={tx + 10}
                    y={ty + 16 + i * 16}
                    className="chart-label chart-label-small"
                    fill={i === 0 ? "#10233d" : "rgba(16,35,61,0.65)"}
                    fontWeight={i === 0 ? "600" : "400"}
                    style={{ pointerEvents: "none" }}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          })()}

          {/* Legend */}
          {(Object.entries(QUADRANT_META) as [WardQuadrantPoint["quadrant"], typeof QUADRANT_META[keyof typeof QUADRANT_META]][]).map(([q, meta], i) => (
            <g key={q} transform={`translate(${M.left + IW + 18}, ${M.top + i * 48})`}>
              <circle cx={8} cy={8} r={7} fill={COLORS[q]} fillOpacity={0.8} />
              <text x={20} y={12} className="chart-label" fill="#10233d" fontWeight="600" fontSize="11">{meta.label}</text>
              <text x={20} y={26} className="chart-label chart-label-small" fill="rgba(16,35,61,0.55)" fontSize="10">{meta.desc}</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
