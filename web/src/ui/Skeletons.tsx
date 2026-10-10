export function Skel({ w = "100%", h = 14, style }: { w?: number | string; h?: number | string; style?: React.CSSProperties }) {
  return <span className="cur-skel" style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/** Placeholder rows for a table that is loading. Announced once to assistive technology. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ padding: "var(--cur-space-3)", display: "grid", gap: "var(--cur-space-3)" }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "grid", gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)`, gap: "var(--cur-space-4)" }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skel key={c} w={c === 0 ? "70%" : "55%"} h={16} />
          ))}
        </div>
      ))}
      <span className="cur-visually-hidden">Loading</span>
    </div>
  );
}

export function TileSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="cur-tiles" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="cur-tile">
          <Skel w="50%" h={12} />
          <Skel w="35%" h={28} />
          <Skel w="65%" h={10} />
        </div>
      ))}
    </div>
  );
}
