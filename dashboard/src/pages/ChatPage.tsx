import { useMemo, useState } from 'react';
import { Grid, Card, Title, Text } from '@mantine/core';
import { useSearch } from '@tanstack/react-router';
import { useRooms } from '../hooks/useRooms.ts';
import { useTeams } from '../hooks/useTeams.ts';
import { useChatMessages } from '../hooks/useChatMessages.ts';
import { ChatRoomList } from '../components/ChatRoomList.tsx';
import { ChatTimeline } from '../components/ChatTimeline.tsx';

export function ChatPage() {
  const search = useSearch({ strict: false }) as { room?: string };
  const { data: rooms } = useRooms();
  const { data: teams } = useTeams();
  // Track explicit user selection (or the URL-derived initial room) only.
  // The "first room when nothing is selected" fallback is derived below via
  // useMemo so we don't trigger setState inside an effect.
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(search.room ?? null);

  const roomList = useMemo(() => rooms ?? [], [rooms]);
  const teamList = useMemo(() => teams ?? [], [teams]);
  const teamRoomIds = useMemo(() => new Set(teamList.map((t) => t.id)), [teamList]);

  // Derive the effective active room from selection + the rooms list. When
  // the user has not explicitly selected a room, fall back to the first
  // available room. This replaces a previous useEffect that called
  // setActiveRoomId synchronously inside its body (set-state-in-effect).
  const activeRoomId = useMemo(
    () => selectedRoomId ?? roomList[0]?.id ?? null,
    [selectedRoomId, roomList],
  );

  const chat = useChatMessages(activeRoomId);

  return (
    <>
      <Title order={4} mb="md">Chat</Title>
      <Grid>
        <Grid.Col span={3}>
          <Card withBorder p="sm">
            <Title order={5} mb="xs">Rooms</Title>
            {roomList.length === 0 ? (
              <Text c="dimmed">No rooms</Text>
            ) : (
              <ChatRoomList
                rooms={roomList}
                activeRoomId={activeRoomId}
                unreadCounts={activeRoomId ? { [activeRoomId]: chat.unreadCount } : {}}
                teamRoomIds={teamRoomIds}
                onSelect={setSelectedRoomId}
              />
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={9}>
          <Card withBorder p="sm">
            {activeRoomId ? (
              <ChatTimeline
                roomId={activeRoomId}
                messages={chat.messages}
                loading={chat.loading}
                error={chat.error}
                hasOlder={chat.hasOlder}
                loadingOlder={chat.loadingOlder}
                onLoadOlder={chat.loadOlder}
                onMarkRead={chat.markRead}
                unreadCount={chat.unreadCount}
              />
            ) : (
              <Text c="dimmed" ta="center">Select a room</Text>
            )}
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
