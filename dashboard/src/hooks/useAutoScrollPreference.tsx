import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface AutoScrollContextValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

const STORAGE_KEY = "dashboard.autoScroll";

function readInitialEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Only the literal "off" flips the default; missing/malformed → true.
    return raw !== "off";
  } catch {
    return true;
  }
}

const AutoScrollContext = createContext<AutoScrollContextValue>({
  enabled: true,
  setEnabled: () => {},
});

export function AutoScrollProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(readInitialEnabled);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
    } catch {
      // Safari private mode and storage-disabled environments throw on setItem.
      // Failures are silent; in-memory state still updates above.
    }
  }, []);

  return (
    <AutoScrollContext.Provider value={{ enabled, setEnabled }}>
      {children}
    </AutoScrollContext.Provider>
  );
}

export function useAutoScrollPreference(): AutoScrollContextValue {
  return useContext(AutoScrollContext);
}
