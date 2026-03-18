import { useParams, useRouter } from '@tanstack/react-router';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useMessages } from '../hooks/useMessages.ts';
import { useAgents } from '../hooks/useAgents.ts';

export function MessagesPage() {
  const params = useParams({ strict: false }) as { channel?: string };
  const channel = params.channel ?? 'general';
  const router = useRouter();
  const agents = useAgents();
  const messages = useMessages(channel);

  const handleChannelChange = (c: string) => {
    router.navigate({ to: '/messages/$channel', params: { channel: c } });
  };

  return (
    <MessagesFeed
      messages={messages.messages}
      loading={messages.loading}
      error={messages.error}
      channel={channel}
      onChannelChange={handleChannelChange}
      agents={agents.data ?? null}
    />
  );
}
