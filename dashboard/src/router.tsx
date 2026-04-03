import {
  createRouter,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.tsx';
import { ProjectLayout } from './layouts/ProjectLayout.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';
import { TaskDetailPage } from './pages/TaskDetailPage.tsx';
import { AgentDetailPage } from './pages/AgentDetailPage.tsx';
import { BuildLogPage } from './pages/BuildLogPage.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { TeamsPage } from './pages/TeamsPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';

const rootRoute = createRootRoute({
  component: RootLayout,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$projectId',
  component: ProjectLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
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
  getParentRoute: () => projectRoute,
  path: '/messages',
  component: MessagesPage,
  validateSearch: (search: Record<string, unknown>) => ({
    type: typeof search.type === 'string' && search.type ? search.type : undefined,
    agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
  }),
});

const messagesChannelRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/messages/$channel',
  component: MessagesPage,
  validateSearch: (search: Record<string, unknown>) => {
    // Validate highlight as a positive integer; discard invalid values
    let highlight: string | undefined;
    if (typeof search.highlight === 'string' && search.highlight) {
      const n = Number(search.highlight);
      highlight = Number.isInteger(n) && n > 0 ? search.highlight : undefined;
    }
    return {
      type: typeof search.type === 'string' && search.type ? search.type : undefined,
      highlight,
      agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
    };
  },
});

const taskDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/tasks/$taskId',
  component: TaskDetailPage,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents/$agentName',
  component: AgentDetailPage,
});

const logsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/logs',
  component: BuildLogPage,
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
    type: typeof search.type === 'string' && search.type ? search.type : undefined,
    result: typeof search.result === 'string' && search.result ? search.result : undefined,
  }),
});

const chatRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>) => ({
    room: typeof search.room === 'string' ? search.room : undefined,
  }),
});

const teamsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/teams',
  component: TeamsPage,
});

const searchRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/search',
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
});

const routeTree = rootRoute.addChildren([
  projectRoute.addChildren([
    overviewRoute,
    messagesIndexRoute,
    messagesChannelRoute,
    taskDetailRoute,
    agentDetailRoute,
    logsRoute,
    chatRoute,
    teamsRoute,
    searchRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
