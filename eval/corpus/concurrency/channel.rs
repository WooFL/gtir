use std::sync::{Arc, Mutex, Condvar};
use std::collections::VecDeque;

/// Bounded MPSC channel backed by a mutex + condvar.
pub struct Channel<T> {
    inner: Arc<(Mutex<State<T>>, Condvar)>,
}

struct State<T> {
    buf: VecDeque<T>,
    capacity: usize,
    closed: bool,
}

impl<T: Send + 'static> Channel<T> {
    pub fn new(capacity: usize) -> (Sender<T>, Receiver<T>) {
        let inner = Arc::new((
            Mutex::new(State { buf: VecDeque::with_capacity(capacity), capacity, closed: false }),
            Condvar::new(),
        ));
        (Sender { inner: inner.clone() }, Receiver { inner })
    }
}

pub struct Sender<T> { inner: Arc<(Mutex<State<T>>, Condvar)> }
pub struct Receiver<T> { inner: Arc<(Mutex<State<T>>, Condvar)> }

impl<T: Send> Sender<T> {
    /// Block until space is available, then enqueue the value.
    pub fn send(&self, val: T) {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap();
        while state.buf.len() >= state.capacity && !state.closed {
            state = cvar.wait(state).unwrap();
        }
        state.buf.push_back(val);
        cvar.notify_one();
    }
}

impl<T: Send> Receiver<T> {
    /// Block until a value is available; returns None when the channel is closed and drained.
    pub fn recv(&self) -> Option<T> {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap();
        loop {
            if let Some(v) = state.buf.pop_front() { cvar.notify_one(); return Some(v); }
            if state.closed { return None; }
            state = cvar.wait(state).unwrap();
        }
    }
}
