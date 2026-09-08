import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '@services/api-client';

interface LogWorkoutFormProps {
  onLogged: () => void;
}

interface ImageObject {
  file: File;
  preview: string;
}

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;

function errorMessage(status: number): string {
  if (status === 429) return "You're logging too quickly — please wait a moment and try again.";
  if (status === 400) return 'Add some workout text or at least one image.';
  return 'Something went wrong. Please try again.';
}

export function LogWorkoutForm({ onLogged }: LogWorkoutFormProps) {
  const textId = useId();
  const dateId = useId();
  const imageId = useId();

  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageObject[]>([]);
  const [performedAt, setPerformedAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke any still-live object URLs when the form unmounts. A ref mirrors the
  // current images so the unmount-only effect sees the latest list without
  // re-running (and re-revoking URLs still in use) on every change. The mirror
  // is written in an effect, not during render — refs must not be touched while
  // rendering.
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => URL.revokeObjectURL(img.preview));
    };
  }, []);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const selected = Array.from(e.target.files);
    const rejections: string[] = [];
    const valid: ImageObject[] = [];

    for (const file of selected) {
      // Empty file.type happens for some real images on some browsers/OSes —
      // let those through; the parser worker sniffs the real type from the
      // bytes anyway (research.md #14). Only reject a positively-wrong type.
      if (file.type !== '' && !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        rejections.push(`${file.name}: unsupported format (JPEG, PNG, GIF, WebP only).`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejections.push(`${file.name}: larger than 10MB.`);
        continue;
      }
      valid.push({ file, preview: URL.createObjectURL(file) });
    }

    const room = Math.max(0, MAX_IMAGES - images.length);
    const toAdd = valid.slice(0, room);
    valid.slice(room).forEach((img) => URL.revokeObjectURL(img.preview));
    if (valid.length > room) {
      rejections.push(`Max ${MAX_IMAGES} images — extra files were skipped.`);
    }

    if (toAdd.length > 0) {
      setImages((prevImages) => [...prevImages, ...toAdd]);
    }
    setError(rejections.length > 0 ? rejections.join(' ') : null);

    // Reset so re-selecting the same file (e.g. after fixing size) re-triggers change.
    e.target.value = '';
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = new FormData();
      if (text.trim() !== '') body.set('text', text);
      images.forEach((imgObj) => {
        body.append('images', imgObj.file);
      });
      if (performedAt) body.set('performed_at', performedAt);

      // FormData body: no content-type header here — fetch sets the correct
      // multipart boundary itself; apps/api's POST /workouts expects
      // multipart, not JSON (T030, @fastify/multipart keyValues mode).
      const response = await apiFetch('/workouts', { method: 'POST', body });
      if (!response.ok) {
        setError(errorMessage(response.status));
        return;
      }
      setText('');
      setPerformedAt('');

      images.forEach((imgObj) => URL.revokeObjectURL(imgObj.preview));
      setImages([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      onLogged();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const nothingToSubmit = text.trim() === '' && images.length === 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label htmlFor={textId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        What did you do?
      </label>
      <textarea
        id={textId}
        rows={4}
        placeholder="Push day: bench press 80kg x8, x8, x6; overhead press 40kg x10, x10, x8"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      <label htmlFor={dateId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Date (optional — defaults to today, or a date found in the text)
      </label>
      <input
        id={dateId}
        type="date"
        value={performedAt}
        onChange={(e) => setPerformedAt(e.target.value)}
        className="w-fit rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        id={imageId}
        type="file"
        multiple
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        onChange={handleImageChange}
        ref={fileInputRef}
        className="w-fit rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      <p className="text-sm text-zinc-500 dark:text-zinc-400">Log with text, photos, or both.</p>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Accepted formats: JPEG, PNG, GIF, WebP. Max size: 10MB. Max {MAX_IMAGES} images.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || nothingToSubmit}
        className="w-fit rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {submitting ? 'Logging…' : 'Log workout'}
      </button>
    </form>
  );
}
