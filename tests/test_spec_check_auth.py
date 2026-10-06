"""
The /api/spec-check gate: only callers holding the deployment's shared secret
may spend its compute.

Run: npm run test:py   (or: python3 -m unittest discover -s tests -p 'test_*.py')

The pipeline (lib/pipeline.js) sends ROCKETLANE_WEBHOOK_SECRET as a bearer
token, the same credential every server-to-server call uses.
"""
import importlib.util
import os
import unittest
from email.message import Message
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The handler's file name has a hyphen, so load it by path.
_spec = importlib.util.spec_from_file_location("spec_check", os.path.join(ROOT, "api", "spec-check.py"))
spec_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(spec_check)


def headers(**values):
    """Request headers as the handler sees them: case-insensitive."""
    msg = Message()
    for name, value in values.items():
        msg[name.replace("_", "-")] = value
    return msg


class SpecCheckAuth(unittest.TestCase):
    def test_the_bearer_secret_is_let_through(self):
        with mock.patch.dict(os.environ, {"ROCKETLANE_WEBHOOK_SECRET": "test-secret"}):
            self.assertIsNone(spec_check._auth_error(headers(Authorization="Bearer test-secret")))
            self.assertIsNone(spec_check._auth_error(headers(authorization="bearer test-secret")))

    def test_a_missing_or_wrong_secret_is_refused(self):
        with mock.patch.dict(os.environ, {"ROCKETLANE_WEBHOOK_SECRET": "test-secret"}):
            self.assertEqual(spec_check._auth_error(headers())[0], 401)
            self.assertEqual(spec_check._auth_error(headers(Authorization="Bearer nope"))[0], 401)
            self.assertEqual(spec_check._auth_error(headers(Authorization="Bearer "))[0], 401)
            # Not a bearer token.
            self.assertEqual(spec_check._auth_error(headers(Authorization="test-secret"))[0], 401)

    def test_no_secret_refuses_everything(self):
        env = {k: v for k, v in os.environ.items() if k != "ROCKETLANE_WEBHOOK_SECRET"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(spec_check._auth_error(headers(Authorization="Bearer test-secret"))[0], 503)


if __name__ == "__main__":
    unittest.main()
