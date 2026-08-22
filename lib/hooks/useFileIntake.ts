'use client';

import { useCallback, useState } from 'react';
import { suggestToolForFile, type ErrorCode } from '@/lib/errors';
import { useQueue } from '@/lib/store/queue';
import type { ToolDefinition } from '@/lib/tools';

export interface Rejection {
  fileName: string;
  code: ErrorCode;
  /** "mungkin maksud Anda Word to PDF?" — PRD §13 US1. */
  suggestion?: { href: string; label: string };
}

function accepts(tool: ToolDefinition, file: File): boolean {
  const patterns = tool.accept.split(',').map((value) => value.trim().toLowerCase());
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  return patterns.some((pattern) =>
    pattern.startsWith('.') ? name.endsWith(pattern) : type === pattern,
  );
}

/**
 * Validates incoming files against the tool, pushes the good ones into the
 * queue, and keeps the rejects around with an explanation. Rejecting silently
 * — or lumping everything into one generic error — is what makes these tools
 * feel broken when a user drags in the wrong thing.
 */
export function useFileIntake(tool: ToolDefinition) {
  const addFiles = useQueue((s) => s.addFiles);
  const [rejections, setRejections] = useState<Rejection[]>([]);

  const onFiles = useCallback(
    (incoming: File[]) => {
      const valid: File[] = [];
      const rejected: Rejection[] = [];

      for (const file of incoming) {
        if (accepts(tool, file)) {
          valid.push(file);
          continue;
        }

        const suggested = suggestToolForFile(file.name);
        rejected.push({
          fileName: file.name,
          code: 'E_UNSUPPORTED_TYPE',
          suggestion:
            suggested && suggested.slug !== tool.slug
              ? { href: `/${suggested.slug}`, label: suggested.label }
              : undefined,
        });
      }

      const outcome = addFiles(valid);

      setRejections([
        ...rejected,
        ...outcome.rejected.map((item) => ({ fileName: item.name, code: item.code })),
      ]);
    },
    [tool, addFiles],
  );

  const dismissRejections = useCallback(() => setRejections([]), []);

  return { onFiles, rejections, dismissRejections };
}
