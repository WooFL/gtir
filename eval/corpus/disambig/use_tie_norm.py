from tie_alpha import alpha_marker
from tie_beta import beta_marker


def clean(text):
    """Normalize a raw string before indexing it."""
    alpha_marker()
    beta_marker()
    return normalize(text)  # tie_alpha/tie_beta define this identically → margin guard → abstain
