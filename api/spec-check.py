"""
Vercel Python function wrapping scripts/check_technical_specs.py.

Runs the deterministic spec work OUTSIDE the agent session so the session
spends its time budget on visual inspection only:

  POST {"mode": "check",  "image_b64": ...}                     (virtual)
    -> JSON {"tech_specs": {...}, "crops": {...}}   (check_image() output)

  POST {"mode": "render", "image_b64": ..., "visual_results": {...}}
    -> application/pdf              (annotated virtual results report)

  POST {"mode": "render-physical", "tech_results": {...},
        "previews": {"front": b64, "back": b64?}, "visual_results": {...}}
    -> application/pdf              (annotated physical results report)

The caller is lib/pipeline.js (same deployment, self-call). Physical tech
specs stay in-session — .ai/.eps rendering needs the sandbox's Ghostscript —
but the annotated physical report only composes the ALREADY-rendered preview
PNGs, so render-physical needs no Ghostscript.
"""
import base64
import io
import json
import os
import sys
import tempfile

from http.server import BaseHTTPRequestHandler

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))

import check_technical_specs as specs  # noqa: E402


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
            if mode == "gs-probe":
                return self._handle_gs_probe(body)
            return self._json(400, {"error": f"Unknown mode: {mode}"})
        except Exception as e:  # surface the reason; the caller has a pdf-lib fallback
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _handle_gs_probe(self, body):
        # SPIKE (spike/gs-on-vercel): measure vendored-Ghostscript feasibility
        # on Vercel — can the physical tech specs run off-session? Renders a
        # posted .ai/.eps with scripts/bin/gs-1000-linux-x86_64 and times both
        # the raw render and (when it fits) full check_physical().
        import platform
        import shutil
        import subprocess
        import time

        info = {
            "machine": platform.machine(),
            "python": platform.python_version(),
            "libc": "-".join(platform.libc_ver()),
        }
        if not body.get("vector_b64"):
            return self._json(200, {"probe": info, "note": "no vector_b64 — platform info only"})

        data = base64.b64decode(body["vector_b64"])
        dpi = int(body.get("dpi") or 455)
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "front.ai")
            with open(src, "wb") as f:
                f.write(data)
            # Copy + chmod so the bundler's file-mode handling can't bite.
            gs_path = os.path.join(tmp, "gs")
            shutil.copy(os.path.join(_REPO_ROOT, "scripts", "bin", "gs-1000-linux-x86_64"), gs_path)
            os.chmod(gs_path, 0o755)

            out = os.path.join(tmp, "render.png")
            t0 = time.time()
            proc = subprocess.run(
                [gs_path, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                 f"-r{dpi}", "-sDEVICE=png16m", f"-sOutputFile={out}", src],
                capture_output=True, timeout=280,
            )
            gs_seconds = round(time.time() - t0, 1)
            result = {"probe": info, "dpi": dpi, "gs_seconds": gs_seconds, "returncode": proc.returncode}
            if proc.returncode != 0:
                result["stderr"] = proc.stderr.decode("utf-8", "replace")[:400]
                return self._json(200, result)
            img = specs.Image.open(out)
            result["render"] = {"size": list(img.size), "bytes": os.path.getsize(out)}

            # Full-fidelity timing: check_physical() end to end with the
            # vendored gs on PATH (its internal per-render timeout is 60s,
            # so skip when the raw render alone already blows that).
            if gs_seconds < 55:
                os.environ["PATH"] = tmp + os.pathsep + os.environ.get("PATH", "")
                t0 = time.time()
                tech = specs.check_physical(src, out_dir=tmp)
                result["check_physical_seconds"] = round(time.time() - t0, 1)
                result["bleed_zone"] = (tech.get("front") or {}).get("checks", {}).get("bleed_zone", {}).get("actual")
                result["zoom_crops"] = sorted((tech.get("front") or {}).get("zoom_crops", {}).keys())
            return self._json(200, result)

    def _handle_virtual(self, mode, body):
        if (body.get("card_type") or "virtual") != "virtual":
            return self._json(400, {"error": "check/render modes are virtual-only (physical tech specs need the in-session Ghostscript path)"})
        if not body.get("image_b64"):
            return self._json(400, {"error": "image_b64 is required"})

        try:
            image_bytes = base64.b64decode(body["image_b64"])
        except (ValueError, TypeError):
            return self._json(400, {"error": "image_b64 is not valid base64"})

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
