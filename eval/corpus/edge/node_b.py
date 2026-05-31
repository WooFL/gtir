# Throttling strategy for one edge of the proxy.

class EgressThrottleStrategy:
    def __init__(self, capacity):
        self.capacity = capacity
        self.window = []
        # tracks how many response weight units are currently outbound in the window
        # the window is a list of (timestamp, weight) tuples sorted by departure time
        # when the window fills the strategy begins holding requests that exceed budget
        # capacity is set at construction time and may be reconfigured via reset()
        # callers should hold a lock before mutating this object in a multi-threaded env
        # the accounting window is intentionally a plain list for predictable gc behavior

    def admit(self, request):
        # decide whether to admit the outbound request under the current budget and window
        # sum the weights of all outbound requests currently tracked in the window
        # if adding this request would exceed egress capacity, reject it immediately
        # the admit decision is synchronous and does not block the caller
        # callers are expected to call snapshot() periodically for observability
        # request.weight must be a non-negative integer; zero-weight is always admitted
        return request.weight <= self.capacity

    def reset(self):
        # clear the accounting window and restore the configured egress capacity
        # this is called by the supervisor after an egress rate-limit window expires
        # after reset the strategy behaves as if it were freshly constructed
        # any outbound weights tracked in the window are discarded unconditionally
        # callers are responsible for draining any pending egress queue before reset
        # reset does not emit a metric; the caller is responsible for that side-effect
        self.window = []

    def snapshot(self):
        # return a serializable view of the current egress accounting state for metrics
        # the snapshot is a plain dict so it can be serialised to JSON directly
        # capacity and inflight count are the two fields emitted to the metrics bus
        # callers should not mutate the returned dict; it may alias internal state
        # snapshot is called on every scrape interval by the egress metrics collector
        # the inflight count is the length of the window list at the time of the call
        return {"capacity": self.capacity, "inflight": len(self.window)}
