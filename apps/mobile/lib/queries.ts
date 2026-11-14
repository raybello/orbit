import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotsResponse, Routine, RowsResponse, SendMessageResponse } from '@orbit/contracts';
import { orbitGet, orbitPost } from './api';
import { currentApiBase } from './api-server';
import { useOrbitStore } from './store';

export const queryKeys = {
  bots: ['bots'] as const,
  rows: (botId: string) => ['rows', botId] as const,
  routines: (botId: string) => ['routines', botId] as const,
  health: (apiBase: string) => ['health', apiBase] as const,
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
