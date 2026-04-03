import { useQueryClient } from '@tanstack/react-query';
import { apiPost, apiDelete } from '../api/client.ts';
import { notifications } from '@mantine/notifications';
import { toErrorMessage } from '../utils/toErrorMessage.ts';
import type { Task } from '../api/types.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

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
  const { projectId } = useProject();

  const handleRelease = async (id: number) => {
    if (!(Number.isInteger(id) && id > 0)) return;
    try {
      await apiPost(`/tasks/${id}/release`, undefined, projectId);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Released', message: `Task #${id} returned to pending`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: toErrorMessage(err), color: 'red' });
    }
  };

  const handleDelete = async (id: number) => {
    if (!(Number.isInteger(id) && id > 0)) return;
    try {
      await apiDelete(`/tasks/${id}`, projectId);
      setConfirmingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Deleted', message: `Task #${id} deleted`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: toErrorMessage(err), color: 'red' });
    }
  };

  const handleBulkDelete = async () => {
    const results = await Promise.allSettled(
      bulkDeleteTargets.map((t) => apiDelete(`/tasks/${t.id}`, projectId)),
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
