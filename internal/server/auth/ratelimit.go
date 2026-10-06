package auth

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is a keyed token-bucket limiter with idle-entry eviction.
type Limiter struct {
	mu      sync.Mutex
	r       rate.Limit
	burst   int
	entries map[string]*limEntry
	maxKeys int
}

type limEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewLimiter allows `burst` events immediately and then `per` events per interval.
func NewLimiter(per int, interval time.Duration, burst int) *Limiter {
	return &Limiter{r: rate.Limit(float64(per) / interval.Seconds()), burst: burst,
		entries: make(map[string]*limEntry), maxKeys: 100000}
}

// Allow reports whether an event for key may proceed now.
func (l *Limiter) Allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		if len(l.entries) >= l.maxKeys {
			l.evict(now)
		}
		e = &limEntry{lim: rate.NewLimiter(l.r, l.burst)}
		l.entries[key] = e
	}
	e.seen = now
	return e.lim.AllowN(now, 1)
}

func (l *Limiter) evict(now time.Time) {
	for k, e := range l.entries {
		if now.Sub(e.seen) > 10*time.Minute {
			delete(l.entries, k)
		}
	}
	if len(l.entries) >= l.maxKeys { // still full: drop everything (fail open on memory, not on auth)
		l.entries = make(map[string]*limEntry)
	}
}

// Sweep removes idle entries; call periodically.
func (l *Limiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.evict(time.Now())
}
