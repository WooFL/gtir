import csv
import io


def encode(rows):
    """Serialize a list of row mappings to CSV text with a header line."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def csv_marker():
    """Identity marker so callers can establish a csv_codec import edge."""
    return "csv"
