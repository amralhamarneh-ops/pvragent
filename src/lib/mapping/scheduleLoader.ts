'use client';

import { DocumentRegistry } from '@/lib/docs/registry';
import { restoreDocuments } from '@/lib/docs/caseDocsClient';
import { parseXer } from '@/lib/mapping/xerParser';
import type { ScheduleModel } from '@/lib/mapping/types';

/**
 * Connects the uploaded programme to the case workspace. It reads the case's own document registry (restoring bytes
 * from the browser cache or authorised storage, hash-checked), selects the active programme and parses the real bytes
 * with the repaired XER parser. It never falls back to sample schedules.
 */

export interface LoadedSchedule {
  docId: string;
  fileName: string;
  sha256: string;
  subrole: string;
  model: ScheduleModel;
}

export interface ScheduleLoadResult {
  /** All readable programmes, so the user can pick between baseline/current. */
  schedules: LoadedSchedule[];
  /** Programmes in the registry that could not be read, with the specific reason. */
  problems: { fileName: string; reason: string }[];
  /** Hash signature of every active programme, used to invalidate mappings when the programme changes. */
  signature: string;
}

const SUB_PRIORITY: Record<string, number> = { current: 0, baseline: 1, reference: 2, '': 3 };

export async function loadCaseSchedules(caseId: string): Promise<ScheduleLoadResult> {
  const reg = new DocumentRegistry();
  const rs = await restoreDocuments(caseId, reg);
  const problems: ScheduleLoadResult['problems'] = [];
  if (rs.error) problems.push({ fileName: '(document list)', reason: rs.error });

  const progs = reg.list().filter((d) => d.role === 'schedule');
  const schedules: LoadedSchedule[] = [];
  for (const d of progs) {
    if (!/\.xer$/i.test(d.name)) { problems.push({ fileName: d.name, reason: 'Only Primavera .xer programmes are parsed. Export the programme as XER to use it here.' }); continue; }
    const bytes = reg.bytesOf(d.id);
    if (!bytes) { problems.push({ fileName: d.name, reason: rs.needReconnect.find((n) => n.id === d.id)?.reason ?? 'The file contents are not available. Reconnect this file on the Documents screen.' }); continue; }
    try {
      const model = parseXer(new TextDecoder('utf-8').decode(bytes), d.name);
      if (model.activityCount === 0) { problems.push({ fileName: d.name, reason: model.warnings?.[0] ?? 'No activities were found in the file.' }); continue; }
      schedules.push({ docId: d.id, fileName: d.name, sha256: d.sha256, subrole: d.subrole ?? '', model });
    } catch (e) {
      problems.push({ fileName: d.name, reason: `The programme could not be parsed: ${e instanceof Error ? e.message : 'unknown error'}` });
    }
  }
  schedules.sort((a, b) => (SUB_PRIORITY[a.subrole] ?? 3) - (SUB_PRIORITY[b.subrole] ?? 3) || a.fileName.localeCompare(b.fileName));
  return { schedules, problems, signature: schedules.map((s) => `${s.docId}:${s.sha256}`).join('|') };
}
