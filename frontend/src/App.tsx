import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { DistributionChart } from "./components/DistributionChart";
import { HazardLegend } from "./components/HazardLegend";
import { HeatRiskDetailPanel } from "./components/HeatRiskDetailPanel";
import { QuadrantChart } from "./components/QuadrantChart";
import { StatsPanel } from "./components/StatsPanel";
import { WardDetailPanel } from "./components/WardDetailPanel";
import {
  computeQuadrantPoints,
  fetchAllWardsRaw,
  hazardDaysForThreshold,
  hazardPixelUrl,
  insideRaster,
  modeTileUrl,
  pixelGeometry,
  riskPixelUrl,
  rowColFromLngLat,
} from "./lib";
import type {
  HeatRiskPixelDetail,
  HazardPixelDistribution,
  RawWardData,
  ViewerMetadata,
  ViewerMode,
  WardAggregate,
} from "./types";

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const PIXEL_SOURCE_ID = "selected-pixel";
const WARD_SOURCE_ID = "wards";
const HAZARD_TARGET_OPACITY = 0.68;
const HAZARD_SWITCH_DURATION_MS = 420;

type SelectedHazardBase = Omit<HazardPixelDistribution, "hazardDays">;
type SelectedRiskLocation = Omit<HeatRiskPixelDetail, "hazard" | "population" | "vulnerability" | "heatRisk">;

function emptyPixelFeatureCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [],
  };
}

function pixelFeatureCollection(
  row: number,
  col: number,
  transform: ViewerMetadata["modes"]["hazard"]["rasterGrid"]["transform"],
) {
  const geometry = pixelGeometry(row, col, transform);
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "pixel" },
        geometry: {
          type: "Polygon" as const,
          coordinates: [geometry.polygon],
        },
      },
      {
        type: "Feature" as const,
        properties: { kind: "center" },
        geometry: {
          type: "Point" as const,
          coordinates: geometry.center,
        },
      },
    ],
  };
}

function layerIdFor(mode: ViewerMode, threshold: number): string {
  return `${mode}-layer-${threshold}`;
}

function sourceIdFor(mode: ViewerMode, threshold: number): string {
  return `${mode}-source-${threshold}`;
}

function findRasterInsertBeforeId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers ?? [];
  const preferredLayer = layers.find((layer) => {
    const id = layer.id.toLowerCase();
    return layer.type === "line" && /boundary|admin|place|label/.test(id);
  });
  if (preferredLayer) {
    return preferredLayer.id;
  }
  return layers.find((layer) => layer.type === "symbol")?.id;
}

function hideInactiveRasterLayers(
  map: MapLibreMap,
  metadata: ViewerMetadata,
  activeMode: ViewerMode,
  activeThreshold: number,
) {
  for (const mode of metadata.availableModes) {
    for (const threshold of metadata.thresholds) {
      const layerId = layerIdFor(mode, threshold);
      if (!map.getLayer(layerId)) {
        continue;
      }
      const visible = mode === activeMode && threshold === activeThreshold;
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      map.setPaintProperty(layerId, "raster-opacity", visible ? HAZARD_TARGET_OPACITY : 0);
    }
  }
}

function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const currentVisibleLayerKeyRef = useRef<string | null>(null);
  const thresholdHideTimeoutRef = useRef<number | null>(null);
  const activeModeRef = useRef<ViewerMode>("hazard");
  const activeThresholdRef = useRef(25);
  const riskRequestTokenRef = useRef(0);

  const [metadata, setMetadata] = useState<ViewerMetadata | null>(null);
  const [mode, setMode] = useState<ViewerMode>("hazard");
  const [threshold, setThreshold] = useState(25);
  const [selectedHazardPixel, setSelectedHazardPixel] = useState<SelectedHazardBase | null>(null);
  const [selectedRiskLocation, setSelectedRiskLocation] = useState<SelectedRiskLocation | null>(null);
  const [selectedRiskDetail, setSelectedRiskDetail] = useState<HeatRiskPixelDetail | null>(null);
  const [wardAggregate, setWardAggregate] = useState<WardAggregate | null>(null);
  const wardCacheRef = useRef<Map<string, WardAggregate>>(new Map());
  const [statusText, setStatusText] = useState("Loading metadata...");
  const [allWardsRaw, setAllWardsRaw] = useState<RawWardData[] | null>(null);
  const [quadrantLoading, setQuadrantLoading] = useState(false);

  activeModeRef.current = mode;
  activeThresholdRef.current = threshold;

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      const response = await fetch("/api/nairobi/metadata");
      if (!response.ok) {
        throw new Error("Failed to load metadata from API");
      }

      const payload = (await response.json()) as Partial<ViewerMetadata>;
      if (cancelled) {
        return;
      }

      if (
        !payload
        || !payload.modes
        || !payload.modes.hazard
        || !payload.modes.heatRisk
        || !payload.availableModes
        || payload.defaultMode === undefined
        || payload.defaultThreshold === undefined
      ) {
        throw new Error("Metadata from API is incomplete. Run `npm run data:prepare` and restart the backend.");
      }

      setMetadata(payload as ViewerMetadata);
      setMode(payload.defaultMode);
      setThreshold(payload.defaultThreshold);
      setStatusText("Click the map to inspect a pixel.");
    }

    loadMetadata().catch((error: Error) => {
      if (!cancelled) {
        setStatusText(error.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadHazardDistribution(
    viewerMetadata: ViewerMetadata,
    row: number,
    col: number,
    lng: number,
    lat: number,
  ) {
    const response = await fetch(hazardPixelUrl(viewerMetadata, lng, lat));
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: "Failed to load hazard data." }));
      throw new Error(err.detail ?? "Failed to load hazard data.");
    }
    const data = await response.json() as { row: number; col: number; bins: number[] };
    return { row: data.row, col: data.col, lng, lat, bins: data.bins } satisfies SelectedHazardBase;
  }

  async function loadRiskDetail(
    viewerMetadata: ViewerMetadata,
    row: number,
    col: number,
    lng: number,
    lat: number,
    targetThreshold: number,
  ) {
    const token = riskRequestTokenRef.current + 1;
    riskRequestTokenRef.current = token;

    const response = await fetch(riskPixelUrl(viewerMetadata, lng, lat, targetThreshold));
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: "Failed to load heat risk data." }));
      throw new Error(err.detail ?? "Failed to load heat risk data.");
    }

    if (token !== riskRequestTokenRef.current) {
      return null;
    }

    const data = await response.json() as HeatRiskPixelDetail;
    return data;
  }

  useEffect(() => {
    if (!metadata || !mapContainerRef.current || mapRef.current) {
      return;
    }

    const bounds = metadata.bounds as LngLatBoundsLike;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: BASEMAP_STYLE,
      bounds,
      fitBoundsOptions: { padding: 36 },
      maxBounds: bounds,
      minZoom: metadata.modes.hazard.zoomRange.min,
      maxZoom: Math.max(metadata.modes.hazard.zoomRange.max, metadata.modes.heatRisk.zoomRange.max) + 1,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      const insertBeforeId = findRasterInsertBeforeId(map);

      for (const availableMode of metadata.availableModes as Array<"hazard" | "heatRisk">) {
        const modeMetadata = metadata.modes[availableMode];
        for (const thresholdValue of metadata.thresholds) {
          map.addSource(sourceIdFor(availableMode, thresholdValue), {
            type: "raster",
            tiles: [modeTileUrl(metadata, availableMode, thresholdValue)],
            tileSize: modeMetadata.tileSize,
            bounds: modeMetadata.bounds,
            minzoom: modeMetadata.zoomRange.min,
            maxzoom: modeMetadata.zoomRange.max,
          });

          const isInitiallyVisible =
            availableMode === metadata.defaultMode && thresholdValue === metadata.defaultThreshold;

          map.addLayer(
            {
              id: layerIdFor(availableMode, thresholdValue),
              type: "raster",
              source: sourceIdFor(availableMode, thresholdValue),
              layout: {
                visibility: isInitiallyVisible ? "visible" : "none",
              },
              paint: {
                "raster-opacity": isInitiallyVisible ? HAZARD_TARGET_OPACITY : 0,
                "raster-resampling": "linear",
                "raster-fade-duration": 0,
                "raster-opacity-transition": {
                  duration: HAZARD_SWITCH_DURATION_MS,
                  delay: 0,
                },
              },
            },
            insertBeforeId,
          );
        }
      }

      currentVisibleLayerKeyRef.current = `${metadata.defaultMode}:${metadata.defaultThreshold}`;

      map.addSource(PIXEL_SOURCE_ID, {
        type: "geojson",
        data: emptyPixelFeatureCollection(),
      });

      map.addLayer({
        id: "selected-pixel-fill",
        type: "fill",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "pixel"],
        paint: {
          "fill-color": "#2f80ed",
          "fill-opacity": 0.12,
        },
      });

      map.addLayer({
        id: "selected-pixel-outline",
        type: "line",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "pixel"],
        paint: {
          "line-color": "#165dff",
          "line-width": 2,
          "line-opacity": 0.95,
        },
      });

      map.addLayer({
        id: "selected-pixel-center",
        type: "circle",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "center"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#165dff",
        },
      });

      map.once("idle", () => {
        map.setMinZoom(map.getZoom());
      });
    });

    map.on("click", async (event) => {
      const currentMode = activeModeRef.current;
      const currentThreshold = activeThresholdRef.current;
      const lng = event.lngLat.lng;
      const lat = event.lngLat.lat;

      try {
        if (currentMode === "wards") {
          const features = map.queryRenderedFeatures(event.point, { layers: ["ward-fill"] });
          if (features.length === 0) return;
          const props = features[0].properties as Record<string, unknown>;
          const wardId = String(props["gid"]);
          const wardName = String(props["ward"]);

          // Highlight hovered ward
          map.setFilter("ward-fill-hover", ["==", ["get", "gid"], props["gid"] as string]);

          // Use cache if available
          if (wardCacheRef.current.has(wardId)) {
            setWardAggregate(wardCacheRef.current.get(wardId)!);
            return;
          }

          setStatusText(`Loading data for ${wardName}...`);
          const response = await fetch(`/api/${metadata.cityKey}/aggregate/hazard/${wardId}`);
          if (!response.ok) throw new Error("Failed to load ward aggregate.");
          const agg = await response.json() as WardAggregate;
          wardCacheRef.current.set(wardId, agg);
          setWardAggregate(agg);
          setStatusText("Click a ward to inspect its temperature distribution.");
          return;
        }

        if (currentMode === "hazard") {
          const hazardGrid = metadata.modes.hazard.rasterGrid;
          const { row, col } = rowColFromLngLat(lng, lat, hazardGrid.transform);
          if (!insideRaster(row, col, hazardGrid.width, hazardGrid.height)) {
            throw new Error("The clicked location is outside the hazard raster extent.");
          }
          setStatusText("Loading hazard distribution...");
          const distribution = await loadHazardDistribution(metadata, row, col, lng, lat);
          setSelectedHazardPixel(distribution);
          setStatusText("Click another location to inspect a different hazard pixel.");
          return;
        }

        const riskGrid = metadata.modes.heatRisk.rasterGrid;
        const { row, col } = rowColFromLngLat(lng, lat, riskGrid.transform);
        if (!insideRaster(row, col, riskGrid.width, riskGrid.height)) {
          throw new Error("The clicked location is outside the heat risk raster extent.");
        }
        setStatusText("Loading heat risk detail...");
        const detail = await loadRiskDetail(metadata, row, col, lng, lat, currentThreshold);
        if (!detail) {
          return;
        }
        setSelectedRiskLocation({ row, col, lng, lat });
        setSelectedRiskDetail(detail);
        setStatusText("Click another location to inspect a different heat risk cell.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to inspect the selected location.";
        setStatusText(message);
        if (currentMode === "hazard") {
          setSelectedHazardPixel(null);
        } else if (currentMode === "heatRisk") {
          setSelectedRiskLocation(null);
          setSelectedRiskDetail(null);
        }
      }
    });

    mapRef.current = map;

    return () => {
      if (thresholdHideTimeoutRef.current !== null) {
        window.clearTimeout(thresholdHideTimeoutRef.current);
      }
      map.remove();
      mapRef.current = null;
      currentVisibleLayerKeyRef.current = null;
    };
  }, [metadata]);

  useEffect(() => {
    if (!metadata) {
      return;
    }
    if (mode === "hazard" && !selectedHazardPixel) {
      setStatusText("Click the map to inspect a hazard pixel.");
    }
    if (mode === "heatRisk" && !selectedRiskLocation) {
      setStatusText("Click the map to inspect a heat risk cell.");
    }
    if (mode === "wards" && !wardAggregate) {
      setStatusText("Click a ward to inspect its temperature distribution.");
    }
  }, [metadata, mode, selectedHazardPixel, selectedRiskLocation, wardAggregate]);

  const tileMode: "hazard" | "heatRisk" = (mode === "wards" || mode === "quadrant") ? "hazard" : mode;
  const currentModeMetadata = useMemo(() => (metadata ? metadata.modes[tileMode] : null), [metadata, tileMode]);

  const quadrantPoints = useMemo(
    () => (allWardsRaw ? computeQuadrantPoints(allWardsRaw, threshold) : []),
    [allWardsRaw, threshold],
  );

  useEffect(() => {
    if (mode !== "quadrant" || allWardsRaw || quadrantLoading || !metadata) return;
    setQuadrantLoading(true);
    fetchAllWardsRaw(metadata.cityKey)
      .then((data) => { setAllWardsRaw(data); setQuadrantLoading(false); })
      .catch(() => { setQuadrantLoading(false); setStatusText("Failed to load ward data for quadrant chart."); });
  }, [mode, allWardsRaw, quadrantLoading, metadata]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !metadata) {
      return;
    }

    const nextLayerKey = `${tileMode}:${threshold}`;
    const previousLayerKey = currentVisibleLayerKeyRef.current;

    if (thresholdHideTimeoutRef.current !== null) {
      window.clearTimeout(thresholdHideTimeoutRef.current);
      thresholdHideTimeoutRef.current = null;
    }

    const nextLayer = layerIdFor(tileMode, threshold);
    if (!map.getLayer(nextLayer)) {
      return;
    }

    if (previousLayerKey === nextLayerKey) {
      return;
    }

    map.setLayoutProperty(nextLayer, "visibility", "visible");
    map.setPaintProperty(nextLayer, "raster-opacity", HAZARD_TARGET_OPACITY);

    if (previousLayerKey) {
      const [previousMode, previousThreshold] = previousLayerKey.split(":");
      const previousLayer = layerIdFor(previousMode as ViewerMode, Number(previousThreshold));
      if (map.getLayer(previousLayer)) {
        map.setLayoutProperty(previousLayer, "visibility", "visible");
        map.setPaintProperty(previousLayer, "raster-opacity", 0);
      }
    }

    currentVisibleLayerKeyRef.current = nextLayerKey;
    thresholdHideTimeoutRef.current = window.setTimeout(() => {
      hideInactiveRasterLayers(map, metadata, tileMode, threshold);
      thresholdHideTimeoutRef.current = null;
    }, HAZARD_SWITCH_DURATION_MS + 120);
  }, [threshold, metadata, mode, tileMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !metadata) {
      return;
    }

    const source = map.getSource(PIXEL_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) {
      return;
    }

    if (mode === "hazard" && selectedHazardPixel) {
      source.setData(pixelFeatureCollection(selectedHazardPixel.row, selectedHazardPixel.col, metadata.modes.hazard.rasterGrid.transform));
      return;
    }

    if (mode === "heatRisk" && selectedRiskLocation) {
      source.setData(pixelFeatureCollection(selectedRiskLocation.row, selectedRiskLocation.col, metadata.modes.heatRisk.rasterGrid.transform));
      return;
    }

    source.setData(emptyPixelFeatureCollection());
  }, [metadata, mode, selectedHazardPixel, selectedRiskLocation]);

  useEffect(() => {
    if (!metadata || !selectedRiskLocation) {
      return;
    }

    const viewerMetadata = metadata;
    const riskLocation = selectedRiskLocation;
    let cancelled = false;

    async function refreshRiskDetail() {
      try {
        const detail = await loadRiskDetail(
          viewerMetadata,
          riskLocation.row,
          riskLocation.col,
          riskLocation.lng,
          riskLocation.lat,
          threshold,
        );
        if (!cancelled && detail) {
          setSelectedRiskDetail(detail);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Failed to refresh heat risk detail.";
          setStatusText(message);
          setSelectedRiskDetail(null);
        }
      }
    }

    refreshRiskDetail();

    return () => {
      cancelled = true;
    };
  }, [threshold, metadata, selectedRiskLocation]);

  const currentStats = useMemo(() => {
    if (!currentModeMetadata) {
      return null;
    }
    return currentModeMetadata.statsByThreshold[String(threshold)];
  }, [currentModeMetadata, threshold]);

  const displayedHazardPixel = useMemo<HazardPixelDistribution | null>(() => {
    if (!selectedHazardPixel) {
      return null;
    }
    return {
      ...selectedHazardPixel,
      hazardDays: hazardDaysForThreshold(selectedHazardPixel.bins, threshold),
    };
  }, [threshold, selectedHazardPixel]);

  // Fetch ward GeoJSON the first time wards mode is entered
  useEffect(() => {
    if (mode !== "wards" || !metadata) return;
    const map = mapRef.current;
    if (!map || map.getSource(WARD_SOURCE_ID)) return;

    fetch(`/api/${metadata.cityKey}/wards`)
      .then((r) => r.json())
      .then((geojson) => {
        if (!mapRef.current) return;
        const m = mapRef.current;
        if (m.getSource(WARD_SOURCE_ID)) return;
        m.addSource(WARD_SOURCE_ID, { type: "geojson", data: geojson });
        m.addLayer({
          id: "ward-fill",
          type: "fill",
          source: WARD_SOURCE_ID,
          paint: { "fill-color": "#2860b0", "fill-opacity": 0.08 },
        });
        m.addLayer({
          id: "ward-line",
          type: "line",
          source: WARD_SOURCE_ID,
          paint: { "line-color": "#2860b0", "line-width": 1.5 },
        });
        m.addLayer({
          id: "ward-fill-hover",
          type: "fill",
          source: WARD_SOURCE_ID,
          paint: { "fill-color": "#2860b0", "fill-opacity": 0.22 },
          filter: ["==", ["get", "gid"], -1],
        });
      })
      .catch(() => setStatusText("Failed to load ward boundaries."));
  }, [mode, metadata]);

  // Toggle ward layer visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vis = mode === "wards" ? "visible" : "none";
    for (const id of ["ward-fill", "ward-line", "ward-fill-hover"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
  }, [mode]);

  if (!metadata || !currentModeMetadata) {
    return <div className="loading-shell">{statusText}</div>;
  }

  return (
    <div className="app-shell">
      <main className="viewer-layout">
        <section className="map-stage">
          <div className="map-header">
            <div>
              <p className="eyebrow">Heat Threshold Explorer</p>
              <h1>
                {mode === "quadrant"
                  ? `${metadata.cityLabel} ward quadrant analysis`
                  : `${metadata.cityLabel} hazard and risk viewer`}
              </h1>
            </div>
            {mode !== "quadrant" && (
              <div className="map-meta">
                <span>{mode === "hazard" ? metadata.rawDataPaths.hazard : metadata.rawDataPaths.populationNairobi}</span>
                <span>{currentModeMetadata.generated.tilesWritten.toLocaleString("en-US")} tiles generated</span>
              </div>
            )}
          </div>
          <div
            ref={mapContainerRef}
            className="map-canvas"
            style={mode === "quadrant" ? { display: "none" } : undefined}
          />
          {mode === "quadrant" && (
            quadrantLoading ? (
              <div className="quadrant-loading">Loading ward data&hellip;</div>
            ) : quadrantPoints.length > 0 ? (
              <QuadrantChart points={quadrantPoints} threshold={threshold} />
            ) : null
          )}
        </section>

        <aside className="control-panel">
          <section className="panel-block panel-hero">
            <p className="eyebrow">Viewer</p>
            <h2>
              {mode === "hazard"
                ? "Hazard mode"
                : mode === "heatRisk"
                  ? "Heat risk mode"
                  : mode === "quadrant"
                    ? `Quadrant — ${threshold}°C`
                    : "Ward aggregation"}
            </h2>
            <div className="mode-toggle four-col" role="tablist" aria-label="Viewer mode">
              <button
                type="button"
                className={mode === "hazard" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("hazard")}
              >
                Hazard
              </button>
              <button
                type="button"
                className={mode === "heatRisk" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("heatRisk")}
              >
                Heat Risk
              </button>
              <button
                type="button"
                className={mode === "wards" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("wards")}
              >
                Wards
              </button>
              <button
                type="button"
                className={mode === "quadrant" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("quadrant")}
              >
                Quadrant
              </button>
            </div>
            <p className="panel-copy">
              {mode === "hazard"
                ? metadata.modes.hazard.definition
                : mode === "heatRisk"
                  ? metadata.modes.heatRisk.formula
                  : mode === "quadrant"
                    ? "Ward scatter plot — population vs. heat days, divided by city medians into four risk quadrants."
                    : "Mean temperature distribution aggregated across all pixels within each ward boundary."}
            </p>
            <div className="threshold-slider">
              <span>Temperature threshold</span>
              <strong>{threshold}°C</strong>
              <input
                type="range"
                aria-label="Temperature threshold"
                min={metadata.thresholds[0]}
                max={metadata.thresholds[metadata.thresholds.length - 1]}
                step={1}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="threshold-footnote">
              <span>0°C</span>
              <span>50°C</span>
            </div>
          </section>

          {currentStats ? (
            <StatsPanel
              title={mode === "hazard" ? "Hazard summary" : "Heat risk summary"}
              subtitle={mode === "hazard" ? "Valid hazard pixels" : "Valid 100m risk cells"}
              stats={currentStats}
            />
          ) : null}

          <HazardLegend
            title={mode === "hazard" ? "Hazard legend" : "Heat risk legend"}
            unitLabel={mode === "hazard" ? "days" : "risk"}
            domain={currentModeMetadata.legendDomain}
            stops={currentModeMetadata.legendStops}
          />

          {mode === "wards" ? (
            wardAggregate ? (
              <WardDetailPanel
                aggregate={wardAggregate}
                threshold={threshold}
                labels={metadata.modes.hazard.binLabels}
              />
            ) : (
              <section className="panel-block empty-state">
                <div className="panel-heading">
                  <span>Ward detail</span>
                  <small>Single click</small>
                </div>
                <p>{statusText}</p>
              </section>
            )
          ) : mode === "hazard" ? (
            displayedHazardPixel ? (
              <DistributionChart
                distribution={displayedHazardPixel}
                threshold={threshold}
                labels={metadata.modes.hazard.binLabels}
              />
            ) : (
              <section className="panel-block empty-state">
                <div className="panel-heading">
                  <span>Hazard pixel detail</span>
                  <small>Single click</small>
                </div>
                <p>{statusText}</p>
              </section>
            )
          ) : selectedRiskDetail ? (
            <HeatRiskDetailPanel detail={selectedRiskDetail} threshold={threshold} />
          ) : (
            <section className="panel-block empty-state">
              <div className="panel-heading">
                <span>Heat risk detail</span>
                <small>Single click</small>
              </div>
              <p>{statusText}</p>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
