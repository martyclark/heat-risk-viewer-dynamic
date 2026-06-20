from __future__ import annotations

import io
import json
import math
from functools import lru_cache
from pathlib import Path

import mercantile
import numpy as np
import rasterio
import rasterio.windows
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from rasterio.enums import Resampling
from rasterio.mask import mask as rasterio_mask
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_geom
from shapely.geometry import shape

TILE_SIZE = 256
ZOOM_MIN = 8
ZOOM_MAX = 14
HAZARD_NODATA = -1.0
RISK_NODATA = -9999.0
THRESHOLDS = list(range(0, 51))

COLOR_STOPS = [
    (0.0, (245, 242, 230)),
    (0.12, (240, 206, 134)),
    (0.32, (236, 149, 75)),
    (0.58, (210, 78, 57)),
    (0.8, (137, 32, 55)),
    (1.0, (48, 12, 39)),
]

PROCESSED_DIR = Path("data/processed")
BOUNDARIES_DIR = Path("data/raw/boundaries")

app = FastAPI(title="Heat Risk Viewer API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_cities: dict[str, dict] = {}


@app.on_event("startup")
def load_cities() -> None:
    if not PROCESSED_DIR.exists():
        return
    for city_dir in sorted(PROCESSED_DIR.iterdir()):
        meta_path = city_dir / "city_meta.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            print(f"Computing stats for {meta['cityKey']}...")
            _enrich_city_meta(meta)
            _cities[meta["cityKey"]] = meta
            ward_path = BOUNDARIES_DIR / f"{meta['cityKey']}_wards.geojson"
            if ward_path.exists():
                with open(ward_path) as f:
                    meta["_wards"] = json.load(f)["features"]
                print(f"  Loaded {len(meta['_wards'])} wards")
            print(f"Registered city: {meta['cityKey']} ({meta['cityLabel']})")


def _enrich_city_meta(meta: dict) -> None:
    """Compute stats and risk_max from raster data and attach to meta in-place."""
    hazard_stats: dict[str, dict] = {}
    with rasterio.open(meta["hazardCog"]) as src:
        for i, t in enumerate(THRESHOLDS):
            data = src.read(i + 1)
            valid = data != HAZARD_NODATA
            if np.any(valid):
                v = data[valid]
                hazard_stats[str(t)] = {
                    "min": float(v.min()), "max": float(v.max()),
                    "mean": float(v.mean()), "p90": float(np.percentile(v, 90)),
                }
            else:
                hazard_stats[str(t)] = {"min": 0.0, "max": 0.0, "mean": 0.0, "p90": 0.0}

    # Compute risk_max and risk stats using threshold=25 as representative,
    # then scale other thresholds proportionally — avoids 51 full reprojections.
    risk_stats, risk_max = _compute_risk_stats(meta, hazard_stats)

    meta["riskMax"] = risk_max
    meta["statsByThreshold"] = {"hazard": hazard_stats, "risk": risk_stats}
    meta["legendStops"] = {
        "hazard": _legend_stops(365),
        "risk": _legend_stops(float(risk_max)),
    }


def _compute_risk_stats(meta: dict, hazard_stats: dict) -> tuple[dict, float]:
    """Reproject hazard to population grid for all thresholds and compute risk stats."""
    pop_nodata = meta["populationNodata"]
    vuln_nodata = meta["vulnerabilityNodata"]
    hazard_grid = meta["hazardGrid"]
    risk_grid = meta["riskGrid"]

    with rasterio.open(meta["populationTif"]) as src:
        population = src.read(meta["populationBand"]).astype(np.float32)
    with rasterio.open(meta["vulnerabilityTif"]) as src:
        vulnerability = src.read(meta["vulnerabilityBand"]).astype(np.float32)

    pop_valid = population != pop_nodata
    vuln_valid = vulnerability != vuln_nodata

    from rasterio.crs import CRS
    from rasterio.transform import Affine

    def _affine(t: list) -> Affine:
        return Affine(t[0], t[1], t[2], t[3], t[4], t[5])

    risk_stats: dict[str, dict] = {}
    risk_global_max = 0.0

    with rasterio.open(meta["hazardCog"]) as hazard_src:
        for i, t in enumerate(THRESHOLDS):
            hazard_on_risk = np.full(
                (risk_grid["height"], risk_grid["width"]), HAZARD_NODATA, dtype=np.float32
            )
            reproject(
                source=rasterio.band(hazard_src, i + 1),
                destination=hazard_on_risk,
                src_nodata=HAZARD_NODATA,
                dst_transform=_affine(risk_grid["transform"]),
                dst_crs=CRS.from_string(risk_grid["crs"]),
                dst_nodata=HAZARD_NODATA,
                resampling=Resampling.average,
            )
            risk_valid = (hazard_on_risk != HAZARD_NODATA) & pop_valid & vuln_valid
            heat_risk = np.where(
                risk_valid,
                hazard_on_risk * population * (1.0 + vulnerability),
                RISK_NODATA,
            )
            if np.any(risk_valid):
                v = heat_risk[risk_valid]
                stats = {
                    "min": float(v.min()), "max": float(v.max()),
                    "mean": float(v.mean()), "p90": float(np.percentile(v, 90)),
                }
                risk_global_max = max(risk_global_max, stats["max"])
            else:
                stats = {"min": 0.0, "max": 0.0, "mean": 0.0, "p90": 0.0}
            risk_stats[str(t)] = stats

    return risk_stats, risk_global_max


def _legend_stops(domain_max: float) -> list[dict]:
    return [
        {"value": round(pos * domain_max, 3), "color": f"rgba({r},{g},{b},1)"}
        for pos, (r, g, b) in COLOR_STOPS
    ]


def get_city(city_key: str) -> dict:
    if city_key not in _cities:
        raise HTTPException(status_code=404, detail=f"City '{city_key}' not found")
    return _cities[city_key]


def row_col_from_lng_lat(lng: float, lat: float, transform: list[float]) -> tuple[int, int]:
    a, b, c, d, e, f = transform
    det = a * e - b * d
    col = int((e * (lng - c) - b * (lat - f)) / det)
    row = int((-d * (lng - c) + a * (lat - f)) / det)
    return row, col


@lru_cache(maxsize=8)
def _build_palette(max_value: int) -> np.ndarray:
    palette = np.zeros((max_value + 1, 4), dtype=np.uint8)
    stop_positions = np.array([s[0] for s in COLOR_STOPS], dtype=np.float32)
    stop_colors = np.array([s[1] for s in COLOR_STOPS], dtype=np.float32)
    values = np.linspace(0.0, 1.0, max_value + 1, dtype=np.float32)
    for ch in range(3):
        palette[:, ch] = np.interp(values, stop_positions, stop_colors[:, ch]).round().astype(np.uint8)
    palette[:, 3] = 255
    return palette


def _colorize(data: np.ndarray, palette: np.ndarray, palette_max: int, nodata: float) -> np.ndarray:
    rgba = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    valid = data != nodata
    if np.any(valid):
        scaled = np.clip(np.rint(data[valid]), 0, palette_max).astype(np.int32)
        rgba[valid] = palette[scaled]
    return rgba


def _tile_dst_transform(z: int, x: int, y: int):
    bounds = mercantile.xy_bounds(mercantile.Tile(x, y, z))
    return from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, TILE_SIZE, TILE_SIZE)


def _png_bytes(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


@lru_cache(maxsize=4096)
def _render_hazard_tile(city_key: str, threshold: int, z: int, x: int, y: int) -> bytes:
    city = _cities[city_key]
    dst_transform = _tile_dst_transform(z, x, y)
    dst = np.full((TILE_SIZE, TILE_SIZE), HAZARD_NODATA, dtype=np.float32)

    with rasterio.open(city["hazardCog"]) as src:
        reproject(
            source=rasterio.band(src, threshold + 1),
            destination=dst,
            src_nodata=HAZARD_NODATA,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            dst_nodata=HAZARD_NODATA,
            resampling=Resampling.average,
        )

    palette = _build_palette(365)
    return _png_bytes(_colorize(dst, palette, 365, HAZARD_NODATA))


@lru_cache(maxsize=4096)
def _render_risk_tile(city_key: str, threshold: int, z: int, x: int, y: int) -> bytes:
    city = _cities[city_key]
    dst_transform = _tile_dst_transform(z, x, y)
    pop_nodata = city["populationNodata"]
    vuln_nodata = city["vulnerabilityNodata"]
    risk_max = max(1, int(math.ceil(city["riskMax"])))

    hazard_tile = np.full((TILE_SIZE, TILE_SIZE), HAZARD_NODATA, dtype=np.float32)
    pop_tile = np.full((TILE_SIZE, TILE_SIZE), pop_nodata, dtype=np.float32)
    vuln_tile = np.full((TILE_SIZE, TILE_SIZE), vuln_nodata, dtype=np.float32)

    with rasterio.open(city["hazardCog"]) as src:
        reproject(
            source=rasterio.band(src, threshold + 1),
            destination=hazard_tile,
            src_nodata=HAZARD_NODATA,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            dst_nodata=HAZARD_NODATA,
            resampling=Resampling.average,
        )
    with rasterio.open(city["populationTif"]) as src:
        reproject(
            source=rasterio.band(src, city["populationBand"]),
            destination=pop_tile,
            src_nodata=pop_nodata,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            dst_nodata=pop_nodata,
            resampling=Resampling.average,
        )
    with rasterio.open(city["vulnerabilityTif"]) as src:
        reproject(
            source=rasterio.band(src, city["vulnerabilityBand"]),
            destination=vuln_tile,
            src_nodata=vuln_nodata,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            dst_nodata=vuln_nodata,
            resampling=Resampling.average,
        )

    risk_tile = np.full((TILE_SIZE, TILE_SIZE), RISK_NODATA, dtype=np.float32)
    valid = (hazard_tile != HAZARD_NODATA) & (pop_tile != pop_nodata) & (vuln_tile != vuln_nodata)
    risk_tile[valid] = hazard_tile[valid] * pop_tile[valid] * (1.0 + vuln_tile[valid])

    palette = _build_palette(risk_max)
    return _png_bytes(_colorize(risk_tile, palette, risk_max, RISK_NODATA))


# --- Endpoints ---

@app.get("/api/cities")
def list_cities():
    return [{"key": k, "label": v["cityLabel"]} for k, v in _cities.items()]


@app.get("/api/{city_key}/metadata")
def city_metadata(city_key: str):
    city = get_city(city_key)
    return _build_viewer_metadata(city)


@app.get("/api/{city_key}/wards")
def get_wards(city_key: str):
    city = get_city(city_key)
    wards = city.get("_wards")
    if not wards:
        raise HTTPException(status_code=404, detail="No ward boundaries for this city")
    return {"type": "FeatureCollection", "features": wards}


@app.get("/api/{city_key}/aggregate/hazard/{ward_id}")
def ward_hazard_aggregate(city_key: str, ward_id: str):
    get_city(city_key)
    result = _aggregate_ward_hazard(city_key, ward_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Ward not found or no valid raster data")
    return result


@app.get("/api/{city_key}/aggregate/all-wards")
def all_wards_aggregate(city_key: str):
    city = get_city(city_key)
    wards = city.get("_wards")
    if not wards:
        raise HTTPException(status_code=404, detail="No ward boundaries for this city")
    results = []
    for ward in wards:
        ward_id = str(ward["properties"]["gid"])
        result = _aggregate_ward_hazard(city_key, ward_id)
        if result is None:
            continue
        population = _aggregate_ward_population(city_key, ward_id)
        results.append({**result, "totalPopulation": population})
    return results


@lru_cache(maxsize=256)
def _aggregate_ward_hazard(city_key: str, ward_id: str) -> dict | None:
    city = _cities[city_key]
    ward = next(
        (w for w in city.get("_wards", []) if str(w["properties"]["gid"]) == ward_id),
        None,
    )
    if ward is None:
        return None

    geom = shape(ward["geometry"])

    with rasterio.open(city["hazardDistributionTif"]) as src:
        raster_nodata = src.nodata
        try:
            clipped, _ = rasterio_mask(src, [geom], crop=True, all_touched=True)
        except ValueError:
            return None

    # clipped: (bands, H, W) — raw distribution counts
    if raster_nodata is not None:
        valid = np.any(clipped != raster_nodata, axis=0)
    else:
        valid = np.ones(clipped.shape[1:], dtype=bool)
    pixel_count = int(valid.sum())
    if pixel_count == 0:
        return None

    mean_bins = [
        float(clipped[b][valid].mean()) if pixel_count > 0 else 0.0
        for b in range(clipped.shape[0])
    ]

    return {
        "wardId": ward_id,
        "wardName": ward["properties"].get("ward", "Unknown"),
        "subcounty": ward["properties"].get("subcounty", "").strip(),
        "pixelCount": pixel_count,
        "bins": mean_bins,
    }


@lru_cache(maxsize=256)
def _aggregate_ward_population(city_key: str, ward_id: str) -> float:
    city = _cities[city_key]
    ward = next(
        (w for w in city.get("_wards", []) if str(w["properties"]["gid"]) == ward_id),
        None,
    )
    if ward is None:
        return 0.0

    pop_nodata = city["populationNodata"]
    with rasterio.open(city["populationTif"]) as src:
        src_crs = src.crs
        if src_crs.to_epsg() != 4326:
            geom_for_mask = transform_geom("EPSG:4326", src_crs, ward["geometry"])
        else:
            geom_for_mask = ward["geometry"]
        try:
            clipped, _ = rasterio_mask(
                src, [geom_for_mask], crop=True, all_touched=True, indexes=[city["populationBand"]]
            )
        except ValueError:
            return 0.0

    valid = clipped[0] != pop_nodata
    if not np.any(valid):
        return 0.0
    return float(np.nansum(clipped[0][valid]))


@app.get("/tiles/{city_key}/hazard/{threshold}/{z}/{x}/{y}.png")
def hazard_tile(city_key: str, threshold: int, z: int, x: int, y: int):
    get_city(city_key)
    if not (ZOOM_MIN <= z <= ZOOM_MAX) or not (0 <= threshold <= 50):
        raise HTTPException(status_code=400, detail="Invalid tile parameters")
    return Response(content=_render_hazard_tile(city_key, threshold, z, x, y), media_type="image/png")


@app.get("/tiles/{city_key}/risk/{threshold}/{z}/{x}/{y}.png")
def risk_tile(city_key: str, threshold: int, z: int, x: int, y: int):
    get_city(city_key)
    if not (ZOOM_MIN <= z <= ZOOM_MAX) or not (0 <= threshold <= 50):
        raise HTTPException(status_code=400, detail="Invalid tile parameters")
    return Response(content=_render_risk_tile(city_key, threshold, z, x, y), media_type="image/png")


@app.get("/api/{city_key}/pixel/hazard")
def hazard_pixel(city_key: str, lng: float, lat: float):
    city = get_city(city_key)
    grid = city["hazardGrid"]
    row, col = row_col_from_lng_lat(lng, lat, grid["transform"])

    if not (0 <= row < grid["height"] and 0 <= col < grid["width"]):
        raise HTTPException(status_code=400, detail="Location is outside the raster extent")

    with rasterio.open(city["hazardDistributionTif"]) as src:
        window = rasterio.windows.Window(col, row, 1, 1)
        bins = src.read(window=window).flatten().tolist()

    nodata = grid["nodata"]
    if all(v == nodata for v in bins):
        raise HTTPException(status_code=404, detail="No valid hazard data at this location")

    return {"row": row, "col": col, "lng": lng, "lat": lat, "bins": bins}


@app.get("/api/{city_key}/pixel/risk")
def risk_pixel(city_key: str, lng: float, lat: float, threshold: int):
    city = get_city(city_key)

    risk_grid = city["riskGrid"]
    row, col = row_col_from_lng_lat(lng, lat, risk_grid["transform"])
    if not (0 <= row < risk_grid["height"] and 0 <= col < risk_grid["width"]):
        raise HTTPException(status_code=400, detail="Location is outside the raster extent")

    hazard_grid = city["hazardGrid"]
    hrow, hcol = row_col_from_lng_lat(lng, lat, hazard_grid["transform"])
    hrow = max(0, min(hrow, hazard_grid["height"] - 1))
    hcol = max(0, min(hcol, hazard_grid["width"] - 1))

    with rasterio.open(city["hazardCog"]) as src:
        hazard_val = float(src.read(threshold + 1, window=rasterio.windows.Window(hcol, hrow, 1, 1)).flat[0])

    with rasterio.open(city["populationTif"]) as src:
        pop_val = float(src.read(city["populationBand"], window=rasterio.windows.Window(col, row, 1, 1)).flat[0])

    with rasterio.open(city["vulnerabilityTif"]) as src:
        vuln_val = float(src.read(city["vulnerabilityBand"], window=rasterio.windows.Window(col, row, 1, 1)).flat[0])

    if hazard_val == HAZARD_NODATA or pop_val == city["populationNodata"] or vuln_val == city["vulnerabilityNodata"]:
        raise HTTPException(status_code=404, detail="No valid heat risk data at this location")

    return {
        "row": row, "col": col, "lng": lng, "lat": lat,
        "hazard": hazard_val,
        "population": pop_val,
        "vulnerability": vuln_val,
        "heatRisk": hazard_val * pop_val * (1.0 + vuln_val),
    }


def _build_viewer_metadata(city: dict) -> dict:
    city_key = city["cityKey"]
    risk_max = city["riskMax"]
    hazard_grid = city["hazardGrid"]
    risk_grid = city["riskGrid"]
    return {
        "cityKey": city_key,
        "cityLabel": city["cityLabel"],
        "availableModes": ["hazard", "heatRisk"],
        "defaultMode": "hazard",
        "defaultThreshold": 25,
        "thresholds": THRESHOLDS,
        "bounds": city["hazardGrid"]["bounds"],
        "rawDataPaths": {
            "hazard": city["hazardCog"],
            "populationNairobi": city["populationTif"],
            "vulnerability": city["vulnerabilityTif"],
        },
        "modes": {
            "hazard": {
                "label": "Hazard",
                "units": {"temperature": "°C", "hazard": "days"},
                "tileSize": TILE_SIZE,
                "zoomRange": {"min": ZOOM_MIN, "max": ZOOM_MAX},
                "bounds": city["hazardGrid"]["bounds"],
                "legendDomain": [0, 365],
                "legendStops": city["legendStops"]["hazard"],
                "tilesPathTemplate": f"tiles/{city_key}/hazard/{{threshold}}/{{z}}/{{x}}/{{y}}.png",
                "rasterGrid": hazard_grid,
                "statsByThreshold": city["statsByThreshold"]["hazard"],
                "generated": {"thresholdCount": len(THRESHOLDS), "tilesWritten": 0},
                "thresholdModeLabel": "Days above threshold",
                "definition": "hazard_days(threshold) = sum of yearly bin counts where bin lower edge >= threshold",
                "pixelQuery": {"endpoint": f"/api/{city_key}/pixel/hazard"},
                "binEdges": list(range(0, 51)),
                "binLabels": [f"{s}-{s + 1}°C" for s in range(0, 50)],
            },
            "heatRisk": {
                "label": "Heat Risk",
                "units": {"hazard": "days", "population": "people", "vulnerability": "ratio", "heatRisk": "risk"},
                "tileSize": TILE_SIZE,
                "zoomRange": {"min": ZOOM_MIN, "max": ZOOM_MAX},
                "bounds": city["riskGrid"]["bounds"],
                "legendDomain": [0, float(risk_max)],
                "legendStops": city["legendStops"]["risk"],
                "tilesPathTemplate": f"tiles/{city_key}/risk/{{threshold}}/{{z}}/{{x}}/{{y}}.png",
                "rasterGrid": risk_grid,
                "statsByThreshold": city["statsByThreshold"]["risk"],
                "generated": {"thresholdCount": len(THRESHOLDS), "tilesWritten": 0},
                "formula": "heat_risk = hazard × population × (1 + vulnerability)",
                "pixelQuery": {"endpoint": f"/api/{city_key}/pixel/risk"},
            },
        },
    }
