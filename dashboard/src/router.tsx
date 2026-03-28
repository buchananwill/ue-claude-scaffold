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
import { BuildLogPage } from './pages/BuildLogPage.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { TeamsPage } from './pages/TeamsPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';

const rootRoute = createRootRoute({
  component: DashboardLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  validateSearch: (search: Record<string, unknown>) => ({
    status: typeof search.status === 'string' && search.status ? search.status : undefined,
    agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
    priority: typeof search.priority === 'string' && search.priority ? search.priority : undefined,
    sort: typeof search.sort === 'string' && search.sort ? search.sort : undefined,
    dir: typeof search.dir === 'string' && search.dir ? search.dir : undefined,
    page: Number(search.page) > 0 ? Math.floor(Number(search.page)) : undefined,
  }),
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
    highlight: typeof search.highlight === 'string' && search.highlight ? search.highlight : undefined,
    agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
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

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  component: BuildLogPage,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>) => ({
    room: typeof search.room === 'string' ? search.room : undefined,
  }),
});

const teamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/teams',
  component: TeamsPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  messagesIndexRoute,
  messagesChannelRoute,
  taskDetailRoute,
  agentDetailRoute,
  logsRoute,
  chatRoute,
  teamsRoute,
  searchRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
