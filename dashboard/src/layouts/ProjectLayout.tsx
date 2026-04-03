import { useParams } from '@tanstack/react-router';
import { ProjectProvider } from '../contexts/ProjectContext.tsx';
import { DashboardLayout } from './DashboardLayout.tsx';

export function ProjectLayout() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return (
    <ProjectProvider projectId={projectId}>
      <DashboardLayout />
    </ProjectProvider>
  );
}
