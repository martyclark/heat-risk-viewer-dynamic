import type { RawWardData, ViewerMetadata, ViewerMode, WardQuadrantPoint } from "./types";

export type GridTransform = [number, number, number, number, number, number];

export function rowColFromLngLat(
  lng: number,
  lat: number,
  transform: GridTransform,
): { row: number; col: number } {
  const [a, b, c, d, e, f] = transform;
  const det = a * e - b * d;
  if (det === 0) {
    throw new Error("Invalid raster transform");
  }
  const col = (e * (lng - c) - b * (lat - f)) / det;
  const row = (-d * (lng - c) + a * (lat - f)) / det;
  return { row: Math.floor(row), col: Math.floor(col) };
}

export function insideRaster(row: number, col: number, width: number, height: number): boolean {
  return row >= 0 && col >= 0 && row < height && col < width;
}

export function hazardDaysForThreshold(bins: number[], threshold: number): number {
  return bins.reduce((total, value, index) => total + (index >= threshold ? value : 0), 0);
}

export function resolveTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function modeTileUrl(metadata: ViewerMetadata, mode: "hazard" | "heatRisk", threshold: number): string {
  return `/${resolveTemplate(metadata.modes[mode].tilesPathTemplate, {
    threshold,
    z: "{z}",
    x: "{x}",
    y: "{y}",
  })}`;
}

export function hazardPixelUrl(metadata: ViewerMetadata, lng: number, lat: number): string {
  const endpoint = metadata.modes.hazard.pixelQuery.endpoint;
  return `${endpoint}?lng=${lng}&lat=${lat}`;
}

export function riskPixelUrl(metadata: ViewerMetadata, lng: number, lat: number, threshold: number): string {
  const endpoint = metadata.modes.heatRisk.pixelQuery.endpoint;
  return `${endpoint}?lng=${lng}&lat=${lat}&threshold=${threshold}`;
}

export function lngLatFromRasterCell(
  row: number,
  col: number,
  transform: GridTransform,
): { lng: number; lat: number } {
  const [a, b, c, d, e, f] = transform;
  return {
    lng: a * col + b * row + c,
    lat: d * col + e * row + f,
  };
}

export function pixelGeometry(
  row: number,
  col: number,
  transform: GridTransform,
): {
  center: [number, number];
  polygon: [number, number][];
} {
  const topLeft = lngLatFromRasterCell(row, col, transform);
  const topRight = lngLatFromRasterCell(row, col + 1, transform);
  const bottomRight = lngLatFromRasterCell(row + 1, col + 1, transform);
  const bottomLeft = lngLatFromRasterCell(row + 1, col, transform);
  const center = lngLatFromRasterCell(row + 0.5, col + 0.5, transform);

  return {
    center: [center.lng, center.lat],
    polygon: [
      [topLeft.lng, topLeft.lat],
      [topRight.lng, topRight.lat],
      [bottomRight.lng, bottomRight.lat],
      [bottomLeft.lng, bottomLeft.lat],
      [topLeft.lng, topLeft.lat],
    ],
  };
}

export async function fetchAllWardsRaw(cityKey: string): Promise<RawWardData[]> {
  const response = await fetch(`/api/${cityKey}/aggregate/all-wards`);
  if (!response.ok) throw new Error("Failed to load ward aggregates");
  return response.json() as Promise<RawWardData[]>;
}

function listMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function assignQuadrant(
  heatDays: number,
  population: number,
  medianHeatDays: number,
  medianPopulation: number,
): WardQuadrantPoint["quadrant"] {
  const hot = heatDays >= medianHeatDays;
  const dense = population >= medianPopulation;
  if (hot && dense) return "hot-dense";
  if (hot && !dense) return "hot-sparse";
  if (!hot && dense) return "cool-dense";
  return "cool-sparse";
}

export function computeQuadrantPoints(wards: RawWardData[], threshold: number): WardQuadrantPoint[] {
  const points = wards.map((w) => {
    const heatDays = hazardDaysForThreshold(w.bins, threshold);
    return {
      wardId: w.wardId,
      wardName: w.wardName,
      subcounty: w.subcounty,
      population: w.totalPopulation,
      heatDays,
      personDays: w.totalPopulation * heatDays,
    };
  });
  const medianHeatDays = listMedian(points.map((p) => p.heatDays));
  const medianPopulation = listMedian(points.map((p) => p.population));
  return points.map((p) => ({
    ...p,
    quadrant: assignQuadrant(p.heatDays, p.population, medianHeatDays, medianPopulation),
  }));
}
