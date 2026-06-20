export type ViewerMode = "hazard" | "heatRisk" | "wards" | "quadrant";

export type RawWardData = {
  wardId: string;
  wardName: string;
  subcounty: string;
  pixelCount: number;
  bins: number[];
  totalPopulation: number;
};

export type WardQuadrantPoint = {
  wardId: string;
  wardName: string;
  subcounty: string;
  population: number;
  heatDays: number;
  personDays: number;
  quadrant: "hot-dense" | "hot-sparse" | "cool-dense" | "cool-sparse";
};

export type ThresholdStats = {
  min: number;
  max: number;
  mean: number;
  p90: number;
};

export type RasterGridMetadata = {
  width: number;
  height: number;
  transform: [number, number, number, number, number, number];
  bounds: [number, number, number, number];
  crs: string;
  nodata: number;
};

export type HazardPixelQueryConfig = {
  endpoint: string;
};

export type RiskPixelQueryConfig = {
  endpoint: string;
};

export type ModeMetadataBase = {
  label: string;
  units: Record<string, string>;
  tileSize: number;
  zoomRange: {
    min: number;
    max: number;
  };
  bounds: [number, number, number, number];
  legendDomain: [number, number];
  legendStops: Array<{
    value: number;
    color: string;
  }>;
  tilesPathTemplate: string;
  rasterGrid: RasterGridMetadata;
  statsByThreshold: Record<string, ThresholdStats>;
  generated: Record<string, number>;
};

export type HazardModeMetadata = ModeMetadataBase & {
  thresholdModeLabel: string;
  definition: string;
  pixelQuery: HazardPixelQueryConfig;
  binEdges: number[];
  binLabels: string[];
};

export type HeatRiskModeMetadata = ModeMetadataBase & {
  formula: string;
  pixelQuery: RiskPixelQueryConfig;
};

export type ViewerMetadata = {
  cityKey: string;
  cityLabel: string;
  availableModes: ViewerMode[];
  defaultMode: ViewerMode;
  defaultThreshold: number;
  thresholds: number[];
  bounds: [number, number, number, number];
  rawDataPaths: {
    hazard: string;
    populationNational: string;
    populationNairobi: string;
    vulnerability: string;
  };
  modes: {
    hazard: HazardModeMetadata;
    heatRisk: HeatRiskModeMetadata;
  };
};

export type HazardPixelDistribution = {
  row: number;
  col: number;
  lng: number;
  lat: number;
  bins: number[];
  hazardDays: number;
};

export type HeatRiskPixelDetail = {
  row: number;
  col: number;
  lng: number;
  lat: number;
  hazard: number;
  population: number;
  vulnerability: number;
  heatRisk: number;
};

export type WardAggregate = {
  wardId: string;
  wardName: string;
  subcounty: string;
  pixelCount: number;
  bins: number[];
};
