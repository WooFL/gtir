def levenshtein(s: str, t: str) -> int:
    """Classic Wagner-Fischer dynamic-programming edit distance."""
    m, n = len(s), len(t)
    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, n + 1):
            cost = 0 if s[i - 1] == t[j - 1] else 1
            dp[j], prev = min(dp[j] + 1, dp[j - 1] + 1, prev + cost), dp[j]
    return dp[n]


def fuzzy_match(query: str, candidates: list[str], threshold: int = 3) -> list[tuple[str, int]]:
    """Return candidates within edit-distance threshold, sorted by distance."""
    scored = [(c, levenshtein(query.lower(), c.lower())) for c in candidates]
    return sorted((pair for pair in scored if pair[1] <= threshold), key=lambda p: p[1])
