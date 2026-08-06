"""
Vercel Python function wrapping scripts/check_technical_specs.py for the
virtual card path.

Runs the deterministic spec checks OUTSIDE the agent session so the session
spends its time budget on visual inspection only:

  POST {"mode": "check",  "image_b64": ...}
    -> JSON {"tech_specs": {...}}   (check_image() output)

  POST {"mode": "render", "image_b64": ..., "visual_results": {...}}
    -> application/pdf              (annotated results report)

The caller is lib/pipeline.js (same deployment, self-call). Physical cards
stay in-session: their .ai/.eps sources need Ghostscript, which this
function does not bundle.
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
        self._json(200, {"ok": True, "modes": ["check", "render"]})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "Body must be valid JSON"})

        mode = body.get("mode") or "check"
        if mode not in ("check", "render"):
            return self._json(400, {"error": f"Unknown mode: {mode}"})
        if (body.get("card_type") or "virtual") != "virtual":
            return self._json(400, {"error": "Only card_type=virtual is supported (physical needs the in-session Ghostscript path)"})
        if not body.get("image_b64"):
            return self._json(400, {"error": "image_b64 is required"})

        try:
            image_bytes = base64.b64decode(body["image_b64"])
        except (ValueError, TypeError):
            return self._json(400, {"error": "image_b64 is not valid base64"})

        # Basename only; the name flows into the report header and temp path.
        file_name = os.path.basename(body.get("file_name") or "card-art.png") or "card-art.png"

        try:
            with tempfile.TemporaryDirectory() as tmp:
                image_path = os.path.join(tmp, file_name)
                with open(image_path, "wb") as f:
                    f.write(image_bytes)

                result = specs.check_image(image_path)

                if mode == "check":
                    return self._json(200, {"tech_specs": result})

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
        except Exception as e:  # surface the reason; the caller has a pdf-lib fallback
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _json(self, status, payload):
        self._bytes(status, "application/json", json.dumps(payload).encode("utf-8"))

    def _bytes(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
