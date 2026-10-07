import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Subscribes to server-sent device events and refreshes affected queries. */
export function useLiveEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/api/v1/events");
    const onEvent = (ev: MessageEvent<string>) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; device_id: string };
        void qc.invalidateQueries({ queryKey: ["devices"] });
        void qc.invalidateQueries({ queryKey: ["device", e.device_id] });
      } catch {
        /* ignore malformed events */
      }
    };
    for (const t of ["device.online", "device.offline", "device.enrolled", "device.updated"]) {
      es.addEventListener(t, onEvent as EventListener);
    }
    return () => es.close();
  }, [enabled, qc]);
}
