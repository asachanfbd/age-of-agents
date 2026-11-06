import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { browserTimezone, supportedTimezones, timezoneOptions } from '../lib/contentZone';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Box, LayoutGrid, Plus, Settings } from 'lucide-react';
import { SettingsPanel } from './SettingsPanel';
import { PROJECT_CAPACITY } from '../scene/townLayout';
import { capacityState, projectSummary } from '../lib/townGroups';
import { useEffect, useState } from 'react';
import { useWorldStore } from '../store/worldStore';
import { formatISTClock } from '../lib/istTime';
import { generateCodename } from '../lib/codename';
import { FormErrorAlert } from './FormErrorAlert';
import { useErrorScope } from './useErrorScope';
import { ALL_CATEGORIES, CONTENT_STUDIO_TYPE_ID, defaultTypeId, filterTypes, selectableTypes, typeCategories, typeResultsLabel } from '../lib/buildingTypes';
import type { ServerBuildingType } from '../lib/buildingTypes';
import { withBuiltinFallback } from '../lib/newBuildingDialog';
import { SEO_TYPE_ID, validateSiteUrlInput } from '../lib/seoWorkspace';

/** Flips the overview between the 3D village and the lightweight project cards. */
function ViewModeToggle() {
  const viewMode = useWorldStore((s) => s.viewMode);
  const setViewMode = useWorldStore((s) => s.setViewMode);
  const label = viewMode === 'world' ? 'Switch to cards view (no 3D)' : 'Switch to 3D view';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setViewMode(viewMode === 'world' ? 'cards' : 'world')}
          aria-label={label}
        >
          {viewMode === 'world' ? <LayoutGrid className="size-4" /> : <Box className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ISTClock() {
  const [clock, setClock] = useState(() => formatISTClock(new Date()));

  useEffect(() => {
    const id = setInterval(() => setClock(formatISTClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="flex items-baseline gap-1.5 rounded-md bg-muted px-2.5 py-1.5 font-mono"
      aria-label={`Current time in India: ${clock} IST`}
    >
      <span className="text-sm font-semibold tabular-nums text-foreground">{clock}</span>
      <span className="text-[10px] font-bold tracking-wider text-muted-foreground">IST</span>
    </div>
  );
}

const DEV_TYPES = import.meta.env.DEV;

/** One row of the type picker: a radio-style button with the type's tint, name, one-line description and repository tag. */
function TypeOption({ type, selected, onSelect }: { type: ServerBuildingType; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 border-0 border-b border-border bg-transparent p-2.5 text-left text-foreground last:border-b-0 hover:bg-muted/60 ${selected ? 'bg-muted shadow-[inset_3px_0_0_var(--primary)]' : ''}`}
    >
      <span aria-hidden="true" className="mt-0.5 size-7 flex-none rounded-md" style={{ background: type.look.color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{type.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{type.description}</span>
      </span>
      <Badge variant="outline" className="text-[10px] text-muted-foreground">{type.repository ? 'Repository' : 'No repository'}</Badge>
    </button>
  );
}

/** Left pane: search, category chips, the scrollable type list and the result count. */
function TypePicker({ types, selectedId, onSelect }: { types: ServerBuildingType[]; selectedId: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const shown = filterTypes(types, query, category);

  return (
    <div className="grid content-start gap-2">
      <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search building types" aria-label="Search building types" />
      <div className="flex flex-wrap gap-1.5">
        {typeCategories(types).map((c) => (
          <Button key={c} type="button" size="sm" variant={c === category ? 'secondary' : 'outline'} className="h-6 rounded-full px-2.5 text-xs" aria-pressed={c === category} onClick={() => setCategory(c)}>
            {c}
          </Button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Building type" className="max-h-[320px] overflow-y-auto rounded-lg border border-border">
        {shown.map((t) => <TypeOption key={t.id} type={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} />)}
        {!shown.length && <p className="m-0 p-5 text-center text-sm text-muted-foreground">{typeResultsLabel(0, types.length)}</p>}
      </div>
      <p className="m-0 text-xs text-muted-foreground" aria-live="polite">{typeResultsLabel(shown.length, types.length)}</p>
    </div>
  );
}

/**
 * Two steps in one dialog: pick the Building's type (left), then fill in its details (right). A codename is
 * pre-filled (own local state, so re-opening always offers a fresh one) but editable. Only Software keeps a
 * repository, so only its form asks for one. See docs/architecture.md#building-types.
 */
function CreateBuildingDialog({ onCreate, onCancel }: { onCreate: (name: string, repositoryUrl: string | undefined, typeId: string, siteUrl?: string, timezone?: string) => Promise<boolean>; onCancel: () => void }) {
  const loadedTypes = useWorldStore((s) => s.buildingTypes);
  const loadBuildingTypes = useWorldStore((s) => s.loadBuildingTypes);
  const newBuildingField = useWorldStore((s) => s.newBuildingField);
  const [name, setName] = useState(() => generateCodename());
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lastError = useErrorScope('newProject');
  const types = withBuiltinFallback(selectableTypes(loadedTypes, DEV_TYPES));
  const selected = types.find((t) => t.id === (pickedId ?? defaultTypeId(types))) ?? types[0];
  const keepsRepository = selected.repository;
  const isSeo = selected.id === SEO_TYPE_ID;
  const isContentStudio = selected.id === CONTENT_STUDIO_TYPE_ID;
  const siteCheck = validateSiteUrlInput(siteUrl);
  const nameError = newBuildingField === 'name' ? lastError : null;

  useEffect(() => { if (!useWorldStore.getState().buildingTypes.length) void loadBuildingTypes(); }, [loadBuildingTypes]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-[860px]">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if ((!trimmed && !isSeo) || pending || (isSeo && !siteCheck.ok)) return;
            setPending(true);
            try { await onCreate(trimmed, keepsRepository ? repositoryUrl.trim() || undefined : undefined, selected.id, isSeo ? siteUrl.trim() : undefined, isContentStudio ? timezone : undefined); } finally { setPending(false); }
          }}
        >
          <DialogHeader>
            <DialogTitle>New Building</DialogTitle>
            <DialogDescription>Step 1: choose what kind of Building to place. Step 2: fill in its details.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 md:grid-cols-[5fr_6fr]">
            <TypePicker types={types} selectedId={selected.id} onSelect={setPickedId} />
            <div className="grid content-start gap-4 rounded-lg border border-border p-3.5">
              <div className="grid gap-1">
                <h3 className="m-0 text-base font-semibold">{selected.name}</h3>
                <p className="m-0 text-sm text-muted-foreground">{selected.description}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">{selected.category}</Badge>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">{keepsRepository ? 'Uses a Git repository' : 'No repository: no branches or pull requests'}</Badge>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="project-name">{keepsRepository ? 'Project name' : 'Building name'}</Label>
                <Input
                  id="project-name"
                  disabled={pending}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label={keepsRepository ? 'Project name' : 'Building name'}
                  aria-invalid={nameError ? true : undefined}
                  autoFocus
                />
                {nameError && <p role="alert" className="m-0 text-xs text-destructive">{nameError}</p>}
              </div>
              {isSeo && (
                <div className="grid gap-2">
                  <Label htmlFor="seo-site-url">Site address</Label>
                  <Input id="seo-site-url" value={siteUrl} disabled={pending} onChange={(event) => setSiteUrl(event.target.value)} aria-label="Site address" placeholder="https://example.com" aria-invalid={siteUrl && !siteCheck.ok ? true : undefined} />
                  {siteUrl && !siteCheck.ok && <p role="alert" className="m-0 text-xs text-destructive">{siteCheck.error}</p>}
                  {siteCheck.ok && <p className="m-0 text-xs text-muted-foreground">Will track {siteCheck.normalized}. The name above is optional; it defaults to the site's host.</p>}
                </div>
              )}
              {isContentStudio && (
                <div className="grid gap-2">
                  <Label htmlFor="content-timezone">Time zone</Label>
                  <NativeSelect id="content-timezone" wrapperClassName="w-full" value={timezone} disabled={pending} onChange={(event) => setTimezone(event.target.value)} aria-label="Time zone">
                    {timezoneOptions(browserTimezone(), supportedTimezones()).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                  </NativeSelect>
                  <p className="m-0 text-xs text-muted-foreground">Post dates and the calendar use this zone. Your browser's zone is preselected.</p>
                </div>
              )}
              {keepsRepository ? (
                <div className="grid gap-2">
                  <Label htmlFor="project-repository">GitHub repository <span className="text-muted-foreground">(optional)</span></Label>
                  <Input
                    id="project-repository"
                    value={repositoryUrl}
                    onChange={(event) => setRepositoryUrl(event.target.value)}
                    aria-label="GitHub repository URL (optional)"
                    placeholder="https://github.com/owner/repository"
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">Leave blank to start a new project. Connected repositories use your terminal's Git authentication; completed agent work is committed and pushed to the selected branch.</p>
                </div>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">This type has no repository, so there is nothing to connect. Its work is kept in the Building's own working folder.</p>
              )}
            </div>
          </div>
          {!nameError && <FormErrorAlert message={lastError} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || (isSeo ? !siteCheck.ok : !name.trim())}>
              {pending ? (keepsRepository && repositoryUrl ? 'Cloning…' : 'Creating…') : 'Create Building'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TopBar() {
  const addProject = useWorldStore((s) => s.addProject);

  const projects = useWorldStore((s) => s.projects);
  const selectBuilding = useWorldStore((s) => s.selectBuilding);
  const openWorkspace = useWorldStore((s) => s.openWorkspace);
  const closeCatalog = useWorldStore((s) => s.closeCatalog);
  const openSettings = useWorldStore((s) => s.openSettings);
  const capacity = capacityState(projects.length);
  const atCapacity = capacity === 'full';
  const [isNaming, setIsNaming] = useState(false);

  /** The brand logo: back out of whichever is open — a project's full workspace or the Catalog modal. */
  const goToOverview = () => {
    selectBuilding(null);
    openWorkspace(null);
    closeCatalog();
  };

  return (
    <>
      <header
        className="absolute inset-x-6 top-4 z-20 overflow-hidden glass rounded-card max-sm:inset-x-3 max-sm:top-3"
        aria-label="Age of Agents workspace"
      >
        <div className="flex flex-wrap items-center gap-6 px-5 py-3.5 max-sm:gap-3 max-sm:p-3">
          <button
            className="flex flex-shrink-0 items-center gap-3 border-0 bg-transparent p-0 text-left text-foreground"
            type="button"
            onClick={goToOverview}
            aria-label="Age of Agents overview"
          >
            <span
              aria-hidden="true"
              className="grid h-10 w-10 place-items-center rounded-full bg-primary text-primary-foreground"
            >
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="m3 12 5-4 5 4v10H3V12Zm10-6 5-4 5 4v16H13V6Z" />
                <path d="M7 16h2m8-8h2m-2 5h2m-2 5h2M1 22h24" />
              </svg>
            </span>
            <span className="text-base font-semibold tracking-tight">
              Age of Agents
              <span className="mt-1 block text-[11px] font-normal tracking-wide text-muted-foreground">Agent workspace</span>
            </span>
          </button>
          <div className="hidden items-center gap-2.5 whitespace-nowrap text-xs text-muted-foreground min-[960px]:flex">
            <span aria-hidden="true" className="mr-2 text-2xl font-light text-muted-foreground">/</span>
            <span
              aria-hidden="true"
              className="grid h-[25px] w-[25px] place-items-center rounded-full bg-secondary text-[11px] font-bold text-secondary-foreground"
            >
              P
            </span>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2.5">
                <span>Personal workspace</span>
                <Badge variant="outline" className="text-[10px]">Local</Badge>
              </div>
              <span className="text-[11px]">
                <strong className="font-semibold text-foreground">{projectSummary(projects.length)}</strong>
                {capacity !== 'ok' && <span className="ml-2 text-warning-foreground">{capacity === 'full' ? 'Map full' : `Nearly full (${projects.length} of ${PROJECT_CAPACITY} plots)`}</span>}
              </span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3 max-sm:w-full max-sm:justify-between">
            <ISTClock />
            <ViewModeToggle />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={() => openSettings()} aria-label="Open settings">
                  <Settings className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
            <Button type="button" disabled={atCapacity} onClick={() => setIsNaming(true)}>
              <Plus className="size-4" />
              {atCapacity ? 'Map full' : 'New Building'}
            </Button>
          </div>
        </div>
      </header>

      {isNaming && (
        <CreateBuildingDialog
          onCreate={async (name, repositoryUrl, typeId, siteUrl, timezone) => {
            const created = await addProject(name, repositoryUrl, typeId, siteUrl, timezone);
            if (created) setIsNaming(false);
            return created;
          }}
          onCancel={() => setIsNaming(false)}
        />
      )}
      <SettingsPanel />

      <div className="pointer-events-none absolute left-[34px] top-[116px] max-sm:hidden">
        <span className="text-[10px] font-bold tracking-[0.2em] text-primary">AGENT NETWORK</span>
        <div className="font-mono text-[clamp(20px,2.1vw,30px)] leading-tight text-foreground">
          Systems connected.<br />Ideas in motion.
        </div>
      </div>
    </>
  );
}
