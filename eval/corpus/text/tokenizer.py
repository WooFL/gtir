import re
from typing import Iterator


WORD_RE = re.compile(r"[A-Za-z0-9']+")


def tokenize(text: str) -> list[str]:
    """Split text into lowercase word tokens, stripping punctuation."""
    return [m.group().lower() for m in WORD_RE.finditer(text)]


def ngrams(tokens: list[str], n: int) -> Iterator[tuple[str, ...]]:
    """Yield overlapping n-grams from a token list."""
    for i in range(len(tokens) - n + 1):
        yield tuple(tokens[i:i + n])


def tf(tokens: list[str]) -> dict[str, float]:
    """Term frequency: count / total tokens."""
    total = len(tokens)
    counts: dict[str, int] = {}
    for t in tokens:
        counts[t] = counts.get(t, 0) + 1
    return {t: c / total for t, c in counts.items()} if total else {}
