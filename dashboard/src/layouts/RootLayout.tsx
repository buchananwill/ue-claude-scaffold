import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import {
  Center,
  Loader,
  Stack,
  Title,
  Text,
  SimpleGrid,
  Card,
  Group,
} from '@mantine/core';
import { IconFolder } from '@tabler/icons-react';
import { apiFetch } from '../api/client.ts';
import type { Project } from '../api/types.ts';

export function RootLayout() {
  // The /projects endpoint does not require x-project-id header -- it lists
  // all projects and is called before any project context is established.
  const { data: projects, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => apiFetch<Project[]>('/projects', signal),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader size="lg" />
      </Center>
    );
  }

  if (error) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Text c="red" size="lg" fw={600}>Failed to load projects</Text>
          <Text c="dimmed" size="sm">{error instanceof Error ? error.message : String(error)}</Text>
        </Stack>
      </Center>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Title order={2}>No projects configured</Title>
          <Text c="dimmed" size="sm">
            Add a project via the coordination server to get started.
          </Text>
        </Stack>
      </Center>
    );
  }

  // Single project: redirect immediately without a blank flash.
  // Cast needed because Navigate is typed against the root route's params,
  // but we are navigating to a child route (/$projectId). The router resolves
  // the params correctly at runtime.
  if (projects.length === 1) {
    const navProps = {
      to: '/$projectId',
      params: { projectId: projects[0].id },
      replace: true,
    };
    return <Navigate {...navProps as any} />;
  }

  // Multiple projects: show picker
  return (
    <Center h="100vh">
      <Stack align="center" gap="lg" maw={800} w="100%" p="xl">
        <Title order={2}>Select a project</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} w="100%">
          {projects.map((project) => (
            <Card
              key={project.id}
              withBorder
              padding="lg"
              component={Link}
              to="/$projectId"
              params={{ projectId: project.id }}
              style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}
            >
              <Group gap="sm" mb="xs">
                <IconFolder size={20} />
                <Title order={4}>{project.name}</Title>
              </Group>
              {project.engineVersion && (
                <Text size="sm" c="dimmed">Engine: {project.engineVersion}</Text>
              )}
              <Text size="xs" c="dimmed" mt="xs">ID: {project.id}</Text>
            </Card>
          ))}
        </SimpleGrid>
      </Stack>
    </Center>
  );
}
