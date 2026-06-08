import json


def encode(value):
    """Serialize a mapping to a compact JSON string for storage on disk."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def json_marker():
    """Identity marker so callers can establish a json_codec import edge."""
    return "json"
