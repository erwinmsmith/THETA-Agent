export interface HumanProgress {
  current: number;
  total: number;
  label: string;
  percent?: number;
}

export interface HumanSection {
  title?: string;
  lines: string[];
}

export interface HumanNextAction {
  id: string;
  label: string;
  description: string;
  command?: string;
  recommended?: boolean;
  destructive?: boolean;
}

export interface HumanFacingResponse {
  kind: string;
  title: string;
  summary: string;
  progress?: HumanProgress;
  sections?: HumanSection[];
  warnings?: string[];
  nextActions: HumanNextAction[];
  technicalDetails?: unknown;
}

export type HumanOutputMode = 'human' | 'verbose' | 'json' | 'debug';
