import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.js';
import { ProjectLayout } from './layouts/ProjectLayout.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { MessagesIndexPage, MessagesChannelPage } from './pages/MessagesPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { AgentDetailPage } from './pages/AgentDetailPage.js';
import { BuildLogPage } from './pages/BuildLogPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { TeamsPage } from './pages/TeamsPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { TASK_STATUSES } from './constants/task-statuses.js';
import { VALID_SORT_COLUMNS } from './hooks/useTaskFilters.js';

const rootRoute = createRootRoute({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
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

const VALID_AGENT_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_TASK_STATUSES = new Set<string>(TASK_STATUSES);
const VALID_DIR_VALUES = new Set(['asc', 'desc']);
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
    const rawSort = boundedString(search.sort, 50);
    const rawDir = boundedString(search.dir, 10);
    // Validate agent: each comma-separated segment must match safe identifier pattern or __unassigned__
    const rawAgent = boundedString(search.agent, 200);
    let agent: string | undefined;
    if (rawAgent) {
      const valid = rawAgent.split(',').filter((s) => s === '__unassigned__' || VALID_AGENT_SEGMENT.test(s));
      agent = valid.length > 0 ? valid.join(',') : undefined;
    }
    // Validate priority: each comma-separated segment must be an integer
    const rawPriority = boundedString(search.priority, 200);
    let priority: string | undefined;
    if (rawPriority) {
      const valid = rawPriority.split(',').filter(Boolean).map(Number).filter(Number.isInteger);
      priority = valid.length > 0 ? valid.join(',') : undefined;
    }
    return {
      status,
      agent,
      priority,
      sort: rawSort && VALID_SORT_COLUMNS.has(rawSort) ? rawSort : undefined,
      dir: rawDir && VALID_DIR_VALUES.has(rawDir) ? rawDir : undefined,
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
  indexRoute,
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
