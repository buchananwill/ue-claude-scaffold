import { useParams, useNavigate, useSearch } from '@tanstack/react-router';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useMessages } from '../hooks/useMessages.ts';
import { useAgents } from '../hooks/useAgents.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

interface MessagesContentProps {
  channel: string;
  typeFilter: string;
  agentFilter: string;
  highlightId?: number;
}

function MessagesContent({ channel, typeFilter, agentFilter, highlightId }: MessagesContentProps) {
  const navigate = useNavigate();
  const agents = useAgents();
  const { projectId } = useProject();
  const messages = useMessages(channel, typeFilter, agentFilter);

  const handleChannelChange = (c: string) => {
    navigate({ to: '/$projectId/messages/$channel', params: { projectId, channel: c }, search: { type: typeFilter || undefined, highlight: undefined, agent: agentFilter || undefined } });
  };

  const handleTypeFilterChange = (t: string) => {
    navigate({
      to: '/$projectId/messages/$channel',
      params: { projectId, channel },
      search: { type: t || undefined, highlight: undefined, agent: agentFilter || undefined },
      replace: true,
    });
  };

  const handleAgentFilterChange = (a: string) => {
    navigate({
      to: '/$projectId/messages/$channel',
      params: { projectId, channel },
      search: { type: typeFilter || undefined, highlight: undefined, agent: a || undefined },
      replace: true,
    });
  };

  const handleHighlightConsumed = () => {
    navigate({
      to: '/$projectId/messages/$channel',
      params: { projectId, channel },
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

/** Wrapper for the /messages index route (no channel param, defaults to 'general'). */
export function MessagesIndexPage() {
  const search = useSearch({ from: '/$projectId/messages' });
  return (
    <MessagesContent
      channel="general"
      typeFilter={search.type ?? ''}
      agentFilter={search.agent ?? ''}
    />
  );
}

/** Wrapper for the /messages/$channel route. */
export function MessagesChannelPage() {
  const params = useParams({ from: '/$projectId/messages/$channel' });
  const search = useSearch({ from: '/$projectId/messages/$channel' });
  const highlightId = search.highlight ? Number(search.highlight) : undefined;
  return (
    <MessagesContent
      channel={params.channel}
      typeFilter={search.type ?? ''}
      agentFilter={search.agent ?? ''}
      highlightId={highlightId}
    />
  );
}
