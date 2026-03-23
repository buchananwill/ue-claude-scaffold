import { useQueryClient } from '@tanstack/react-query';
import { apiPost, apiDelete } from '../api/client.ts';
import { notifications } from '@mantine/notifications';
import type { Task } from '../api/types.ts';

interface UseTaskActionsParams {
  setConfirmingDelete: (id: number | null) => void;
  setBulkDeleteTargets: (targets: Task[]) => void;
  setConfirmingBulk: (confirming: boolean) => void;
  bulkDeleteTargets: Task[];
}

export function useTaskActions({
  setConfirmingDelete,
  setBulkDeleteTargets,
  setConfirmingBulk,
  bulkDeleteTargets,
}: UseTaskActionsParams) {
  const queryClient = useQueryClient();

  const handleRelease = async (id: number) => {
    try {
      await apiPost(`/tasks/${id}/release`);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Released', message: `Task #${id} returned to pending`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/tasks/${id}`);
      setConfirmingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Deleted', message: `Task #${id} deleted`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  const handleBulkDelete = async () => {
    const results = await Promise.allSettled(
      bulkDeleteTargets.map((t) => apiDelete(`/tasks/${t.id}`)),
    );
    setBulkDeleteTargets([]);
    setConfirmingBulk(false);
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    if (succeeded > 0) {
      notifications.show({
        title: 'Deleted',
        message: `${succeeded} task(s) deleted`,
        color: 'green',
      });
    }
    if (failed > 0) {
      notifications.show({
        title: 'Warning',
        message: `${failed} task(s) failed to delete`,
        color: 'orange',
      });
    }
  };

  return { handleRelease, handleDelete, handleBulkDelete };
}
