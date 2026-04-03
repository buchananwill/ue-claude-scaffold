/**
 * Hash an agent name to a consistent Mantine colour for visual differentiation.
 */

const MANTINE_COLORS = [
  'blue',
  'cyan',
  'grape',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'red',
  'teal',
  'violet',
  'yellow',
] as const;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function agentColor(name: string): string {
  // Empty or missing name gets a neutral color rather than a hash-based one
  if (!name) return 'gray';
  return MANTINE_COLORS[hashString(name) % MANTINE_COLORS.length];
}
