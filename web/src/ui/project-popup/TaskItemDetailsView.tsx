import type { ReactNode } from 'react';
import type { BadgeProps } from '@/components/ui/badge';
import type { PlanItemData } from '../../types';
import { DetailHeader } from './DetailHeader';
import type { DetailEditing } from './DetailHeader';
import type { TaskActions } from './useTaskActions';

/**
 * The details of a task with nothing run yet (or one marked done by hand): the same header as a
 * WorkflowRun's detail, with Start / Edit icons while those apply (`onStart`, `editing`). A Planning task
 * (`fill`) opens with its description expanded over the whole view.
 */
export function TaskItemDetailsView({
  item,
  status,
  alerts,
  actions,
  editing,
  onStart,
  fill,
  onBack,
}: {
  item: PlanItemData;
  status: { label: string; variant: BadgeProps['variant'] };
  /** The Tasks tab's action outcome alerts (`ActionAlerts`), so an action's failure shows here too. */
  alerts: ReactNode;
  actions: TaskActions;
  editing?: DetailEditing;
  onStart?: () => void;
  fill?: boolean;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
      <DetailHeader item={item} run={null} status={status} actions={actions} alerts={alerts} editing={editing} onStart={onStart} fill={fill} onBack={onBack} />
    </div>
  );
}
