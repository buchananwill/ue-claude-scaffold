import { useParams, useNavigate, useSearch } from '@tanstack/react-router';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useMessages } from '../hooks/useMessages.ts';
import { useAgents } from '../hooks/useAgents.ts';

export function MessagesPage() {
  const params = useParams({ strict: false }) as { channel?: string };
  const channel = params.channel ?? 'general';
  const navigate = useNavigate();
  const agents = useAgents();
  const { type: typeFilter = '' } = useSearch({ strict: false }) as { type?: string };
  const messages = useMessages(channel, typeFilter);

  const handleChannelChange = (c: string) => {
    navigate({ to: '/messages/$channel', params: { channel: c }, search: { type: typeFilter || undefined } });
  };

  const handleTypeFilterChange = (t: string) => {
    navigate({
      to: '/messages/$channel',
      params: { channel },
      search: { type: t || undefined },
      replace: true,
    });
  };

  return (
    <MessagesFeed
      messages={messages.messages}
      loading={messages.loading}
      error={messages.error}
      channel={channel}
      onChannelChange={handleChannelChange}
      agents={agents.data ?? null}
      typeFilter={typeFilter ?? ''}
      onTypeFilterChange={handleTypeFilterChange}
    />
  );
}
