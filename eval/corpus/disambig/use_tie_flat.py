from tie_alpha import alpha_marker
from tie_beta import beta_marker


def collapse(nested):
    """Flatten a nested list before counting elements."""
    alpha_marker()
    beta_marker()
    return flatten(nested)  # tie_alpha/tie_beta define this identically → margin guard → abstain
