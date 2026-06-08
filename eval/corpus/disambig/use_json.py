from json_codec import json_marker
from csv_codec import csv_marker


def save_document(document):
    """Encode a configuration document as a JSON string and return the payload."""
    json_marker()
    return encode(document)  # ambiguous: json_codec.encode vs csv_codec.encode — JSON context
