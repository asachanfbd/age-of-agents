import { useEffect, useReducer, useState } from 'react';
import { blockedReasonOf, currentDraft, READ_ONLY_NO_SESSION, shownText } from '../../lib/contentStudio';
import { DEFAULT_SPEAKING_SPEED, isScriptAsset } from '../../lib/contentScript';
import { commentBlock, commentsReducer, initialComments } from '../../lib/scriptComments';
import type { LineComments } from './DraftComments';
import { reopenBlockReason } from '../../lib/contentStats';
import { controlsDisabled } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { TaskTerminal } from '../TaskTerminal';
import { ScriptStats } from './ScriptStats';
import { StudioPaneView } from './StudioPaneView';
import type { StudioAction, StudioResultFormat } from './StudioPaneView';

/** The agent pane of one asset: opens it (starting the first round when needed) and wires its buttons to the daemon. */
export function StudioPane({ projectId, conceptId, assetId, readOnly, onOpenStyle, format }: { projectId: string; conceptId: string; assetId: string; readOnly: boolean; onOpenStyle: () => void; format?: StudioResultFormat }) {
  const view = useContentStore((s) => s.studioByAsset[assetId]) ?? null;
  const refused = useContentStore((s) => s.studioBlocked[assetId]) ?? null;
  const blockedReopen = useContentStore((s) => { const c = s.conceptsById[conceptId]; return c ? reopenBlockReason(c, { id: assetId }) : null; });
  const openStudio = useContentStore((s) => s.openStudio);
  const studioAction = useContentStore((s) => s.studioAction);
  const runRetro = useContentStore((s) => s.runRetro);
  const sendLineComment = useContentStore((s) => s.sendLineComment);
  const speed = useContentStore((s) => s.speakingSpeedByProject[projectId]) ?? DEFAULT_SPEAKING_SPEED;
  const loadSpeakingSpeed = useContentStore((s) => s.loadSpeakingSpeed);
  const saveSpeakingWpm = useContentStore((s) => s.saveSpeakingWpm);
  const clearManualSpeed = useContentStore((s) => s.clearManualSpeed);
  const assetKind = useContentStore((s) => s.conceptsById[conceptId]?.assets.find((a) => a.id === assetId)?.kind) ?? 'script';
  const [retroError, setRetroError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const savedAt = view ? currentDraft(view)?.savedAt ?? null : null;
  const [commentState, dispatch] = useReducer(commentsReducer, savedAt, initialComments);
  // A newer draft renumbers the lines: sent notes clear, unsent boxes stay with their text.
  useEffect(() => { dispatch({ type: 'draftChanged', savedAt }); }, [savedAt]);
  const script = useContentStore((s) => isScriptAsset(s.conceptsById[conceptId]?.assets, assetId));
  // Read on every open, so a speed changed in the Settings tab shows here.
  useEffect(() => { if (script) void loadSpeakingSpeed(projectId); }, [script, projectId, loadSpeakingSpeed]);
  useEffect(() => { void openStudio(projectId, conceptId, assetId, !readOnly).then((r) => setError(r.ok ? null : r.error)); }, [projectId, conceptId, assetId, readOnly, openStudio]);
  const run = async (action: StudioAction) => {
    setBusy(true);
    const result = await studioAction(projectId, conceptId, assetId, action);
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (result.ok) setConfirmOpen(false);
  };
  const sendComment = async (line: number, lineText: string, comment: string): Promise<boolean> => {
    const draftAt = commentState.draftAt;
    dispatch({ type: 'sending', line });
    const result = await sendLineComment(projectId, conceptId, assetId, { line, lineText, comment });
    dispatch(result.ok ? { type: 'sent', line, comment, at: result.sentAt, draftAt } : { type: 'failed', line, error: result.error });
    return result.ok;
  };
  // Only the plain result (the Script tab) takes line comments; the post tabs draw their text their own way.
  const comments: LineComments | undefined = format ? undefined : {
    state: commentState,
    block: commentBlock({ finalized: view?.asset.state === 'finalized', readOnly: controlsDisabled(readOnly), live: view?.session?.state === 'running' }),
    onOpen: (line, lineText) => dispatch({ type: 'open', line, lineText }),
    onEdit: (line, text) => dispatch({ type: 'edit', line, text }),
    onCancel: (line) => dispatch({ type: 'cancel', line }),
    onSend: sendComment,
  };
  // A read-only Building never starts a session; the pane only reads.
  const idle = readOnly && view !== null && view.asset.state !== 'finalized' && !view.session;
  return (
    <StudioPaneView
      view={view} format={format} blocked={idle ? READ_ONLY_NO_SESSION : blockedReasonOf(view, refused)} readOnly={controlsDisabled(readOnly)} error={error} busy={busy} confirmOpen={confirmOpen}
      onAction={(a) => void run(a)} onAskNewSession={() => setConfirmOpen(true)} onCancelNewSession={() => setConfirmOpen(false)}
      reopenBlocked={blockedReopen} comments={comments}
      stats={script ? <ScriptStats text={view ? shownText(view) : null} speed={speed} readOnly={controlsDisabled(readOnly)} onSaveSpeed={(wpm) => saveSpeakingWpm(projectId, wpm)} onUseDetected={() => clearManualSpeed(projectId)} /> : undefined}
      renderTerminal={(sessionId) => <TaskTerminal key={sessionId} taskId={sessionId} />}
      assetKind={assetKind} retroError={retroError} onOpenStyle={onOpenStyle}
      onRunRetro={() => void runRetro(projectId, assetId, assetKind).then((r) => setRetroError(r.ok ? null : r.error))}
    />
  );
}
