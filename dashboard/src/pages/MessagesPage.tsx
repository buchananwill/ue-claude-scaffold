import { useParams, useNavigate, useSearch } from '@tanstack/react-router';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useMessages } from '../hooks/useMessages.ts';
import { useAgents } from '../hooks/useAgents.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

interface SearchParams {
  type?: string;
  highlight?: string;
  agent?: string;
}

interface MessagesContentProps {
  channel: string;
  typeFilter: string;
  agentFilter: string;
  highlightId?: number;
  setSearch: (params: SearchParams, replace?: boolean) => void;
}

function MessagesContent({ channel, typeFilter, agentFilter, highlightId, setSearch }: MessagesContentProps) {
  const navigate = useNavigate();
  const agents = useAgents();
  const { projectId } = useProject();
  const messages = useMessages(channel, typeFilter, agentFilter);

  const handleChannelChange = (c: string) => {
    navigate({ to: '/$projectId/messages/$channel', params: { projectId, channel: c }, search: { type: typeFilter || undefined, highlight: undefined, agent: agentFilter || undefined } });
  };

  const handleTypeFilterChange = (t: string) => {
    setSearch({ type: t || undefined, highlight: undefined, agent: agentFilter || undefined }, true);
  };

  const handleAgentFilterChange = (a: string) => {
    setSearch({ type: typeFilter || undefined, highlight: undefined, agent: a || undefined }, true);
  };

  const handleHighlightConsumed = () => {
    setSearch({ type: typeFilter || undefined, highlight: undefined, agent: agentFilter || undefined }, true);
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
  const navigate = useNavigate();
  const { projectId } = useProject();
  const search = useSearch({ from: '/$projectId/messages' });
  const setSearch = (params: SearchParams, replace?: boolean) => {
    navigate({ to: '/$projectId/messages', params: { projectId }, search: { type: params.type, agent: params.agent }, replace });
  };
  return (
    <MessagesContent
      channel="general"
      typeFilter={search.type ?? ''}
      agentFilter={search.agent ?? ''}
      setSearch={setSearch}
    />
  );
}

/** Wrapper for the /messages/$channel route. */
export function MessagesChannelPage() {
  const navigate = useNavigate();
  const { projectId } = useProject();
  const params = useParams({ from: '/$projectId/messages/$channel' });
  const search = useSearch({ from: '/$projectId/messages/$channel' });
  const highlightId = search.highlight ? Number(search.highlight) : undefined;
  const setSearch = (searchParams: SearchParams, replace?: boolean) => {
    navigate({ to: '/$projectId/messages/$channel', params: { projectId, channel: params.channel }, search: { type: searchParams.type, highlight: searchParams.highlight, agent: searchParams.agent }, replace });
  };
  return (
    <MessagesContent
      channel={params.channel}
      typeFilter={search.type ?? ''}
      agentFilter={search.agent ?? ''}
      highlightId={highlightId}
      setSearch={setSearch}
    />
  );
}
