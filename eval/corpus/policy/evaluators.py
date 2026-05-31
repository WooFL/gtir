# Policy evaluators — each decides whether a request may proceed.

class RetryPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class CachePolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class RateLimitPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class CircuitBreakerPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit
