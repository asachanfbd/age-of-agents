import type { DropZoneKey } from '../../lib/crmBoard';
import type { ProjectData } from '../../types';

export type ContactAction = DropZoneKey;

/** What every CRM tab receives. `readOnly` disables every control that changes data; history stays readable. */
export interface CrmTabProps {
  project: ProjectData;
  readOnly: boolean;
  /** Opens the contact's detail in place of the current tab. */
  onOpenContact: (contactId: number) => void;
  /** Opens the contact's detail focused on one action (marking it a customer or lost). */
  /** Tells the workspace the CRM data changed, so its KPI counts are read again. */
  onChanged: () => void;
  onOpenContactAction: (contactId: number, action: ContactAction) => void;
}
