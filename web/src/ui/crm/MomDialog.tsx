import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import { errorText } from './crmHooks';

export const MOM_SAVED_MESSAGE = 'Notes saved. Find them in the Notes (MOM) tab.';

/** The "Add notes" dialog for a call or meeting item: saves the notes as a MOM (minutes of meeting) attached to the item. */
export function MomDialog({ projectId, item, contactLabel, readOnly, onSaved, onError, onClose }: {
  projectId: string; item: { id: number; title: string }; contactLabel: string; readOnly: boolean;
  onSaved: (message: string) => void; onError: (message: string) => void; onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const disabled = crmControlsDisabled(readOnly);
  const save = async () => {
    try { await crmApi.createMom(projectId, { followupId: item.id, notes }); onSaved(MOM_SAVED_MESSAGE); }
    catch (e) { onError(errorText(e)); }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" aria-label="Add notes">
        <DialogHeader><DialogTitle>Notes for {item.title}</DialogTitle><DialogDescription>{contactLabel} · attached to this item and shown on the contact's timeline.</DialogDescription></DialogHeader>
        <Textarea aria-label="Notes" className="min-h-32" value={notes} disabled={disabled} onChange={(e) => setNotes(e.target.value)} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void save()}>Save notes</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
