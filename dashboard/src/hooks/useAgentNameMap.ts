import { useMemo } from "react";
import { useAgents } from "./useAgents.js";

export function useAgentNameMap(): Map<string, string> {
  const { data } = useAgents();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const a of data ?? []) {
      if (a.id) map.set(a.id, a.name);
    }
    return map;
  }, [data]);
}
