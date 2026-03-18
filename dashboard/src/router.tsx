import {
  createRouter,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { DashboardLayout } from './layouts/DashboardLayout.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';

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
});

// Future routes (shape only — implement later)
// /tasks/$taskId  → TaskDetailPage
// /agents/$agentName → AgentDetailPage
// /logs → BuildLogPage

const routeTree = rootRoute.addChildren([
  overviewRoute,
  messagesIndexRoute,
  messagesChannelRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
