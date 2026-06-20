"""
Build a hazard-cube COG and minimal city_meta.json from raw raster inputs.

This is the only preprocessing step needed. It:
  1. Computes the cumulative-sum hazard cube (band T = days >= T°C)
  2. Writes it as a tiled, compressed GeoTIFF with overviews (COG-ready)
  3. Writes city_meta.json with file paths and grid info

Stats and risk values are computed lazily by the backend at startup — not here.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy
from rasterio.transform import Affine

HAZARD_NODATA = -1.0
RISK_NODATA = -9999.0
NODATA_U8 = 255
THRESHOLDS = list(range(0, 51))


def affine_to_list(t: Affine) -> list[float]:
    return [t.a, t.b, t.c, t.d, t.e, t.f]


def compute_hazard_cube(counts: np.ndarray) -> np.ndarray:
    """cube[i] = days where temp >= THRESHOLDS[i], shape (51, H, W)."""
    cube = np.zeros((len(THRESHOLDS), counts.shape[1], counts.shape[2]), dtype=np.float32)
    running = np.zeros(counts.shape[1:], dtype=np.float32)
    for t in range(counts.shape[0] - 1, -1, -1):
        if t < len(THRESHOLDS):
            running += counts[t].astype(np.float32)
            cube[t] = running
    return cube


def build(
    city_key: str,
    city_label: str,
    hazard_path: Path,
    population_path: Path,
    population_band: int,
    vulnerability_path: Path,
    vulnerability_band: int,
    output_dir: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    cog_path = output_dir / "hazard_cube.tif"
    meta_path = output_dir / "city_meta.json"

    print("Reading hazard distribution...")
    with rasterio.open(hazard_path) as src:
        distribution = src.read()
        src_nodata = int(src.nodata if src.nodata is not None else NODATA_U8)
        counts = np.where(distribution == src_nodata, 0, distribution).astype(np.uint8)
        valid_mask = np.any(distribution != src_nodata, axis=0)
        transform = src.transform
        crs = src.crs
        bounds = [src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top]
        width, height, band_count = src.width, src.height, src.count

    print("Computing hazard cube...")
    cube = compute_hazard_cube(counts)

    print("Writing COG...")
    with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    with rasterio.open(
        tmp_path, "w",
        driver="GTiff", count=len(THRESHOLDS), dtype="float32",
        crs=crs, transform=transform, width=width, height=height,
        nodata=HAZARD_NODATA, compress="deflate", tiled=True,
        blockxsize=256, blockysize=256,
    ) as dst:
        for i in range(len(THRESHOLDS)):
            dst.write(np.where(valid_mask, cube[i], HAZARD_NODATA).astype(np.float32), i + 1)
        dst.build_overviews([2, 4, 8, 16, 32], Resampling.average)
        dst.update_tags(ns="rio_overview", resampling="average")

    rio_copy(tmp_path, cog_path, driver="GTiff", copy_src_overviews=True,
             compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    tmp_path.unlink()
    print(f"COG written: {cog_path}")

    with rasterio.open(population_path) as src:
        pop_nodata = float(src.nodata)
        risk_transform = src.transform
        risk_crs = src.crs
        risk_bounds = [src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top]
        risk_width, risk_height = src.width, src.height

    with rasterio.open(vulnerability_path) as src:
        vuln_nodata = float(src.nodata)

    meta = {
        "cityKey": city_key,
        "cityLabel": city_label,
        "hazardCog": str(cog_path.resolve()),
        "hazardDistributionTif": str(hazard_path.resolve()),
        "populationTif": str(population_path.resolve()),
        "populationBand": population_band,
        "populationNodata": pop_nodata,
        "vulnerabilityTif": str(vulnerability_path.resolve()),
        "vulnerabilityBand": vulnerability_band,
        "vulnerabilityNodata": vuln_nodata,
        "hazardNodata": HAZARD_NODATA,
        "riskNodata": RISK_NODATA,
        "hazardGrid": {
            "width": width, "height": height,
            "transform": affine_to_list(transform),
            "bounds": bounds, "crs": str(crs),
            "nodata": HAZARD_NODATA, "bands": band_count,
        },
        "riskGrid": {
            "width": risk_width, "height": risk_height,
            "transform": affine_to_list(risk_transform),
            "bounds": risk_bounds, "crs": str(risk_crs),
            "nodata": RISK_NODATA,
        },
    }

    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Done. Metadata written: {meta_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--city-key", default="nairobi")
    parser.add_argument("--city-label", default="Nairobi")
    parser.add_argument("--hazard", default=Path("data/raw/hazard/temp_dist_nairobi.tif"), type=Path)
    parser.add_argument("--population", default=Path("data/raw/population/ken_pop_nairobi_100m.tif"), type=Path)
    parser.add_argument("--population-band", default=1, type=int)
    parser.add_argument("--vulnerability", default=Path("data/raw/vulnerability/population_composite_nairobi.tif"), type=Path)
    parser.add_argument("--vulnerability-band", default=5, type=int)
    parser.add_argument("--output", default=None, type=Path)
    args = parser.parse_args()
    build(
        args.city_key, args.city_label,
        args.hazard, args.population, args.population_band,
        args.vulnerability, args.vulnerability_band,
        args.output or Path(f"data/processed/{args.city_key}"),
    )


if __name__ == "__main__":
    main()
