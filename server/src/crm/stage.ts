export const STAGES = ['New', 'Contacted', 'Engaged', 'Meeting set', 'Proposal'] as const;
export type Stage = (typeof STAGES)[number];
export const SEGMENTS = ['prospect', 'customer', 'lost_prospect', 'lost_customer'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type StageTrigger = 'reachout_sent' | 'response_interested' | 'meeting_created';

const TARGET: Record<StageTrigger, Stage> = { reachout_sent: 'Contacted', response_interested: 'Engaged', meeting_created: 'Meeting set' };
const rank = (s: Stage) => STAGES.indexOf(s);

/** The stage after an automatic trigger; never lower than the current one. Proposal is reachable by hand only. */
export function autoStage(current: Stage, trigger: StageTrigger): Stage {
  const target = TARGET[trigger];
  return rank(target) > rank(current) ? target : current;
}

export const isStage = (v: unknown): v is Stage => typeof v === 'string' && (STAGES as readonly string[]).includes(v);
export const isLost = (s: Segment) => s === 'lost_prospect' || s === 'lost_customer';
