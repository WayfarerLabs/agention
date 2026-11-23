import { useCallback, useSyncExternalStore } from "react";

// useMedia says whether the page matches a media query, such as the color
// scheme the device prefers, and follows it as it changes.
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
