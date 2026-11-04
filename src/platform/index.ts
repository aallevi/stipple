/**
 * File I/O, abstracted over Tauri and the plain browser.
 *
 * The app is developed in a browser tab (`npm run dev`) and shipped as a Tauri
 * window; keeping every filesystem touch behind this module is what lets the same
 * engine code serve both without conditionals scattered through the UI.
 */

type TauriDialog = {
  open(opts: unknown): Promise<string | string[] | null>;
  save(opts: unknown): Promise<string | null>;
};
type TauriFs = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeTextFile(path: string, data: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
};

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function dialog(): Promise<TauriDialog> {
  return (await import('@tauri-apps/plugin-dialog')) as unknown as TauriDialog;
}
async function fs(): Promise<TauriFs> {
  return (await import('@tauri-apps/plugin-fs')) as unknown as TauriFs;
}

export type PickedFile = { name: string; bytes: Uint8Array; path?: string };

/**
 * Formats the desktop shell can decode natively. In the browser this is just
 * what the web view supports; under Tauri, Rust adds TIFF, which print work
 * frequently arrives as.
 */
export async function supportedImageExtensions(): Promise<string[]> {
  const web = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  if (!isTauri()) return web;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('native_image_formats');
  } catch {
    return web;
  }
}

/**
 * Decode an image the web view cannot handle, via the Rust `image` crate.
 * Returns null when the file is one the browser can decode itself, so the
 * caller keeps using the faster built-in path.
 */
export async function decodeNative(
  path: string,
): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<{ width: number; height: number; rgba: number[] }>('decode_image', { path });
  return { width: res.width, height: res.height, rgba: new Uint8Array(res.rgba) };
}

/** Browser fallback: a transient `<input type=file>`. */
function browserPick(accept: string, multiple = false): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(
        await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
        ),
      );
    };
    // Safari will not fire `change` for a detached input.
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60_000);
  });
}

export async function openFile(
  filters: { name: string; extensions: string[] }[],
  /**
   * Overrides the browser picker's `accept`. A phone's file picker matches by
   * registered type, not by extension, so a format of our own — `.stipple` —
   * is greyed out there even when the file is right in front of you, and so is
   * the `.txt` some browsers save it as. Pass `''` to let anything be picked and
   * let the parser be the judge.
   */
  browserAccept?: string,
): Promise<PickedFile | null> {
  if (isTauri()) {
    const d = await dialog();
    const path = (await d.open({ multiple: false, filters })) as string | null;
    if (!path) return null;
    const f = await fs();
    return { name: path.split('/').pop() ?? path, bytes: await f.readFile(path), path };
  }
  const accept = browserAccept ?? filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
  const picked = await browserPick(accept);
  return picked[0] ?? null;
}

export async function saveFile(
  data: Uint8Array | string,
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (isTauri()) {
    const d = await dialog();
    const path = await d.save({ defaultPath: defaultName, filters });
    if (!path) return false;
    const f = await fs();
    if (typeof data === 'string') await f.writeTextFile(path, data);
    else await f.writeFile(path, data);
    return true;
  }

  // Browsers cannot silently write to disk; hand the file to the download flow.
  const blob = typeof data === 'string'
    ? new Blob([data], { type: mimeFor(defaultName) })
    : new Blob([data.slice().buffer as ArrayBuffer], { type: mimeFor(defaultName) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * Write several files at once.
 *
 * A separation is N plates plus a proof, and putting the native save dialog in
 * front of each one would make exporting a four-colour job seven interactions.
 * So the desktop path asks for a folder once and writes into it; the browser,
 * which has no folder to hand out, falls back to N downloads.
 */
export type MultiSave = {
  /** Null when the user cancelled, which is not the same as writing nothing. */
  dir: string | null;
  written: string[];
  failed: { name: string; error: string }[];
};

export async function saveFiles(files: { name: string; data: Uint8Array | string }[]): Promise<MultiSave> {
  const empty: MultiSave = { dir: null, written: [], failed: [] };
  if (!files.length) return { ...empty, dir: '' };

  if (isTauri()) {
    const d = await dialog();
    const dir = (await d.open({ directory: true, multiple: false, title: 'Choose a folder for the plates' })) as
      | string
      | null;
    if (!dir) return empty;

    const f = await fs();
    const out: MultiSave = { dir, written: [], failed: [] };
    const sep = dir.endsWith('/') ? '' : '/';
    for (const file of files) {
      // Ink names reach here from a colour the user chose, and the app holds a
      // filesystem scope of `**`. A name is a name, never a path.
      const name = safeName(file.name);
      try {
        const path = `${dir}${sep}${name}`;
        if (typeof file.data === 'string') await f.writeTextFile(path, file.data);
        else await f.writeFile(path, file.data);
        out.written.push(name);
      } catch (err) {
        // Keep going: a partial set with a list of what failed is far more
        // useful than stopping at the first one and saying nothing about the rest.
        out.failed.push({ name, error: (err as Error).message });
      }
    }
    return out;
  }

  // Browsers rate-limit a burst of downloads, so space them out rather than
  // firing every anchor in the same tick and having the tab drop most of them.
  const out: MultiSave = { dir: '', written: [], failed: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = safeName(file.name);
    const blob = typeof file.data === 'string'
      ? new Blob([file.data], { type: mimeFor(name) })
      : new Blob([file.data.slice().buffer as ArrayBuffer], { type: mimeFor(name) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    out.written.push(name);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_') || 'untitled';
}

function mimeFor(name: string): string {
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
