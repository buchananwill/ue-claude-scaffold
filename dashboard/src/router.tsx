import {
  createRouter,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.tsx';
import { ProjectLayout } from './layouts/ProjectLayout.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { MessagesIndexPage, MessagesChannelPage } from './pages/MessagesPage.tsx';
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

/** Clamp a string search param to a max length, returning undefined if empty or over limit. */
function boundedString(val: unknown, maxLen = 100): string | undefined {
  if (typeof val !== 'string' || !val || val.length > maxLen) return undefined;
  return val;
}

const VALID_TASK_STATUSES = new Set(['pending', 'claimed', 'in_progress', 'completed', 'failed']);
const VALID_BUILD_TYPES = new Set(['build', 'test']);
const VALID_RESULT_VALUES = new Set(['pass', 'fail']);
const VALID_MESSAGE_TYPES = new Set([
  'phase_start', 'phase_complete', 'phase_failed',
  'build_result', 'status_update', 'summary',
]);

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: OverviewPage,
  validateSearch: (search: Record<string, unknown>) => {
    // Filter each comma-separated status value against the allowlist
    const rawStatus = boundedString(search.status, 200);
    let status: string | undefined;
    if (rawStatus) {
      const valid = rawStatus.split(',').filter((s) => VALID_TASK_STATUSES.has(s));
      status = valid.length > 0 ? valid.join(',') : undefined;
    }
    return {
    status,
    agent: boundedString(search.agent),
    priority: boundedString(search.priority, 200),
    sort: boundedString(search.sort, 50),
    dir: boundedString(search.dir, 10),
    page: Number(search.page) > 0 ? Math.floor(Number(search.page)) : undefined,
  };
  },
});

const messagesIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/messages',
  component: MessagesIndexPage,
  validateSearch: (search: Record<string, unknown>) => {
    const rawType = boundedString(search.type, 50);
    const type = rawType && VALID_MESSAGE_TYPES.has(rawType) ? rawType : undefined;
    return {
      type,
      agent: boundedString(search.agent),
    };
  },
});

const messagesChannelRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/messages/$channel',
  component: MessagesChannelPage,
  validateSearch: (search: Record<string, unknown>) => {
    // Validate highlight as a positive integer; discard invalid values
    let highlight: string | undefined;
    if (typeof search.highlight === 'string' && search.highlight) {
      const n = Number(search.highlight);
      highlight = Number.isInteger(n) && n > 0 ? search.highlight : undefined;
    }
    const rawType = boundedString(search.type, 50);
    const type = rawType && VALID_MESSAGE_TYPES.has(rawType) ? rawType : undefined;
    return {
      type,
      highlight,
      agent: boundedString(search.agent),
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
  validateSearch: (search: Record<string, unknown>) => {
    const rawType = boundedString(search.type, 10);
    const rawResult = boundedString(search.result, 10);
    return {
      agent: boundedString(search.agent),
      type: rawType && VALID_BUILD_TYPES.has(rawType) ? rawType : undefined,
      result: rawResult && VALID_RESULT_VALUES.has(rawResult) ? rawResult : undefined,
    };
  },
});

const chatRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>) => ({
    room: boundedString(search.room, 64),
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
    q: boundedString(search.q, 200) ?? '',
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
