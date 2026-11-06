import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  defaultImagePostId, imageChipModel, imageContextLine, imagePosts, imageSetOf, imagesFinalizeHint, imageSwitcherLabel, imagesState, NO_IMAGE_POSTS_TEXT, selectedImagePostId,
} from '../../lib/contentImages';
import type { SetupDto } from '../../lib/contentVideo';
import type { ConceptDto } from '../../lib/contentTypes';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { ImagePreviewDialog, ImagesResult, PreviousImageRounds } from './ImagesResult';
import type { PreviewTarget } from './ImagesResult';
import { PostSwitcher } from './PostTextTab';
import { StudioPaneView } from './StudioPaneView';
import type { StudioPaneViewProps } from './StudioPaneView';

const noop = () => {};

/** An image set gets no writing-style retro, so the pane's retro props are fixed here. */
export type ImagesPaneViewProps = Omit<StudioPaneViewProps, 'result' | 'finalizeHint' | 'previous' | 'starting' | 'format' | 'assetKind' | 'retroError' | 'onRunRetro' | 'onOpenStyle'> & {
  onStop: (renderId: string) => void;
  /** Opens the preview from the start (tests render it). */
  initialPreview?: PreviewTarget | null;
};

/** What the agent pane shows while the shared Remotion project is set up, or why the setup failed. */
export function Starting({ setup }: { setup: SetupDto | undefined }) {
  if (setup?.status === 'running') return <><p className="m-0 font-medium">Setting up Remotion…</p><p className="m-0 text-muted-foreground">Installing the image and video project's packages, once per Building. The agent starts when it finishes.</p></>;
  if (setup?.status === 'failed') return <p role="alert" className="m-0 rounded-card border border-destructive/40 bg-destructive/10 p-2 text-left">{setup.error}</p>;
  return <p className="m-0 text-muted-foreground">Starting the agent…</p>;
}

/** One post's image set in the studio pane: the agent on the left, the gallery on the right, Finalize by the count rule. Free of the store. */
export function ImagesPaneView({ onStop, initialPreview = null, ...pane }: ImagesPaneViewProps) {
  const [preview, setPreview] = useState<PreviewTarget | null>(initialPreview);
  const { view, readOnly, busy, now } = pane;
  const hint = view ? imagesFinalizeHint(view, readOnly, READ_ONLY_TITLE) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-images-state={imagesState(view)}>
      {readOnly && <p role="status" className="m-0 shrink-0 border-b border-info/40 bg-info/10 px-4 py-2 text-sm sm:px-6">This Building is read-only. You can look at and download the images, but nothing can be rendered or finalized.</p>}
      <StudioPaneView
        {...pane}
        assetKind="image-set" retroError={null} onRunRetro={noop} onOpenStyle={noop}
        result={<ImagesResult view={view} readOnly={readOnly} busy={busy} onStop={onStop} onOpen={setPreview} now={now} />}
        finalizeHint={hint}
        previous={view ? <PreviousImageRounds view={view} onOpen={setPreview} /> : null}
        starting={<Starting setup={view?.images?.setup} />}
      />
      {preview && view && <ImagePreviewDialog view={view} target={preview} onTarget={setPreview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export interface ImagesTabProps {
  concept: ConceptDto;
  timeZone: string;
  /** Draws the pane of the selected post's image set. */
  renderPane: (conceptId: string, assetId: string) => ReactNode;
  onOverview: () => void;
  now?: number;
}

/**
 * The Images tab: a switcher over the Concept's image and carousel posts and the selected post's image-set pane. The choice is not
 * remembered; switching posts leaves the other post's session running.
 */
export function ImagesTab({ concept, timeZone, renderPane, onOverview, now }: ImagesTabProps) {
  const posts = imagePosts(concept.posts);
  // The default is taken once, when the tab opens: finalizing the shown set must not move the selection.
  const [chosen, setChosen] = useState<string | null>(() => defaultImagePostId(posts));
  const selectedId = selectedImagePostId(posts, chosen);
  useEffect(() => { if (selectedId !== chosen) setChosen(selectedId); }, [selectedId, chosen]);
  const post = posts.find((p) => p.id === selectedId);
  const asset = post && imageSetOf(post);
  if (!post || !asset) {
    return (
      <div className="m-4 grid justify-items-center gap-2 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground sm:mx-6">
        <p className="m-0">{NO_IMAGE_POSTS_TEXT}</p>
        <Button type="button" variant="outline" size="sm" onClick={onOverview}>Go to Overview</Button>
      </div>
    );
  }
  const context = imageContextLine(post);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 gap-3 border-b border-border px-4 py-3 sm:px-6" aria-label="Post context">
        <PostSwitcher tab="images" posts={posts} selectedId={selectedId} timeZone={timeZone} onSelect={setChosen} now={now} label={imageSwitcherLabel(posts.length)} chipOf={imageChipModel} />
        <p className="m-0 text-sm" data-context><b>{context.title}</b> · {context.rest}</p>
      </div>
      {renderPane(concept.id, asset.id)}
    </div>
  );
}
