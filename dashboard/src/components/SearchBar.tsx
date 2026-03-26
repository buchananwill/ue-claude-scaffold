import { useState, useRef, useEffect } from 'react';
import { Popover, TextInput, Text, Loader, Stack, Group, UnstyledButton } from '@mantine/core';
import { IconSearch, IconSubtask, IconMessage, IconRobot } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useSearch } from '../hooks/useSearch.ts';

export function SearchBar() {
  const [term, setTerm] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { data, isFetching } = useSearch(term);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const opened = term.length >= 2;
  const hasResults =
    data && (data.tasks.length > 0 || data.messages.length > 0 || data.agents.length > 0);

  return (
    <Popover opened={opened} position="bottom" width={400} shadow="md">
      <Popover.Target>
        <TextInput
          ref={inputRef}
          placeholder="Search... (/)"
          size="sm"
          w={220}
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTerm('');
              inputRef.current?.blur();
            }
          }}
          leftSection={<IconSearch size={14} />}
          rightSection={isFetching ? <Loader size="xs" /> : null}
        />
      </Popover.Target>
      <Popover.Dropdown>
        {isFetching && !data ? (
          <Loader size="sm" display="block" mx="auto" my="md" />
        ) : !hasResults ? (
          <Text size="sm" c="dimmed" ta="center">
            No results
          </Text>
        ) : (
          <Stack gap="xs">
            {data.tasks.length > 0 && (
              <div>
                <Text size="xs" fw={700} c="dimmed" mb={4}>
                  Tasks ({data.tasks.length})
                </Text>
                {data.tasks.map((task) => (
                  <UnstyledButton
                    key={`task-${task.id}`}
                    w="100%"
                    p={4}
                    style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                    onClick={() => {
                      setTerm('');
                      navigate({ to: '/tasks/$taskId', params: { taskId: String(task.id) } });
                    }}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <IconSubtask size={14} />
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" truncate>
                          {task.title}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {task.status} - #{task.id}
                        </Text>
                      </div>
                    </Group>
                  </UnstyledButton>
                ))}
              </div>
            )}
            {data.messages.length > 0 && (
              <div>
                <Text size="xs" fw={700} c="dimmed" mb={4}>
                  Messages ({data.messages.length})
                </Text>
                {data.messages.map((msg) => (
                  <UnstyledButton
                    key={`msg-${msg.id}`}
                    w="100%"
                    p={4}
                    style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                    onClick={() => {
                      setTerm('');
                      navigate({
                        to: '/messages/$channel',
                        params: { channel: msg.channel },
                        search: { type: undefined, highlight: String(msg.id), agent: undefined },
                      });
                    }}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <IconMessage size={14} />
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" truncate>
                          {msg.fromAgent} in #{msg.channel}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {msg.type}
                        </Text>
                      </div>
                    </Group>
                  </UnstyledButton>
                ))}
              </div>
            )}
            {data.agents.length > 0 && (
              <div>
                <Text size="xs" fw={700} c="dimmed" mb={4}>
                  Agents ({data.agents.length})
                </Text>
                {data.agents.map((agent) => (
                  <UnstyledButton
                    key={`agent-${agent.name}`}
                    w="100%"
                    p={4}
                    style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                    onClick={() => {
                      setTerm('');
                      navigate({ to: '/agents/$agentName', params: { agentName: agent.name } });
                    }}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <IconRobot size={14} />
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" truncate>
                          {agent.name}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {agent.status}
                        </Text>
                      </div>
                    </Group>
                  </UnstyledButton>
                ))}
              </div>
            )}
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
