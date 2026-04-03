import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader, Center, Text, Stack } from '@mantine/core';
import { apiFetch } from '../api/client.ts';
import type { Project } from '../api/types.ts';

interface ProjectContextValue {
  projectId: string;
  projectName: string;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
}

interface ProjectProviderProps {
  projectId: string;
  children: ReactNode;
}

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function ProjectProvider({ projectId, children }: ProjectProviderProps) {
  const isValid = PROJECT_ID_PATTERN.test(projectId);

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => apiFetch<Project>(`/projects/${encodeURIComponent(projectId)}`, signal, projectId),
    staleTime: 30_000,
    enabled: isValid,
  });

  if (!isValid) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Text c="red" size="lg" fw={600}>Invalid project ID</Text>
          <Text c="dimmed" size="sm">
            Project ID &quot;{projectId}&quot; contains invalid characters.
          </Text>
        </Stack>
      </Center>
    );
  }

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader size="lg" />
      </Center>
    );
  }

  if (error || !project) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Text c="red" size="lg" fw={600}>Project not found</Text>
          <Text c="dimmed" size="sm">
            Could not load project &quot;{projectId}&quot;.
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <ProjectContext.Provider value={{ projectId: project.id, projectName: project.name }}>
      {children}
    </ProjectContext.Provider>
  );
}
