package core

import (
	"math/rand/v2"
	"time"
)

// Backoff implements exponential backoff with full jitter (PROTOCOL §7):
// sleep = rand(0, min(Max, Base * 2^n)).
type Backoff struct {
	Base, Max time.Duration
	n         int
}

// Next returns the next delay and advances the attempt counter.
func (b *Backoff) Next() time.Duration {
	ceil := b.Base << min(b.n, 30)
	if ceil > b.Max || ceil <= 0 {
		ceil = b.Max
	}
	b.n++
	return time.Duration(rand.Int64N(int64(ceil) + 1)) // #nosec G404 -- jitter, not security
}

// Reset clears the attempt counter.
func (b *Backoff) Reset() { b.n = 0 }

// jitter returns d plus a random amount in [0, extra].
func jitter(d, extra time.Duration) time.Duration {
	if extra <= 0 {
		return d
	}
	return d + time.Duration(rand.Int64N(int64(extra)+1)) // #nosec G404 -- jitter
}
