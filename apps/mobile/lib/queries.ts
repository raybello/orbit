import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotsResponse,
  CalendarResponse,
  ComputersResponse,
  CreateRoutineRequest,
  FilesResponse,
  Routine,
  RowsResponse,
  SendMessageResponse,
  SkillEntry,
  SkillsResponse,
} from '@orbit/contracts';
import { orbitGet, orbitPost, orbitPut } from './api';
import { currentApiBase } from './api-server';
import { useOrbitStore } from './store';

export const queryKeys = {
  bots: ['bots'] as const,
  rows: (botId: string) => ['rows', botId] as const,
  routines: (botId: string) => ['routines', botId] as const,
  health: (apiBase: string) => ['health', apiBase] as const,
  calendar: (fromIso: string, toIso: string) => ['calendar', fromIso, toIso] as const,
  files: (type: string, search: string) => ['files', type, search] as const,
  computers: ['computers'] as const,
  skills: ['skills'] as const,
};

/** GET /api/bots — the roster plus each bot's live turn state. */
export function useBotsQuery(enabled = true) {
  const setBots = useOrbitStore((s) => s.setBots);
  const setLive = useOrbitStore((s) => s.setLive);
  const query = useQuery({
    queryKey: queryKeys.bots,
    enabled,
    queryFn: async () => {
      const apiBase = await currentApiBase();
      return orbitGet<BotsResponse>(apiBase, '/api/bots');
    },
  });

  useEffect(() => {
    if (!query.data) return;
    setBots(query.data.bots);
    setLive(query.data.live);
  }, [query.data, setBots, setLive]);

  return query;
}

/** GET /api/bots/:id/rows — a whole transcript, ordered by seq. */
export function useRowsQuery(botId: string) {
  const setThread = useOrbitStore((s) => s.setThread);
  const query = useQuery({
    queryKey: queryKeys.rows(botId),
    enabled: Boolean(botId),
    queryFn: async () => {
      const apiBase = await currentApiBase();
      return orbitGet<RowsResponse>(apiBase, `/api/bots/${encodeURIComponent(botId)}/rows`);
    },
  });

  useEffect(() => {
    if (!query.data) return;
    setThread(botId, query.data.rows);
  }, [botId, query.data, setThread]);

  return query;
}

export function useRoutinesQuery(botId: string) {
  return useQuery({
    queryKey: queryKeys.routines(botId),
    enabled: Boolean(botId),
    queryFn: async () => {
      const apiBase = await currentApiBase();
      return orbitGet<{ routines: Routine[] }>(apiBase, `/api/bots/${encodeURIComponent(botId)}/routines`);
    },
  });
}

/** POST /api/bots/:id/messages — the person's turn. SSE brings the reply rows. */
export function useSendMessage(botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const apiBase = await currentApiBase();
      return orbitPost<SendMessageResponse>(apiBase, `/api/bots/${encodeURIComponent(botId)}/messages`, { text });
    },
    onSuccess: (data) => {
      useOrbitStore.getState().upsertRow(botId, data.row);
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
    },
  });
}

export type ApprovalDecision = 'allow' | 'always' | 'deny';

/** POST /api/approvals/:approvalId — answers an approval card anywhere in the transcript. */
export function useApproval(botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ approvalId, decision }: { approvalId: string; decision: ApprovalDecision }) => {
      const apiBase = await currentApiBase();
      return orbitPost<{ ok: boolean }>(apiBase, `/api/approvals/${encodeURIComponent(approvalId)}`, { decision });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rows(botId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
    },
  });
}

/** POST /api/bots/:id/cards/:seq/answer | /dismiss — answers a question card. */
export function useQuestionCard(botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ seq, answer }: { seq: number; answer?: string }) => {
      const apiBase = await currentApiBase();
      const path = `/api/bots/${encodeURIComponent(botId)}/cards/${seq}/${answer === undefined ? 'dismiss' : 'answer'}`;
      return orbitPost<{ ok: boolean }>(apiBase, path, answer === undefined ? {} : { answer });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rows(botId) });
    },
  });
}

/** POST /api/bots/:id/read — clears the unread badge for a bot. */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (botId: string) => {
      const apiBase = await currentApiBase();
      return orbitPost<{ ok: boolean }>(apiBase, `/api/bots/${encodeURIComponent(botId)}/read`, {});
    },
    onSuccess: (_data, botId) => {
      useOrbitStore.getState().markRead(botId);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
    },
  });
}

/** POST /api/bots/:id/interrupt — stop the current turn. */
export function useInterrupt(botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const apiBase = await currentApiBase();
      return orbitPost<{ ok: boolean }>(apiBase, `/api/bots/${encodeURIComponent(botId)}/interrupt`, {});
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
    },
  });
}

// ---------------------------------------------------------------- calendar

/**
 * GET /api/calendar?from=&to= — every occurrence in the window, one-time events included.
 * The month grid asks for its whole visible range, so no day can render without a mark.
 */
export function useCalendarQuery(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: queryKeys.calendar(fromIso, toIso),
    enabled: Boolean(fromIso && toIso),
    queryFn: async () => {
      const apiBase = await currentApiBase();
      const search = `?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
      const { events } = await orbitGet<CalendarResponse>(apiBase, `/api/calendar${search}`);
      return events;
    },
  });
}

/** POST /api/routines — a calendar event is a routine with calendar metadata. */
export function useCreateRoutine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: CreateRoutineRequest) => {
      const apiBase = await currentApiBase();
      return orbitPost<{ routine: Routine }>(apiBase, '/api/routines', request);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
    },
  });
}

// ---------------------------------------------------------------- files

export const FILES_PAGE_SIZE = 50;

/**
 * GET /api/files, paged. The list is one flat view over every bot's Library, attachments and
 * workspace, so a phone asks for a page at a time and appends as it scrolls.
 */
export function useFilesQuery(type: 'all' | 'library' | 'attachment' | 'workspace', search: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.files(type, search),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const apiBase = await currentApiBase();
      const params = new URLSearchParams({ page: String(pageParam), pageSize: String(FILES_PAGE_SIZE) });
      if (type !== 'all') params.set('type', type);
      if (search.trim()) params.set('search', search.trim());
      return orbitGet<FilesResponse>(apiBase, `/api/files?${params.toString()}`);
    },
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
}

// ---------------------------------------------------------------- computers

/** How often the computers list re-reads the server while it is on screen. */
export const COMPUTERS_POLL_MS = 15_000;

/** GET /api/computers — what each bot's computer is doing, polled like the web grid does. */
export function useComputersQuery() {
  return useQuery({
    queryKey: queryKeys.computers,
    queryFn: async () => {
      const apiBase = await currentApiBase();
      const { computers } = await orbitGet<ComputersResponse>(apiBase, '/api/computers');
      return computers;
    },
    // Watching a bot's screen is a live act; a stale card would hide a computer that just woke up.
    refetchInterval: COMPUTERS_POLL_MS,
  });
}

// ---------------------------------------------------------------- skills

/** GET /api/skills — the primary agent's MCP servers, and which bots have each one. */
export function useSkillsQuery() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: async () => {
      const apiBase = await currentApiBase();
      const { skills } = await orbitGet<SkillsResponse>(apiBase, '/api/skills');
      return skills;
    },
  });
}

/**
 * PUT /api/skills/:botId/:skillName — one bot's switch for one skill.
 *
 * Optimistic: the switch flips now, the write happens behind it, and a refusal puts the switch back
 * where it was. The server's answer carries the skill as it now stands, so a success adopts that.
 */
export function useSetSkillEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ botId, skillName, enabled }: { botId: string; skillName: string; enabled: boolean }) => {
      const apiBase = await currentApiBase();
      const path = `/api/skills/${encodeURIComponent(botId)}/${encodeURIComponent(skillName)}`;
      return orbitPut<{ skill: SkillEntry }>(apiBase, path, { enabled });
    },
    onMutate: async ({ botId, skillName, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.skills });
      const previous = queryClient.getQueryData<SkillEntry[]>(queryKeys.skills);
      queryClient.setQueryData<SkillEntry[]>(queryKeys.skills, (list) =>
        list?.map((skill) =>
          skill.name === skillName
            ? { ...skill, bots: skill.bots.map((b) => (b.botId === botId ? { ...b, enabled } : b)) }
            : skill,
        ),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.skills, context.previous);
    },
    onSuccess: ({ skill }) => {
      queryClient.setQueryData<SkillEntry[]>(queryKeys.skills, (list) =>
        list?.map((existing) => (existing.name === skill.name ? skill : existing)),
      );
    },
  });
}

