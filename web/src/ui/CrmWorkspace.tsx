import { useState } from 'react';
import { AlarmClock, MailCheck, Send, ShieldCheck, UserCheck, UserX, Users } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { closeContact, CRM_TABS, initialWorkspace, openContact, selectTab } from '../lib/crmWorkspace';
import type { CrmTab } from '../lib/crmWorkspace';
import { kpisForTab } from '../lib/crmKpis';
import type { ProjectData } from '../types';
import { KpiRow, PageHeader } from './design/Header';
import { CalendarTab } from './crm/CalendarTab';
import { ContactPanel } from './crm/ContactPanel';
import { CustomersTab } from './crm/CustomersTab';
import { ImportTab } from './crm/ImportTab';
import { LostTab } from './crm/LostTab';
import { MergeTab } from './crm/MergeTab';
import { NotesTab } from './crm/NotesTab';
import { ProspectsTab } from './crm/ProspectsTab';
import { ReportsTab } from './crm/ReportsTab';
import { SettingsTab } from './crm/SettingsTab';
import type { ContactAction, CrmTabProps } from './crm/types';
import { useCrmCounts } from './crm/useCrmCounts';

const TAB_VIEWS: Record<CrmTab, (props: CrmTabProps) => React.ReactElement> = {
  calendar: CalendarTab, prospects: ProspectsTab, customers: CustomersTab, lost: LostTab, import: ImportTab, merge: MergeTab, notes: NotesTab, reports: ReportsTab, settings: SettingsTab,
};

const KPI_ICONS = {
  prospects: <Users />, pendingReachouts: <Send />, awaitingApproval: <ShieldCheck />, overdueFollowups: <AlarmClock />,
  customers: <UserCheck />, sentToday: <MailCheck />, lostProspects: <UserX />, lostCustomers: <UserX />,
};

/** The CRM Building's popup body: nine pill tabs in the binding order; a contact opens in place of the tab area, with a back button. */
export function CrmWorkspace({ project, readOnly }: { project: ProjectData; readOnly: boolean }) {
  const [state, setState] = useState(initialWorkspace);
  /** The action a contact was dropped on (Customer or Lost), which its detail focuses on opening. */
  const [focusAction, setFocusAction] = useState<ContactAction | null>(null);
  const open = (id: number, action: ContactAction | null = null) => { setFocusAction(action); setState((s) => openContact(s, id)); };
  const View = TAB_VIEWS[state.tab];
  const meta = CRM_TABS.find((t) => t.key === state.tab)!;
  const [dataVersion, setDataVersion] = useState(0);
  const counts = useCrmCounts(project.id, String(dataVersion));
  const changed = () => setDataVersion((n) => n + 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="CRM workspace">
      <Tabs value={state.tab} onValueChange={(next) => setState((s) => selectTab(s, next as CrmTab))} className="shrink-0 overflow-x-auto px-4 py-3 sm:px-6">
        <TabsList>
          {CRM_TABS.map((t) => <TabsTrigger key={t.key} value={t.key} className="px-3 min-[960px]:px-4">{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {state.contactId !== null ? (
          <ContactPanel project={project} contactId={state.contactId} readOnly={readOnly} focusAction={focusAction} onChanged={changed} onClose={() => setState(closeContact)} />
        ) : (
          <div key={state.tab} className="grid gap-5 p-4 animate-in fade-in-0 sm:p-6">
            <PageHeader lines={meta.title}><KpiRow items={kpisForTab(state.tab, counts)} icons={KPI_ICONS} /></PageHeader>
            <View project={project} readOnly={readOnly} onOpenContact={(id) => open(id)} onOpenContactAction={open} onChanged={changed} />
          </div>
        )}
      </div>
    </div>
  );
}
