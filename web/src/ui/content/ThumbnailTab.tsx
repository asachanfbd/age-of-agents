import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { thumbnailAsImages, effectiveChoice, NO_THUMBNAIL_POST_TEXT, thumbnailAssetOf, thumbnailFinalizeHint, thumbnailState, THUMBNAIL_CONTEXT } from '../../lib/contentThumbnail';
import type { ThumbnailChoice } from '../../lib/contentThumbnail';
import type { ConceptDto } from '../../lib/contentTypes';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { ImagePreviewDialog, PreviousImageRounds } from './ImagesResult';
import type { PreviewTarget } from './ImagesResult';
import { Starting } from './ImagesTab';
import { StudioPaneView } from './StudioPaneView';
import type { StudioPaneViewProps } from './StudioPaneView';
import { ThumbnailResult } from './ThumbnailResult';

export type ThumbnailPaneViewProps = Omit<StudioPaneViewProps, 'result' | 'finalizeHint' | 'previous' | 'starting' | 'format' | 'assetKind' | 'retroError' | 'onRunRetro' | 'onOpenStyle'> & {
  onStop: (renderId: string) => void;
  /** Called with the picked file name when Finalize is pressed. */
  onFinalize: (file: string) => void;
  /** Opens the preview from the start (tests render it). */
  initialPreview?: PreviewTarget | null;
  /** Starts with this pick (tests render it). */
  initialChoice?: ThumbnailChoice | null;
};

const noop = () => {};

/** The Concept's thumbnail in the studio pane: the agent on the left, the variants on the right, Finalize once one is picked. Free of the store. */
export function ThumbnailPaneView({ onStop, onFinalize, onAction, initialPreview = null, initialChoice = null, ...pane }: ThumbnailPaneViewProps) {
  const [preview, setPreview] = useState<PreviewTarget | null>(initialPreview);
  const [choice, setChoice] = useState<ThumbnailChoice | null>(initialChoice);
  const { view, readOnly, busy, now } = pane;
  const chosen = effectiveChoice(choice, view);
  const hint = view ? thumbnailFinalizeHint(view, readOnly, READ_ONLY_TITLE, chosen) : null;
  const adapted = thumbnailAsImages(view);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-thumbnail-state={thumbnailState(view)}>
      {readOnly && <p role="status" className="m-0 shrink-0 border-b border-info/40 bg-info/10 px-4 py-2 text-sm sm:px-6">This Building is read-only. You can look at and download the thumbnails, but nothing can be rendered or finalized.</p>}
      <StudioPaneView
        {...pane}
        assetKind="thumbnail" retroError={null} onRunRetro={noop} onOpenStyle={noop}
        newSessionWhenFinalized
        onAction={(a) => {
          if (a === 'finalize') { if (chosen) onFinalize(chosen); return; }
          setChoice(null);
          // The server refuses a new round on a finalized asset; Reopen is what starts round N+1 there.
          onAction(a === 'session/new-round' && view?.asset.state === 'finalized' ? 'reopen' : a);
        }}
        result={<ThumbnailResult view={view} chosen={chosen} onChoose={(name) => setChoice({ round: Math.max(view?.asset.round ?? 1, 1), name })} readOnly={readOnly} busy={busy} onStop={onStop} onOpen={setPreview} now={now} />}
        finalizeHint={hint}
        previous={adapted ? <PreviousImageRounds view={adapted} onOpen={setPreview} /> : null}
        starting={<Starting setup={view?.thumbnail?.setup} />}
      />
      {preview && adapted && <ImagePreviewDialog view={adapted} target={preview} noun="thumbnail" onTarget={setPreview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export interface ThumbnailTabProps {
  concept: ConceptDto;
  /** Draws the pane of the Concept's thumbnail asset. */
  renderPane: (conceptId: string, assetId: string) => ReactNode;
  onOverview: () => void;
}

/** The Thumbnail tab: one thumbnail per Concept, shared by its video and reel posts, so there is no post switcher. */
export function ThumbnailTab({ concept, renderPane, onOverview }: ThumbnailTabProps) {
  const asset = thumbnailAssetOf(concept);
  if (!asset) {
    return (
      <div className="m-4 grid justify-items-center gap-2 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground sm:mx-6">
        <p className="m-0">{NO_THUMBNAIL_POST_TEXT}</p>
        <Button type="button" variant="outline" size="sm" onClick={onOverview}>Go to Overview</Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="m-0 shrink-0 border-b border-border px-4 py-3 text-sm sm:px-6" data-context><b>{concept.title}</b> · {THUMBNAIL_CONTEXT}</p>
      {renderPane(concept.id, asset.id)}
    </div>
  );
}
