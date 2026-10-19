"""Shared readers for the public IPR Praha 3D model sheets (terrain TIN, buildings).

IPR publishes the 3D model of Prague as open data (CC BY 4.0, "datový podklad
© IPR Praha") split by 1:5000 map sheets in S-JTSK / Krovak East North
(EPSG:5514) with Bpv heights. scripts/download-ipr-3d.py records the exact
archives and SHA-256 in docs/ipr-3d-manifest.json; the importers read the
cached ZIP archives directly so no intermediate file can silently change.
"""

import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import zipfile

import numpy as np
import shapefile
from shapely import STRtree, points as shapely_points
from shapely.geometry import box

ROOT = Path(__file__).resolve().parent.parent


def load_dtm_module():
    """Reuse the authoritative ČÚZK grid transform of the DTM importer."""
    spec = importlib.util.spec_from_file_location(
        "linka_dtm_import", ROOT / "scripts" / "import-dtm-street-surfaces.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_shapefile(archive_path):
    archive = zipfile.ZipFile(archive_path)
    shp = [name for name in archive.namelist() if name.lower().endswith(".shp")]
    if len(shp) != 1:
        raise ValueError(f"{archive_path} must contain exactly one shapefile")
    base = shp[0][:-4]
    reader = shapefile.Reader(
        shp=io.BytesIO(archive.read(base + ".shp")),
        shx=io.BytesIO(archive.read(base + ".shx")),
        dbf=io.BytesIO(archive.read(base + ".dbf")),
    )
    prj = next((name for name in archive.namelist() if name.lower().endswith(".prj")), None)
    if prj is None or "Krovak" not in archive.read(prj).decode("utf-8", "replace"):
        raise ValueError(f"{archive_path} is not declared in S-JTSK Krovak East North")
    return reader


class Projection:
    """Game projection of src/route.js plus the official S-JTSK transform."""

    def __init__(self, route, grid_path):
        dtm = load_dtm_module()
        self.to_native, self.to_wgs84, self.metadata = dtm.coordinate_transform(route, grid_path)
        self.origin = route["origin"]
        self.cos = math.cos(math.radians(self.origin["lat"]))

    def world_to_native(self, x, z):
        x = np.asarray(x, dtype=float)
        z = np.asarray(z, dtype=float)
        lat = self.origin["lat"] - z / 111320
        lon = self.origin["lon"] + x / (111320 * self.cos)
        return self.to_native.transform(lon, lat)

    def native_to_world(self, ex, ny):
        lon, lat = self.to_wgs84.transform(np.asarray(ex, dtype=float), np.asarray(ny, dtype=float))
        lon = np.asarray(lon)
        lat = np.asarray(lat)
        return (lon - self.origin["lon"]) * 111320 * self.cos, -(lat - self.origin["lat"]) * 111320

    def native_to_latlon(self, ex, ny):
        lon, lat = self.to_wgs84.transform(np.asarray(ex, dtype=float), np.asarray(ny, dtype=float))
        return np.asarray(lat), np.asarray(lon)


class TerrainTin:
    """Exact barycentric sampler of the IPR lidar terrain TIN sheets."""

    def __init__(self, archives, region=None):
        vertices, heights = [], []
        for archive in archives:
            reader = open_shapefile(archive)
            if reader.shapeTypeName != "MULTIPATCH":
                raise ValueError(f"{archive} is not a multipatch TIN")
            if region is not None and not box(*reader.bbox[:4]).intersects(region):
                continue
            for shape in reader.iterShapes():
                if list(shape.partTypes) != [4] or len(shape.points) != 4:
                    raise ValueError(f"{archive} contains a non-triangular TIN patch")
                vertices.append(shape.points[:3])
                heights.append(shape.z[:3])
        self.xy = np.asarray(vertices, dtype=np.float64)
        self.z = np.asarray(heights, dtype=np.float64)
        if region is not None:
            lo = self.xy.min(axis=1)
            hi = self.xy.max(axis=1)
            minx, miny, maxx, maxy = region.bounds
            keep = (hi[:, 0] >= minx) & (lo[:, 0] <= maxx) & (hi[:, 1] >= miny) & (lo[:, 1] <= maxy)
            self.xy, self.z = self.xy[keep], self.z[keep]
        lo = self.xy.min(axis=1)
        hi = self.xy.max(axis=1)
        self.tree = STRtree([box(a[0], a[1], b[0], b[1]) for a, b in zip(lo, hi)])

    def sample(self, ex, ny):
        """Return Bpv heights at native points; NaN outside the TIN."""
        ex = np.asarray(ex, dtype=float).ravel()
        ny = np.asarray(ny, dtype=float).ravel()
        result = np.full(ex.shape, np.nan)
        pts, tris = self.tree.query(shapely_points(ex, ny), predicate="intersects")
        if len(pts) == 0:
            return result
        a, b, c = self.xy[tris, 0], self.xy[tris, 1], self.xy[tris, 2]
        px, py = ex[pts], ny[pts]
        det = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
        ok = np.abs(det) > 1e-12
        det = np.where(ok, det, 1)
        w1 = ((b[:, 1] - c[:, 1]) * (px - c[:, 0]) + (c[:, 0] - b[:, 0]) * (py - c[:, 1])) / det
        w2 = ((c[:, 1] - a[:, 1]) * (px - c[:, 0]) + (a[:, 0] - c[:, 0]) * (py - c[:, 1])) / det
        w3 = 1 - w1 - w2
        inside = ok & (w1 >= -1e-9) & (w2 >= -1e-9) & (w3 >= -1e-9)
        z = self.z[tris]
        value = w1 * z[:, 0] + w2 * z[:, 1] + w3 * z[:, 2]
        pts, value = pts[inside], value[inside]
        result[pts] = value  # adjacent triangles agree on shared edges
        return result


def load_manifest(path):
    manifest = json.loads(Path(path).read_text("utf-8"))
    return manifest


def verified_archives(manifest, cache_dir, kind):
    """Return cached archives of one kind after checking their SHA-256."""
    cache_dir = Path(cache_dir)
    result = []
    for sheet in manifest["sheets"]:
        item = sheet.get(kind)
        if not item:
            continue
        path = cache_dir / item["file"]
        if not path.exists():
            raise FileNotFoundError(f"Missing {path}; run scripts/download-ipr-3d.py --download")
        if sha256_file(path) != item["sha256"]:
            raise ValueError(f"Checksum differs from the manifest: {path}")
        result.append(path)
    return result


class SurfaceModel:
    """Reader of the IPR Praha 1 m digital surface model GeoTIFF (EPSG:5514).

    The published raster is one uncompressed, 128 px tiled float32 GeoTIFF of
    the whole city; tiles are read on demand so only the corridor is loaded.
    """

    def __init__(self, path):
        import tifffile

        self.path = Path(path)
        self.file = tifffile.TiffFile(self.path)
        page = self.file.pages[0]
        if page.compression != 1 or not page.is_tiled or page.dtype != np.float32:
            raise ValueError("Expected an uncompressed tiled float32 surface model")
        geo = self.file.geotiff_metadata
        if geo.get("ProjectedCSTypeGeoKey") != 5514:
            raise ValueError("The surface model is not declared in EPSG:5514")
        _, _, _, self.x0, self.y0, _ = geo["ModelTiepoint"]
        self.cell = float(geo["ModelPixelScale"][0])
        self.height, self.width = page.shape
        self.tile_h, self.tile_w = page.tilelength, page.tilewidth
        self.tiles_across = -(-self.width // self.tile_w)
        self.offsets = page.dataoffsets
        self.counts = page.databytecounts
        self.cache = {}
        self.handle = self.path.open("rb")

    def tile(self, row, col):
        key = (row, col)
        if key not in self.cache:
            index = row * self.tiles_across + col
            self.handle.seek(self.offsets[index])
            data = np.frombuffer(self.handle.read(self.counts[index]), dtype="<f4")
            tile = data.reshape(self.tile_h, self.tile_w).astype(np.float64)
            tile[tile < -1e30] = np.nan
            if len(self.cache) > 4096:
                self.cache.clear()
            self.cache[key] = tile
        return self.cache[key]

    def pixel(self, ex, ny):
        """Row/column of native coordinates (pixel centres at integer + 0.5)."""
        col = np.floor((np.asarray(ex, dtype=float) - self.x0) / self.cell).astype(np.int64)
        row = np.floor((self.y0 - np.asarray(ny, dtype=float)) / self.cell).astype(np.int64)
        return row, col

    def sample(self, ex, ny):
        """Nearest-pixel surface altitude (Bpv metres); NaN outside the raster."""
        rows, cols = self.pixel(ex, ny)
        rows, cols = np.atleast_1d(rows), np.atleast_1d(cols)
        result = np.full(rows.shape, np.nan)
        inside = (rows >= 0) & (cols >= 0) & (rows < self.height) & (cols < self.width)
        for i in np.nonzero(inside)[0]:
            r, c = rows[i], cols[i]
            result[i] = self.tile(r // self.tile_h, c // self.tile_w)[r % self.tile_h, c % self.tile_w]
        return result

    def window(self, xmin, ymin, xmax, ymax):
        """Array of pixels covering a native rectangle and its pixel-centre grid."""
        r0, c0 = self.pixel(xmin, ymax)
        r1, c1 = self.pixel(xmax, ymin)
        r0, c0 = max(0, int(r0)), max(0, int(c0))
        r1, c1 = min(self.height - 1, int(r1)), min(self.width - 1, int(c1))
        out = np.full((r1 - r0 + 1, c1 - c0 + 1), np.nan)
        for tr in range(r0 // self.tile_h, r1 // self.tile_h + 1):
            for tc in range(c0 // self.tile_w, c1 // self.tile_w + 1):
                tile = self.tile(tr, tc)
                rr0, cc0 = tr * self.tile_h, tc * self.tile_w
                a0, a1 = max(r0, rr0), min(r1, rr0 + self.tile_h - 1)
                b0, b1 = max(c0, cc0), min(c1, cc0 + self.tile_w - 1)
                out[a0 - r0:a1 - r0 + 1, b0 - c0:b1 - c0 + 1] = tile[a0 - rr0:a1 - rr0 + 1, b0 - cc0:b1 - cc0 + 1]
        xs = self.x0 + (np.arange(c0, c1 + 1) + 0.5) * self.cell
        ys = self.y0 - (np.arange(r0, r1 + 1) + 0.5) * self.cell
        return out, xs, ys
