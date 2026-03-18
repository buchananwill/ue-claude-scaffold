import { createContext, useContext, useState, type ReactNode } from 'react';

interface PollIntervalContextValue {
  intervalMs: number;
  setIntervalMs: (ms: number) => void;
}

const PollIntervalContext = createContext<PollIntervalContextValue>({
  intervalMs: 5000,
  setIntervalMs: () => {},
});

export function PollIntervalProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMs] = useState(5000);
  return (
    <PollIntervalContext.Provider value={{ intervalMs, setIntervalMs }}>
      {children}
    </PollIntervalContext.Provider>
  );
}

export function usePollInterval() {
  return useContext(PollIntervalContext);
}
