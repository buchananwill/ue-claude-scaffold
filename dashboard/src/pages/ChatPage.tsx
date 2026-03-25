import { useState, useEffect } from 'react';
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
  const [activeRoomId, setActiveRoomId] = useState<string | null>(search.room ?? null);

  const roomList = rooms ?? [];
  const teamList = teams ?? [];
  const teamRoomIds = new Set(teamList.map((t) => t.id));

  // Initialize activeRoomId to first room if not set
  useEffect(() => {
    if (activeRoomId === null && roomList.length > 0) {
      setActiveRoomId(roomList[0].id);
    }
  }, [activeRoomId, roomList]);

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
                onSelect={setActiveRoomId}
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
