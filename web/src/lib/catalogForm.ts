/**
 * Pure helpers behind CatalogModal's agent/skill forms (web/src/ui/CatalogModal.tsx) — kept as
 * standalone functions, not component-internal logic, so they're covered by plain `node:test`
 * unit tests the same way this repo already tests other form/business logic (see executorEnv.ts,
 * taskChain.ts) rather than rendering components — this repo has no component-rendering test
 * infrastructure (no jsdom/testing-library dependency) to reach into CatalogModal.tsx itself.
 */

import type {
  Autonomy,
  CreateCatalogAgentInput,
  CreateCatalogSkillInput,
  UpdateCatalogAgentInput,
  UpdateCatalogSkillInput,
} from './serverApi';

/**
 * Turns a display name into a Catalog id candidate — lowercase letters/digits separated by single
 * dashes, matching the server's id pattern (server/src/catalog/paths.ts's `ID_PATTERN`: starts with
 * a letter/digit, then letters/digits/-/_). Used to prefill the "Id" field as the user types a name
 * in the "+ Add agent"/"+ Add skill" forms, so they don't have to invent a slug by hand — the field
 * stays a plain editable input, this is only ever a starting suggestion. Any character outside
 * a-z0-9 (including non-ASCII letters) is dropped rather than transliterated; a name with no
 * remaining alphanumeric character yields '', leaving the id field for the user to fill in by hand.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parses a skill's triggers/commands textarea into `CreateCatalogSkillInput.triggers`/
 * `UpdateCatalogSkillInput.triggers` — comma-separated or one-per-line (a form field may mix both),
 * trimmed, with empty entries dropped. Returns `undefined` (never `[]`) for no real input, so a
 * caller can spread this straight into a create/update input and omit the field entirely rather
 * than sending an explicit empty array.
 */
export function parseTriggers(text: string): string[] | undefined {
  const items = text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** The inverse of `parseTriggers` — prefills the edit form's textarea from a CatalogSkill's own `triggers` array, one per line. */
export function formatTriggers(triggers?: string[]): string {
  return (triggers ?? []).join('\n');
}

/**
 * A Catalog agent/skill id must match the server's own pattern (server/src/catalog/paths.ts's
 * `ID_PATTERN`) — a letter/digit, then any run of letters/digits/-/_. `slugify` above already only
 * ever produces strings matching this, but the "+ Add agent"/"+ Add skill" forms' id field stays
 * freely editable after being prefilled, so a submit needs its own check rather than trusting
 * whatever slugify last produced.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export function isValidCatalogId(id: string): boolean {
  return ID_PATTERN.test(id.trim());
}

/** The "+ Add agent"/edit-agent form's field values, independent of whether it's about to create or patch a Template. */
export interface CatalogAgentFormFields {
  name: string;
  description: string;
  avatar: string;
  manager: boolean;
  defaultAutonomy: Autonomy;
  body: string;
}

/**
 * Builds a CreateCatalogAgentInput from the "+ Add agent" form. `avatar`/`body` are omitted when
 * left blank (both optional server-side) rather than sent as empty strings.
 */
export function buildCreateCatalogAgentInput(id: string, fields: CatalogAgentFormFields): CreateCatalogAgentInput {
  const input: CreateCatalogAgentInput = {
    id: id.trim(),
    name: fields.name.trim(),
    description: fields.description.trim(),
    manager: fields.manager,
    defaultAutonomy: fields.defaultAutonomy,
  };
  const avatar = fields.avatar.trim();
  if (avatar) input.avatar = avatar;
  const body = fields.body.trim();
  if (body) input.body = body;
  return input;
}

/**
 * Builds an UpdateCatalogAgentInput patch from the edit-agent form. `description`/`body` are only
 * included when the user actually typed something into that field — `CatalogAgent`'s own read shape
 * never returns either (they live only in the persona file's own frontmatter/body — see
 * serverApi.ts's doc comment on `CatalogAgent`), so the edit form always starts them blank; sending
 * an empty string through unconditionally would silently overwrite real content with nothing.
 */
export function buildUpdateCatalogAgentPatch(fields: CatalogAgentFormFields): UpdateCatalogAgentInput {
  const patch: UpdateCatalogAgentInput = {
    name: fields.name.trim(),
    manager: fields.manager,
    defaultAutonomy: fields.defaultAutonomy,
  };
  const avatar = fields.avatar.trim();
  if (avatar) patch.avatar = avatar;
  const description = fields.description.trim();
  if (description) patch.description = description;
  const body = fields.body.trim();
  if (body) patch.body = body;
  return patch;
}

/** The "+ Add skill"/edit-skill form's field values. `triggersText` is the raw textarea value, parsed via `parseTriggers` by the two builders below. */
export interface CatalogSkillFormFields {
  name: string;
  description: string;
  avatar: string;
  triggersText: string;
  body: string;
}

/**
 * Builds a CreateCatalogSkillInput from the "+ Add skill" form — same "omit blank optionals" rule
 * as `buildCreateCatalogAgentInput`.
 */
export function buildCreateCatalogSkillInput(id: string, fields: CatalogSkillFormFields): CreateCatalogSkillInput {
  const input: CreateCatalogSkillInput = {
    id: id.trim(),
    name: fields.name.trim(),
    description: fields.description.trim(),
  };
  const avatar = fields.avatar.trim();
  if (avatar) input.avatar = avatar;
  const body = fields.body.trim();
  if (body) input.body = body;
  const triggers = parseTriggers(fields.triggersText);
  if (triggers) input.triggers = triggers;
  return input;
}

/**
 * Builds an UpdateCatalogSkillInput patch from the edit-skill form. Unlike the agent form,
 * `description` (and `triggers`) ARE part of `CatalogSkill`'s own read shape, so the edit form
 * starts pre-filled with the real values and this always sends them back; `body` still isn't
 * returned by read (only SKILL.md's frontmatter/description is), so it's only sent when the user
 * typed something — same "don't overwrite with blank" rule `buildUpdateCatalogAgentPatch` uses.
 */
export function buildUpdateCatalogSkillPatch(fields: CatalogSkillFormFields): UpdateCatalogSkillInput {
  const patch: UpdateCatalogSkillInput = {
    name: fields.name.trim(),
    description: fields.description.trim(),
    triggers: parseTriggers(fields.triggersText),
  };
  const avatar = fields.avatar.trim();
  if (avatar) patch.avatar = avatar;
  const body = fields.body.trim();
  if (body) patch.body = body;
  return patch;
}
