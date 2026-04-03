import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { SearchResults } from '../api/types.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useSearch(term: string) {
  const { projectId } = useProject();
  const [debouncedTerm, setDebouncedTerm] = useState(term);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedTerm(term), 300);
    return () => clearTimeout(id);
  }, [term]);

  return useQuery({
    queryKey: ['search', debouncedTerm, projectId],
    queryFn: ({ signal }) =>
      apiFetch<SearchResults>('/search?q=' + encodeURIComponent(debouncedTerm), signal, projectId),
    enabled: debouncedTerm.length >= 2,
    staleTime: 10000,
  });
}
