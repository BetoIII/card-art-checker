"""
The /api/spec-check gate: only this deployment's own pipeline may spend its
compute.

Run: npm run test:py   (or: python3 -m unittest discover -s tests -p 'test_*.py')

The token is derived from ROCKETLANE_WEBHOOK_SECRET on both sides of the
self-call. tests/internal-auth.test.js pins lib/internal-auth.js to the same
vector as this file, so the Python and JavaScript derivations can't drift.
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

VECTOR = "324d708b6aad55d0f0b423460d218eccb3671fbf34668b8db400601c0bbe8b1b"


def headers(**values):
    """Request headers as the handler sees them: case-insensitive."""
    msg = Message()
    for name, value in values.items():
        msg[name.replace("_", "-")] = value
    return msg


class SpecCheckAuth(unittest.TestCase):
    def test_token_matches_the_javascript_vector(self):
        with mock.patch.dict(os.environ, {"ROCKETLANE_WEBHOOK_SECRET": "test-secret"}):
            self.assertEqual(spec_check._spec_check_token(), VECTOR)

    def test_the_pipelines_token_is_let_through(self):
        with mock.patch.dict(os.environ, {"ROCKETLANE_WEBHOOK_SECRET": "test-secret"}):
            self.assertIsNone(spec_check._auth_error(headers(X_Spec_Check_Token=VECTOR)))

    def test_a_missing_or_wrong_token_is_refused(self):
        with mock.patch.dict(os.environ, {"ROCKETLANE_WEBHOOK_SECRET": "test-secret"}):
            self.assertEqual(spec_check._auth_error(headers())[0], 401)
            self.assertEqual(spec_check._auth_error(headers(X_Spec_Check_Token="0" * 64))[0], 401)
            # The raw secret is not the token.
            self.assertEqual(spec_check._auth_error(headers(X_Spec_Check_Token="test-secret"))[0], 401)

    def test_no_secret_refuses_everything(self):
        env = {k: v for k, v in os.environ.items() if k != "ROCKETLANE_WEBHOOK_SECRET"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(spec_check._spec_check_token())
            self.assertEqual(spec_check._auth_error(headers(X_Spec_Check_Token=VECTOR))[0], 503)


if __name__ == "__main__":
    unittest.main()
