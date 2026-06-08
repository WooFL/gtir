from json_codec import json_marker
from csv_codec import csv_marker


def export_table(rows):
    """Encode a list of tabular rows as CSV text and return the spreadsheet body."""
    csv_marker()
    return encode(rows)  # ambiguous: json_codec.encode vs csv_codec.encode — CSV context
