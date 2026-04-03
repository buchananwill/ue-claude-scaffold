import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader, Center, Text, Stack } from '@mantine/core';
import { apiFetch, setCurrentProjectId } from '../api/client.ts';
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

export function ProjectProvider({ projectId, children }: ProjectProviderProps) {
  useEffect(() => {
    setCurrentProjectId(projectId);
    return () => {
      setCurrentProjectId(null);
    };
  }, [projectId]);

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => apiFetch<Project>(`/projects/${encodeURIComponent(projectId)}`, signal),
    staleTime: 30_000,
  });

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
