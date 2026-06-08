def normalize(text):
    """Lowercase the input and collapse runs of whitespace to single spaces."""
    return " ".join(text.lower().split())


def flatten(nested):
    """Concatenate a list of lists into one flat list, left to right."""
    return [item for sub in nested for item in sub]


def alpha_marker():
    return "alpha"
