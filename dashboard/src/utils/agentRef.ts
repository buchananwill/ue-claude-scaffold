const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatAgentRef(
  value: string | null | undefined,
  nameMap: Map<string, string>,
): string {
  if (!value) return "";
  if (!UUID_RE.test(value)) return value;
  return nameMap.get(value) ?? value;
}
