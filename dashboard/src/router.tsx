import {
  createRouter,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { DashboardLayout } from './layouts/DashboardLayout.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';
import { TaskDetailPage } from './pages/TaskDetailPage.tsx';
import { AgentDetailPage } from './pages/AgentDetailPage.tsx';

const rootRoute = createRootRoute({
  component: DashboardLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
});

const messagesIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: MessagesPage,
});

const messagesChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages/$channel',
  component: MessagesPage,
  validateSearch: (search: Record<string, unknown>) => ({
    type: typeof search.type === 'string' && search.type ? search.type : undefined,
  }),
});

const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$taskId',
  component: TaskDetailPage,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/$agentName',
  component: AgentDetailPage,
});

// Future routes (shape only — implement later)
// /logs → BuildLogPage

const routeTree = rootRoute.addChildren([
  overviewRoute,
  messagesIndexRoute,
  messagesChannelRoute,
  taskDetailRoute,
  agentDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
