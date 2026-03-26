import { useParams, useNavigate, useSearch } from '@tanstack/react-router';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useMessages } from '../hooks/useMessages.ts';
import { useAgents } from '../hooks/useAgents.ts';

export function MessagesPage() {
  const params = useParams({ strict: false }) as { channel?: string };
  const channel = params.channel ?? 'general';
  const navigate = useNavigate();
  const agents = useAgents();
  const { type: typeFilter = '', highlight, agent: agentFilter = '' } = useSearch({ strict: false }) as { type?: string; highlight?: string; agent?: string };
  const messages = useMessages(channel, typeFilter, agentFilter);
  const highlightId = highlight ? Number(highlight) : undefined;

  const handleChannelChange = (c: string) => {
    navigate({ to: '/messages/$channel', params: { channel: c }, search: { type: typeFilter || undefined, highlight: undefined, agent: agentFilter || undefined } });
  };

  const handleTypeFilterChange = (t: string) => {
    navigate({
      to: '/messages/$channel',
      params: { channel },
      search: { type: t || undefined, highlight: undefined, agent: agentFilter || undefined },
      replace: true,
    });
  };

  const handleAgentFilterChange = (a: string) => {
    navigate({
      to: '/messages/$channel',
      params: { channel },
      search: { type: typeFilter || undefined, highlight: undefined, agent: a || undefined },
      replace: true,
    });
  };

  const handleHighlightConsumed = () => {
    navigate({
      to: '/messages/$channel',
      params: { channel },
      search: { type: typeFilter || undefined, highlight: undefined, agent: agentFilter || undefined },
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
      agentFilter={agentFilter ?? ''}
      onAgentFilterChange={handleAgentFilterChange}
      totalCount={messages.totalCount}
      hasOlder={messages.hasOlder}
      loadingOlder={messages.loadingOlder}
      onLoadOlder={messages.loadOlder}
      highlightMessageId={highlightId}
      onHighlightConsumed={handleHighlightConsumed}
    />
  );
}
