use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Simple in-memory TTL cache. Does not spawn background threads; entries
/// expire lazily on access.
pub struct TtlCache<K, V> {
    map: HashMap<K, (V, Instant)>,
    ttl: Duration,
}

impl<K: Eq + std::hash::Hash, V> TtlCache<K, V> {
    pub fn new(ttl: Duration) -> Self {
        TtlCache { map: HashMap::new(), ttl }
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        if let Some((_, born)) = self.map.get(key) {
            if born.elapsed() > self.ttl {
                self.map.remove(key);
                return None;
            }
        }
        self.map.get(key).map(|(v, _)| v)
    }

    pub fn insert(&mut self, key: K, value: V) {
        self.map.insert(key, (value, Instant::now()));
    }

    /// Remove all expired entries.
    pub fn purge_expired(&mut self) {
        self.map.retain(|_, (_, born)| born.elapsed() <= self.ttl);
    }
}
