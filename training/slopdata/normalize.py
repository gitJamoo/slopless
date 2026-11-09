"""Python twin of `normalizeForModel` in lib/text.ts.

Training text and in-browser text MUST be normalized identically, or the model learns
cues it will never see at inference. Both implementations are tested against
training/normalize_cases.json. Change them together.
"""
import re
import unicodedata

_SINGLE_QUOTES = re.compile("[‘’‚‛′]")
_DOUBLE_QUOTES = re.compile("[“”„‟″]")
# re.ASCII: JavaScript's \w and \b are ASCII-only (no `u` flag in lib/text.ts).
_URL = re.compile(r"\bhttps?://\S+|\bwww\.\S+", re.IGNORECASE | re.ASCII)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.ASCII)
_MENTION = re.compile(r"(^|[^\w@])@\w{1,30}", re.ASCII)
_WS = re.compile(r"\s+")
_WORD = re.compile(r"[^\W]+")  # letters, digits, underscore; unicode-aware like JS /[\p{L}\p{N}_]+/u


def normalize_for_model(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _SINGLE_QUOTES.sub("'", text)
    text = _DOUBLE_QUOTES.sub('"', text)
    text = _URL.sub("<url>", text)
    text = _EMAIL.sub("<email>", text)
    text = _MENTION.sub(r"\1@user", text)
    return _WS.sub(" ", text).strip()


def count_words(text: str) -> int:
    return len(_WORD.findall(text))
