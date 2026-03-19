import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { SearchResults } from '../api/types.ts';

export function useSearch(term: string) {
  const [debouncedTerm, setDebouncedTerm] = useState(term);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedTerm(term), 300);
    return () => clearTimeout(id);
  }, [term]);

  return useQuery({
    queryKey: ['search', debouncedTerm],
    queryFn: ({ signal }) =>
      apiFetch<SearchResults>('/search?q=' + encodeURIComponent(debouncedTerm), signal),
    enabled: debouncedTerm.length >= 2,
    staleTime: 10000,
  });
}
