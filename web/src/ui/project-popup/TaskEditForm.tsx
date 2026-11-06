import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAutoResizeTextarea } from '../chat/useAutoResizeTextarea';

/**
 * The task title/description editor — inline on a board card, and in place of the specification in a
 * not-started task's details. Holds its own draft; the parent remounts it (`key`) for another task.
 */
export function TaskEditForm({
  title: initialTitle,
  description: initialDescription,
  onSave,
  onCancel,
}: {
  title: string;
  description: string;
  onSave: (patch: { title: string; description: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  // Compact while you work on the title; grows to show the whole description once focused.
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const descriptionRef = useAutoResizeTextarea(description, descriptionFocused ? 320 : 72);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = title.trim();
        if (trimmed) onSave({ title: trimmed, description: description.trim() });
      }}
    >
      <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Task title" autoFocus />
      <Textarea
        ref={descriptionRef}
        rows={2}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onFocus={() => setDescriptionFocused(true)}
        onBlur={() => setDescriptionFocused(false)}
        placeholder="Description"
        aria-label="Task description"
        className="min-h-9 resize-none [field-sizing:fixed]"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!title.trim()}>Save</Button>
      </div>
    </form>
  );
}
