"""
Vercel Python function wrapping scripts/check_technical_specs.py.

Runs the deterministic spec work OUTSIDE the agent session so the session
spends its time budget on visual inspection only:

  POST {"mode": "check", "image_url": ...}                      (virtual)
    -> JSON {"tech_specs": {...}, "crops": {...}}   (check_image() output)

  POST {"mode": "render", "image_url": ..., "visual_results": {...}}
    -> application/pdf              (annotated virtual results report)

  POST {"mode": "render-physical", "tech_results": {...},
        "previews": {"front": b64, "back": b64?}, "visual_results": {...}}
    -> application/pdf              (annotated physical results report)

The caller is lib/pipeline.js (same deployment, self-call). Source files
arrive as Vercel Blob URLs (`image_url`) because the platform rejects
request bodies over ~4.5MB — inline `image_b64` is still accepted for
small payloads and local harness tests.
"""
import base64
import io
import json
import os
import re
import sys
import tempfile
import urllib.request

from http.server import BaseHTTPRequestHandler

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))

import check_technical_specs as specs  # noqa: E402

# The endpoint is publicly reachable in prod, so URL fetches are pinned to
# the deployment's own Blob store family — not an open proxy.
_BLOB_URL_RE = re.compile(r"^https://[a-z0-9]+\.public\.blob\.vercel-storage\.com/")


def _load_source_bytes(body, url_key="image_url", b64_key="image_b64"):
    """Resolve a source file from a Blob URL or inline base64.

    Returns (bytes, error_message) — exactly one is set.
    """
    if body.get(b64_key):
        try:
            return base64.b64decode(body[b64_key]), None
        except (ValueError, TypeError):
            return None, f"{b64_key} is not valid base64"
    url = body.get(url_key)
    if not url:
        return None, f"{url_key} (Vercel Blob URL) or {b64_key} is required"
    if not _BLOB_URL_RE.match(url):
        return None, f"{url_key} must be a public Vercel Blob URL"
    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            return res.read(), None
    except Exception as e:
        return None, f"Could not fetch {url_key}: {type(e).__name__}: {e}"


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._json(200, {"ok": True, "modes": ["check", "render", "render-physical"]})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "Body must be valid JSON"})

        mode = body.get("mode") or "check"
        try:
            if mode in ("check", "render"):
                return self._handle_virtual(mode, body)
            if mode == "render-physical":
                return self._handle_render_physical(body)
            return self._json(400, {"error": f"Unknown mode: {mode}"})
        except Exception as e:  # surface the reason; the caller has a pdf-lib fallback
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _handle_virtual(self, mode, body):
        if (body.get("card_type") or "virtual") != "virtual":
            return self._json(400, {"error": "check/render modes are virtual-only"})
        image_bytes, err = _load_source_bytes(body)
        if err:
            return self._json(400, {"error": err})

        # Basename only; the name flows into the report header and temp path.
        file_name = os.path.basename(body.get("file_name") or "card-art.png") or "card-art.png"

        with tempfile.TemporaryDirectory() as tmp:
            image_path = os.path.join(tmp, file_name)
            with open(image_path, "wb") as f:
                f.write(image_bytes)

            result = specs.check_image(image_path)

            if mode == "check":
                # Zoom crops ride along so the pipeline can mount them as
                # session resources — the agent reads them instead of
                # writing its own PIL cropping code. Best-effort: a crop
                # failure must not sink the tech specs.
                crops = {}
                try:
                    crops = {
                        name: base64.b64encode(png).decode("ascii")
                        for name, png in specs.generate_zoom_crops(
                            specs.Image.open(image_path),
                            result.get("checks", {}).get("bleed_zone"),
                        ).items()
                    }
                except Exception as e:
                    result.setdefault("errors", []).append(f"Crop generation failed: {e}")
                return self._json(200, {"tech_specs": result, "crops": crops})

            visual = body.get("visual_results") or {}
            img = specs.Image.open(image_path)
            colors = result.get("colors") or specs.extract_colors(img)
            buf = io.BytesIO()
            specs.generate_results_image(
                img,
                colors,
                result.get("checks", {}),
                visual.get("visual_checks", []),
                visual.get("overall_status", "REQUIRES CHANGES"),
                visual.get("overall_description", ""),
                buf,
            )
            return self._bytes(200, "application/pdf", buf.getvalue())

    def _handle_render_physical(self, body):
        # Composes the annotated physical report from the preview PNGs the
        # in-session Turn 1 already rendered — pure PIL, no Ghostscript.
        tech = body.get("tech_results")
        if not isinstance(tech, dict) or not tech.get("front"):
            return self._json(400, {"error": "tech_results (check_physical output) is required"})
        previews = body.get("previews") or {}
        if not previews.get("front"):
            return self._json(400, {"error": "previews.front (base64 PNG) is required"})

        with tempfile.TemporaryDirectory() as tmp:
            for side in ("front", "back"):
                side_result = tech.get(side)
                if not isinstance(side_result, dict):
                    continue
                b64 = previews.get(side)
                if b64:
                    try:
                        preview_bytes = base64.b64decode(b64)
                    except (ValueError, TypeError):
                        return self._json(400, {"error": f"previews.{side} is not valid base64"})
                    preview_path = os.path.join(tmp, f"{side}_render.png")
                    with open(preview_path, "wb") as f:
                        f.write(preview_bytes)
                    side_result["rendered_preview_path"] = preview_path
                else:
                    # The renderer degrades to a note strip for missing sides.
                    side_result["rendered_preview_path"] = None

            visual = body.get("visual_results") or {}
            buf = io.BytesIO()
            specs.generate_physical_results_image(
                tech,
                visual.get("visual_checks", []),
                visual.get("overall_status", "REQUIRES CHANGES"),
                visual.get("overall_description", ""),
                buf,
            )
            return self._bytes(200, "application/pdf", buf.getvalue())

    def _json(self, status, payload):
        self._bytes(status, "application/json", json.dumps(payload).encode("utf-8"))

    def _bytes(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
