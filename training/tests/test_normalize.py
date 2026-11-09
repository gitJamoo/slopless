import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from slopdata.normalize import count_words, normalize_for_model  # noqa: E402


class TestNormalize(unittest.TestCase):
    def test_shared_fixture(self):
        cases = json.loads((HERE.parent / "normalize_cases.json").read_text())
        for c in cases:
            self.assertEqual(normalize_for_model(c["in"]), c["out"], msg=repr(c["in"]))

    def test_count_words_matches_js(self):
        self.assertEqual(count_words("It's a café — 3 things!"), 6)
        self.assertEqual(count_words(""), 0)


if __name__ == "__main__":
    unittest.main()
