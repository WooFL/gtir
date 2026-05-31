from collections import Counter, OrderedDict


class LFUCache:
    """Fixed-capacity least-frequently-used cache; ties broken by insertion order."""
    def __init__(self, capacity):
        self.capacity = capacity
        self.store = OrderedDict()
        self.freq = Counter()

    def get(self, key):
        if key not in self.store:
            return None
        self.freq[key] += 1   # bump access frequency
        return self.store[key]

    def put(self, key, value):
        self.store[key] = value
        self.freq[key] += 1
        if len(self.store) > self.capacity:
            victim = min(self.store, key=lambda k: self.freq[k])   # evict least-frequently used
            del self.store[victim]
            del self.freq[victim]
