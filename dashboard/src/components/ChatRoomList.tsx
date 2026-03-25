import { Stack, NavLink, Text, Badge } from '@mantine/core';
import type { Room } from '../api/types.ts';

interface ChatRoomListProps {
  rooms: Room[];
  activeRoomId: string | null;
  unreadCounts: Record<string, number>;
  teamRoomIds: Set<string>;
  onSelect: (roomId: string) => void;
}

export function ChatRoomList({ rooms, activeRoomId, unreadCounts, teamRoomIds, onSelect }: ChatRoomListProps) {
  const directRooms = rooms.filter((r) => r.type === 'direct');
  const teamRooms = rooms.filter((r) => r.type === 'group' && teamRoomIds.has(r.id));
  const groupRooms = rooms.filter((r) => r.type === 'group' && !teamRoomIds.has(r.id));

  const renderRoom = (room: Room) => {
    const count = unreadCounts[room.id] ?? 0;
    return (
      <NavLink
        key={room.id}
        label={room.name}
        active={room.id === activeRoomId}
        onClick={() => onSelect(room.id)}
        rightSection={
          count > 0 ? (
            <Badge size="xs" circle color="red">
              {count}
            </Badge>
          ) : undefined
        }
      />
    );
  };

  return (
    <Stack gap={4}>
      {directRooms.length > 0 && (
        <>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Direct</Text>
          {directRooms.map(renderRoom)}
        </>
      )}
      {teamRooms.length > 0 && (
        <>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Team</Text>
          {teamRooms.map(renderRoom)}
        </>
      )}
      {groupRooms.length > 0 && (
        <>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Group</Text>
          {groupRooms.map(renderRoom)}
        </>
      )}
    </Stack>
  );
}
