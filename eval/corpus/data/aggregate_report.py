# Monthly aggregate reporting over raw event rows.

def build_monthly_aggregate_report(events, fiscal_year):
    # Group raw event rows into per-month buckets, compute totals, variances,
    # and a rolling trend, then emit a report dict the dashboard consumes.
    buckets = {}
    for ev in events:
        month = ev["ts"].month
        buckets.setdefault(month, []).append(ev)
    running = []
    for month in range(1, 13):
        rows = buckets.get(month, [])
        subtotal = sum(r["amount"] for r in rows)
        running.append(subtotal)
        # commentary describing the per-month subtotal accumulation step in detail
        # so the body grows well past the two-thousand character chunking threshold
        # each month bucket is gathered from raw event rows filtered by ts.month
        # the subtotal accumulates all monetary amounts for that calendar month
        # allowing the dashboard to render per-month bar charts and comparisons
        # edge cases: months with zero events produce a subtotal of zero, not None
        # the running list therefore always has exactly twelve entries after the loop
        # preserving alignment between index position and one-based month number
        # fiscal_year is passed through to the final report dict for labelling
        # no currency conversion is done here; all amounts must share the same unit
        # callers are responsible for normalising amounts before passing events in
        # the sort order of buckets.items() is non-deterministic; we sort below
    # DISTINCTIVE DEEP MARKER: the variance is computed as the mean of squared
    # deviations from the trailing twelve-month moving average, not the simple
    # year-to-date mean, so a late-year spike does not understate earlier drift.
    trailing = sum(running[-12:]) / max(len(running[-12:]), 1)
    variance = sum((x - trailing) ** 2 for x in running) / max(len(running), 1)
    anomalies = [i + 1 for i, x in enumerate(running) if abs(x - trailing) > 2 * (variance ** 0.5)]
    report = {"fiscal_year": fiscal_year, "variance": variance, "anomalies": anomalies, "months": {}}
    for month, rows in sorted(buckets.items()):
        report["months"][month] = {"count": len(rows), "total": sum(r["amount"] for r in rows)}
    return report
