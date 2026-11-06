import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { canUseDetected, footerSourceLabel, initialSpeedField, scriptStats, speedFieldStep, wordsLabel } from '../../lib/contentScript';
import type { SpeakingSpeedDto, SpeedFieldEvent } from '../../lib/contentScript';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import type { ContentResult } from '../../store/contentStore';

export interface ScriptStatsProps {
  /** The shown script (the current draft, or the finalized text); null with no draft. */
  text: string | null;
  speed: SpeakingSpeedDto;
  readOnly: boolean;
  onSaveSpeed: (wpm: number) => Promise<ContentResult>;
  /** Clears the owner's value so the average of the recordings applies. */
  onUseDetected: () => Promise<ContentResult>;
}

/** The speed field: saves on Enter or blur, Esc puts the saved value back. A failed or refused save keeps the typed text. */
function SpeedField({ speed, readOnly, onSave, onUseDetected }: { speed: SpeakingSpeedDto; readOnly: boolean; onSave: ScriptStatsProps['onSaveSpeed']; onUseDetected: () => void }) {
  const id = useId();
  const [field, setField] = useState(() => initialSpeedField(speed.speakingWpm));
  // Read and written synchronously, so the blur that follows Enter sees the save already in flight.
  const current = useRef(field);
  const step = (event: SpeedFieldEvent) => {
    const next = speedFieldStep(current.current, event);
    current.current = next.state;
    setField(next.state);
    const wpm = next.save;
    if (wpm !== null) void onSave(wpm).then((r) => step(r.ok ? { type: 'saved', saved: wpm } : { type: 'failed', error: r.error }));
  };
  // A speed saved elsewhere (the Settings tab, a reload) replaces the shown one unless a save is in flight.
  useEffect(() => {
    if (current.current.saving) return;
    current.current = initialSpeedField(speed.speakingWpm);
    setField(current.current);
  }, [speed.speakingWpm]);
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <label htmlFor={id}>Speed</label>
        <Input
          id={id} inputMode="numeric" value={field.text} disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}
          aria-invalid={field.error ? true : undefined} aria-describedby={`${id}-source${field.error ? ` ${id}-error` : ''}`}
          className="h-7 w-16 px-2 text-xs tabular-nums aria-[invalid=true]:border-destructive"
          onChange={(e) => step({ type: 'edit', text: e.target.value })}
          onBlur={() => step({ type: 'commit', saved: speed.speakingWpm })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { step({ type: 'commit', saved: speed.speakingWpm }); e.currentTarget.blur(); }
            if (e.key === 'Escape') { step({ type: 'revert', saved: speed.speakingWpm }); e.currentTarget.blur(); }
          }}
        />
        <span>wpm</span>
        <span id={`${id}-source`} data-speed-source={speed.source}>· {footerSourceLabel(speed)}</span>
        {canUseDetected(speed) && !readOnly && (
          <button type="button" className="text-xs underline underline-offset-2 hover:text-foreground" onClick={onUseDetected}>Use detected speed</button>
        )}
      </span>
      {field.error && <p id={`${id}-error`} role="alert" className="m-0 basis-full text-xs text-destructive">{field.error}</p>}
    </>
  );
}

/** The Script footer's word count, estimated length and speaking speed. Counted only when the text or the speed changes. */
export function ScriptStats({ text, speed, readOnly, onSaveSpeed, onUseDetected }: ScriptStatsProps) {
  const stats = useMemo(() => scriptStats(text, speed.speakingWpm), [text, speed.speakingWpm]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Script stats">
      <span className="font-medium tabular-nums text-foreground" data-words>{wordsLabel(stats.words)}</span>
      <span>Length <span className="font-medium tabular-nums text-foreground" data-length>{stats.length}</span></span>
      <SpeedField speed={speed} readOnly={readOnly} onSave={onSaveSpeed} onUseDetected={() => void onUseDetected()} />
    </div>
  );
}
