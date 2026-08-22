'use client';

import { useCallback, useRef, useState } from 'react';
import { NusaError, toErrorCode, type ErrorCode } from '@/lib/errors';
import { terminateEngine } from '@/lib/pdf/client';
import type { ToolResult } from '@/components/tools/ResultPanel';

export type RunPhase = 'idle' | 'running' | 'done' | 'error';

export interface RunState {
  phase: RunPhase;
  /** 0–100, always determinate. Indeterminate bars hide real stalls. */
  progress: number;
  label: string;
  result: ToolResult | null;
  errorCode: ErrorCode | null;
  errorDetail: string | null;
}

export type ProgressReporter = (done: number, total: number, label?: string) => void;

const IDLE: RunState = {
  phase: 'idle',
  progress: 0,
  label: '',
  result: null,
  errorCode: null,
  errorDetail: null,
};

export function useToolRun() {
  const [state, setState] = useState<RunState>(IDLE);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      task: (report: ProgressReporter, signal: AbortSignal) => Promise<ToolResult>,
      initialLabel = 'Memproses…',
    ) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;

      setState({ ...IDLE, phase: 'running', label: initialLabel });

      const report: ProgressReporter = (done, total, label) => {
        if (abort.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          progress: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
          label: label ?? previous.label,
        }));
      };

      try {
        const result = await task(report, abort.signal);
        if (abort.signal.aborted) return;
        setState({ ...IDLE, phase: 'done', progress: 100, result });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({
          ...IDLE,
          phase: 'error',
          errorCode: toErrorCode(error),
          errorDetail: error instanceof NusaError ? (error.detail ?? null) : null,
        });
      } finally {
        if (controller.current === abort) controller.current = null;
      }
    },
    [],
  );

  /**
   * pdf-lib offers no cancellation hooks, so aborting means killing the worker
   * outright. That is what keeps the cancel button inside the one-second
   * budget in PRD §13 US10; the next run transparently spins up a new worker.
   */
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    terminateEngine();
    setState(IDLE);
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(IDLE);
  }, []);

  return { state, run, cancel, reset };
}
