export const IMPORT_IDLE_POLLS_BEFORE_READINESS = 3;

export type ImportWatchVerdict = "wait" | "completed" | "preview-ready";

export interface ImportWatchObservation {
  importInProgress: boolean;
  importWasObserved: boolean;
  idlePolls: number;
  previewReady: boolean;
}

export function importWatchVerdict(observation: ImportWatchObservation): ImportWatchVerdict {
  if (observation.importInProgress) return "wait";
  if (observation.importWasObserved) return "completed";
  if (
    observation.idlePolls >= IMPORT_IDLE_POLLS_BEFORE_READINESS &&
    observation.previewReady
  ) {
    return "preview-ready";
  }
  return "wait";
}
